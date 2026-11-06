import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTask } from '../../src/agent/usage.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { synthesizeInsights } from '../../src/pipeline/insights.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'
import type { Theme } from '../../src/pipeline/merge.ts'

const dataset = makeDataset([makeItem({ id: 'a', text: '内容好看', likes: 100 }), makeItem({ id: 'b', text: '品牌没记住' }), makeItem({ id: 'c', text: '没有提交综合的内容' })])
const themes: Theme[] = [{ title: '内容与广告', direction: '主要观点', support: 5, sources: [], children: [], refs: [{ id: 'a' }, { id: 'b' }] }]
const insight = { finding: '内容接受与品牌记忆需要分别验证', evidence: [{ point: '内容接受', refs: [{ id: 'a', quote: '内容好看' }] }], counterevidence: [{ point: '品牌记忆边界', refs: [{ id: 'b', quote: '品牌没记住' }] }], boundary: '两条评论只是线索', meaning: '分别衡量两项目标', verify: '补充品牌回忆调查' }

test('综合读取原文；保留低赞分歧证据并记录用量', async () => {
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_insights', args: { insights: [insight] } }] }])
  const result = await synthesizeInsights({ model, dataset, themes })
  assert.equal(result.insights.length, 1)
  assert.deepEqual(result.insights[0]?.counterevidence, insight.counterevidence)
  assert.match(String(model.requests[0]?.messages[1]?.content), /品牌没记住/)
  assert.ok(result.usage)
})

test('未知ID、未提交的ID、改写引文或丢失一侧均拒绝整项，不能留下无证据结论', async () => {
  for (const ref of [{ id: 'missing', quote: '品牌没记住' }, { id: 'c', quote: '没有提交综合的内容' }, { id: 'b', quote: '认可广告' }]) {
    const model = createFakeModel([{ tool_calls: [{ name: 'submit_insights', args: { insights: [{ ...insight, counterevidence: [{ point: '反例', refs: [ref] }] }] } }] }])
    assert.equal((await synthesizeInsights({ model, dataset, themes })).insights.length, 0)
  }
})

test('失败或截断时明确降级，不把旧主题当作已核对结论', async () => {
  const fake = createFakeModel([{ content: '不完整' }])
  const model: AgentModel = { async complete(request) { return { ...await fake.complete(request), finishReason: 'length' } } }
  const result = await synthesizeInsights({ model, dataset, themes })
  assert.equal(result.insights.length, 0)
  assert.ok(result.error)
})


test('预算耗尽不发起综合调用；取消向上传递', async () => {
  const model = createFakeModel([{ content: '消耗预算' }])
  await withTask(async () => {
    const { completeTracked } = await import('../../src/agent/usage.ts')
    await completeTracked(model, { messages: [{ role: 'user', content: '消耗预算' }], tools: [], toolChoice: 'auto', signal: new AbortController().signal }, 'test')
    const result = await synthesizeInsights({ model, dataset, themes })
    assert.equal(result.called, false)
    assert.match(result.error!, /预算/)
    assert.equal(model.requests.length, 1)
  }, 1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(synthesizeInsights({ model, dataset, themes, signal: controller.signal }), { name: 'AbortError' })
})

test('综合可见字幕类型、内容归属、直接父回复语境与原文摘句附近内容', async () => {
  const data = makeDataset([
    makeItem({ id: 'p', text: '老板人好' }),
    makeItem({ id: 'reply', kind: 'reply', parent_id: 'p', text: '我反对。'.repeat(600) + '价格仍然劝退' }),
  ], { contents: [{ id: 'BV1', platform: 'bilibili', transcript: [{ start_sec: 5, end_sec: 10, text: '视频实际字幕' }] }] })
  const candidates: Theme[] = [{ ...themes[0]!, refs: [{ id: 'reply', quote: '价格仍然劝退' }, { id: 'BV1:transcript:1' }] }]
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_insights', args: { insights: [] } }] }])
  await synthesizeInsights({ model, dataset: data, themes: candidates })
  const payload = JSON.parse(String(model.requests[0]?.messages[1]?.content)) as { evidence: Array<{ id: string; kind: string; text: string; parent_context?: { id: string; text: string } }> }
  const reply = payload.evidence.find((r) => r.id === 'reply')!
  assert.match(reply.text, /价格仍然劝退/)
  assert.equal(reply.parent_context?.text, '老板人好')
  assert.equal(payload.evidence.find((r) => r.id === 'BV1:transcript:1')?.kind, 'transcript')
})
