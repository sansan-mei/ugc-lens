import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { withTask, currentTask } from '../../src/agent/usage.ts'
import { createFakeModel, type FakeReply } from '../../src/agent/fake_model.ts'
import type { AgentModelRequest } from '../../src/agent/model.ts'
import type { Insight } from '../../src/pipeline/insights.ts'
import { collectRecheckCandidates, recheckInsights } from '../../src/pipeline/recheck.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const dataset = makeDataset([
  makeItem({ id: 'a1', text: '价格太贵了，不值这个钱', likes: 50 }),
  makeItem({ id: 'a2', text: '价格贵但是质量好，我觉得值', likes: 40 }),
  makeItem({ id: 'a3', text: '这个价格其实很便宜，比别家低', likes: 30 }),
  makeItem({ id: 'a4', text: '价格合理', likes: 20 }),
  makeItem({ id: 'a5', kind: 'reply', parent_id: 'a1', text: '价格贵是因为原材料涨了', likes: 10 }),
  makeItem({ id: 'd1', kind: 'danmaku', text: '价格好贵', video_time_sec: 10 }),
  makeItem({ id: 'z1', text: '主播声音好听', likes: 99 }),
])

function insight(partial: Partial<Insight> = {}): Insight {
  return {
    finding: '观众普遍认为价格偏高',
    evidence: [{ point: '直接抱怨价格', refs: [{ id: 'a1', quote: '价格太贵了' }] }],
    counterevidence: [],
    boundary: '仅基于部分评论',
    meaning: '可能影响购买',
    verify: '看退款数据',
    recheck_queries: ['价格'],
    ...partial,
  }
}

function recheckModel(reply: (request: AgentModelRequest) => FakeReply) {
  return createFakeModel((request) => reply(request))
}

describe('collectRecheckCandidates', () => {
  test('按关键词检索评论和回复，排除已引用 ID 和弹幕，按点赞排序并限制条数', () => {
    const [first] = collectRecheckCandidates(dataset, [insight()], { perInsight: 3 })
    assert.deepEqual(first!.candidates.map((c) => c.id), ['a2', 'a3', 'a4'])
    assert.equal(first!.matched, 5)
    assert.ok(!first!.candidates.some((c) => c.id === 'd1' || c.id === 'a1'))
  })

  test('严格匹配足够时不放宽；不足时补充任一词匹配的结果，严格命中排在前面', () => {
    const [strict] = collectRecheckCandidates(dataset, [insight({ recheck_queries: ['价格'] })])
    assert.equal(strict!.relaxed, false)
    const [few] = collectRecheckCandidates(dataset, [insight({ recheck_queries: ['价格 便宜'] })])
    assert.equal(few!.relaxed, true)
    assert.deepEqual(few!.candidates.map((c) => c.id), ['a3', 'a2', 'a4', 'a5'])
    const [none] = collectRecheckCandidates(dataset, [insight({ recheck_queries: ['便宜 已退款'] })])
    assert.equal(none!.relaxed, true)
    assert.deepEqual(none!.candidates.map((c) => c.id), ['a3'])
  })

  test('没有关键词或没有命中时候选为空', () => {
    const [none, miss] = collectRecheckCandidates(dataset, [insight({ recheck_queries: [] }), insight({ recheck_queries: ['不存在的词'] })])
    assert.equal(none!.candidates.length, 0)
    assert.equal(miss!.candidates.length, 0)
  })
})

describe('recheckInsights', () => {
  test('逐条核对候选：保留反例和限定，拒绝伪造 ID、伪造摘句和越界编号；用量计入任务账本', async () => {
    const model = recheckModel(() => ({ tool_calls: [{ name: 'submit_recheck', args: { results: [
      { finding: 1, id: 'a3', verdict: 'contradicts', quote: '这个价格其实很便宜', note: '认为便宜' },
      { finding: 1, id: 'a2', verdict: 'qualifies', quote: '质量好，我觉得值', note: '贵但值' },
      { finding: 1, id: 'a4', verdict: 'contradicts', quote: '价格非常合理便宜', note: '摘句伪造' },
      { finding: 1, id: 'z1', verdict: 'contradicts', quote: '主播声音好听', note: '不在候选中' },
      { finding: 2, id: 'a3', verdict: 'contradicts', quote: '这个价格其实很便宜', note: '编号越界' },
      { finding: 1, id: 'a5', verdict: 'supports' },
    ] } }] }))
    await withTask(async () => {
      const result = await recheckInsights({ model, dataset, insights: [insight()] })
      assert.equal(result.called, true)
      const [item] = result.items
      assert.equal(item!.status, 'checked')
      assert.deepEqual(item!.contradicts.map((r) => r.id), ['a3'])
      assert.deepEqual(item!.qualifies.map((r) => r.id), ['a2'])
      assert.equal(item!.supports, 1)
      assert.equal(item!.rejected, 2)
      assert.equal(result.unassigned, 1)
      assert.equal(item!.candidates, 4)
      assert.deepEqual(item!.queries, ['价格'])
      assert.equal(currentTask()!.snapshot().calls.filter((c) => c.stage === 'recheck').length, 1)
    })
    const request = model.requests[0]!
    assert.equal(request.tools[0]!.function.name, 'submit_recheck')
    const payload = JSON.parse(String(request.messages[1]!.content)) as { findings: { candidates: { id: string }[] }[] }
    assert.ok(!payload.findings[0]!.candidates.some((c) => c.id === 'a1'))
  })

  test('没有候选时不调用模型', async () => {
    const model = recheckModel(() => { throw new Error('不应调用') })
    const result = await recheckInsights({ model, dataset, insights: [insight({ recheck_queries: undefined })] })
    assert.equal(result.called, false)
    assert.equal(model.requests.length, 0)
    assert.equal(result.items[0]!.status, 'no_candidates')
  })

  test('模型失败或未提交时返回错误，不影响原发现', async () => {
    const original = insight()
    const snapshot = structuredClone(original)
    const model = recheckModel(() => ({ content: '我不想调用工具' }))
    const result = await recheckInsights({ model, dataset, insights: [original] })
    assert.equal(result.called, true)
    assert.match(String(result.error), /未提交/)
    assert.equal(result.items[0]!.status, 'failed')
    assert.deepEqual(original, snapshot)
  })
})
