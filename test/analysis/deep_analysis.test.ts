import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import type { AgentModelRequest } from '../../src/agent/model.ts'
import { classifyTopics } from '../../src/analysis/topics.ts'
import { analyzeBusiness } from '../../src/analysis/business.ts'
import { contentTimeline } from '../../src/analysis/content_timeline.ts'
import { analysisCoverage } from '../../src/analysis/coverage.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const dataset = makeDataset([makeItem({ id: 'a', text: '价格太贵，操作太难' }), makeItem({ id: 'b', text: '价格太贵，操作太难' }), makeItem({ id: 'c', text: '无意见' }), makeItem({ id: 'd', text: '这？' })])
const topics = [{ id: 'price', title: '价格', criteria: '认为价格高' }, { id: 'usability', title: '易用性', criteria: '操作困难' }]
const submit = (rows: unknown[]) => ({ tool_calls: [{ name: 'submit_evaluations', args: { rows } }] })
const itemsOf = (request: AgentModelRequest) => JSON.parse(request.messages.at(-1)!.content!) as { id: string; text: string }[]

test('主题逐条多标签精确计数，重复正文不丢弃，未归类和不确定保留', async () => {
  const model = createFakeModel((request) => submit(itemsOf(request).map(({ id }) => ({ id, topic_ids: ['a', 'b'].includes(id) ? ['price', 'usability'] : [], uncertain: id === 'd', reason: '按纳入标准' }))))
  const result = await classifyTopics({ dataset, model, topics, batchSize: 2 })
  assert.equal(result.calls, 2)
  assert.ok(model.requests.every((r) => r.messages.length === 2))
  assert.deepEqual(result.topics.map((t) => t.count), [2, 2])
  assert.equal(result.topics[0]!.share, 2 / dataset.items.length)
  assert.equal(result.unclassified, 1)
  assert.equal(result.uncertain, 1)
  assert.equal(result.coverage, 1)
})

test('主题未知标签、重复 ID、重复标签、遗漏不能变成有效分母', async () => {
  for (const rows of [
    [{ id: 'a', topic_ids: ['unknown'], uncertain: false, reason: '' }],
    [{ id: 'a', topic_ids: [], uncertain: false, reason: '' }, { id: 'a', topic_ids: [], uncertain: false, reason: '' }],
    [{ id: 'a', topic_ids: ['price', 'price'], uncertain: false, reason: '' }],
    [{ id: 'a', topic_ids: ['price'], uncertain: true, reason: '' }],
  ]) {
    const result = await classifyTopics({ dataset, model: createFakeModel([submit(rows)]), topics })
    assert.equal(result.counts.failed, dataset.items.length)
    assert.equal(result.topics[0]!.share, null)
  }
  const omitted = await classifyTopics({ dataset, model: createFakeModel([submit([{ id: 'a', topic_ids: ['price'], uncertain: false, reason: '' }])]), topics })
  assert.equal(omitted.counts.processed, 1)
  assert.equal(omitted.topics[0]!.share, 1)
  assert.equal(omitted.counts.failed, 3)
})

test('逐条归类预算停在批次边界，取消和错误保留真实覆盖率', async () => {
  const model = createFakeModel((r) => submit(itemsOf(r).map(({ id }) => ({ id, topic_ids: [], uncertain: false, reason: '' }))))
  const result = await classifyTopics({ dataset, model, topics, batchSize: 1, tokenBudget: 1 })
  assert.equal(result.calls, 1)
  assert.equal(result.counts.skipped, 3)
  assert.equal(result.stop_reason, 'token_budget')
  await assert.rejects(classifyTopics({ dataset, model, topics, signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('商业机会必须有逐条原文摘句；无信号不凑数，背景不能替代证据', async () => {
  const opportunity = { title: '降低上手难度', problem: '操作困难', quote: '操作太难', hypothesis: '引导可能降低流失', validation: '邀请用户试用引导并记录完成率', effort: '开发半天', priority: 'medium' }
  const model = createFakeModel((r) => submit(itemsOf(r).map(({ id }) => ({ id, opportunities: id === 'a' ? [opportunity] : [] }))))
  const result = await analyzeBusiness({ dataset, model, background: { skills: '会编程' } })
  assert.equal(result.opportunities.length, 1)
  assert.deepEqual(result.opportunities[0]!.refs, ['a'])
  assert.match(model.requests[0]!.messages[0]!.content!, /不是证据/)
  const bad = await analyzeBusiness({ dataset, model: createFakeModel([submit([{ id: 'a', opportunities: [{ ...opportunity, quote: '编造的引文' }] }])]) })
  assert.equal(bad.opportunities.length, 0)
  assert.equal(bad.counts.failed, dataset.items.length)
})

test('时间轴按视频隔离、保留真实引用，不因无字幕而编造内容', () => {
  const data = makeDataset([
    makeItem({ id: 'd1', kind: 'danmaku', content_id: 'v1', text: '太好了', video_time_sec: 10 }),
    makeItem({ id: 'd2', kind: 'danmaku', content_id: 'v2', text: '不同视频', video_time_sec: 10 }),
    makeItem({ id: 'd3', kind: 'danmaku', content_id: 'v1', text: '很晚', video_time_sec: 1e9 }),
  ], { contents: [{ id: 'v1', platform: 'bilibili', transcript: [{ start_sec: 9, end_sec: 12, text: '原始字幕' }] }, { id: 'v2', platform: 'bilibili' }] })
  const result = contentTimeline(data)
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.rows[0]!.feedback.map((i) => i.id), ['d1'])
  assert.equal(result.rows[0]!.transcript[0]!.text, '原始字幕')
  assert.equal(result.rows[0]!.transcript[0]!.ref, 'v1:transcript:1')
  assert.deepEqual(result.rows[2]!.transcript, [])
  assert.equal(contentTimeline(data, { contentId: 'v2' }).total, 1)
  assert.equal(contentTimeline(data, { limit: 1 }).next_offset, 1)
})

test('覆盖记录在每个类型上守恒，导入跳过与重复信号独立于模型处理', () => {
  const plan = planChunks(dataset, { dropLowInfo: false })
  const rows = plan.chunks.map((c) => ({ chunk: c.index, status: 'failed' as const, findings: [], dropped: { invalid_finding: 0, unknown_ref: 0, bad_quote: 0, no_valid_refs: 0, over_limit: 0 } }))
  const ledger = analysisCoverage(dataset, plan, rows)
  for (const r of ledger.kinds) assert.equal(r.imported, r.processed + r.failed + r.skipped + r.selected + r.not_selected)
  assert.equal(ledger.kinds[0]!.duplicate_texts, 1)
  assert.equal(ledger.kinds[0]!.processed, 0)
  assert.equal(analysisCoverage(dataset).stage, 'import')
})
