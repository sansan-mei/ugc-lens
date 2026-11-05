import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import type { AgentModelRequest } from '../../src/agent/model.ts'
import { createLlmModel } from '../../src/agent/llm_model.ts'
import { createChatClient } from '../../src/llm/client.ts'
import { analyzeSentiment } from '../../src/sentiment/index.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'
import { startMockServer, sendJson } from '../helpers/mock_server.ts'

const dataset = makeDataset([
  makeItem({ id: 'a', text: '很好', likes: 999 }),
  makeItem({ id: 'b', text: '很差', kind: 'reply' }),
  makeItem({ id: 'c', text: '中性', kind: 'danmaku' }),
  makeItem({ id: 'd', text: '指代不明' }),
])
const scores: Record<string, number | null> = { a: 0.8, b: -0.6, c: 0, d: null }
function reply(request: Pick<AgentModelRequest, 'messages'>) {
  const rows = JSON.parse(request.messages.at(-1)!.content!) as { id: string }[]
  return { tool_calls: [{ name: 'submit_sentiment', args: { scores: rows.map(({ id }) => ({ id, score: scores[id] ?? null, reason: '依据原文' })) } }] }
}

test('分批逐条评分后等权汇总，保留无法判断，批间不带历史', async () => {
  const model = createFakeModel(reply)
  const result = await analyzeSentiment({ dataset, model, batchSize: 2 })
  assert.equal(model.requests.length, 2)
  for (const request of model.requests) assert.deepEqual(request.messages.map((m) => m.role), ['system', 'user'])
  assert.equal(model.requests[0]!.messages[0]!.content, model.requests[1]!.messages[0]!.content)
  assert.deepEqual(result.records.map((r) => r.id), dataset.items.map((r) => r.id))
  assert.deepEqual(result.summary.counts, { positive: 1, neutral: 1, negative: 1, uncertain: 1, failed: 0, skipped: 0 })
  assert.ok(Math.abs(result.summary.mean_score! - (0.8 - 0.6) / 3) < 1e-10)
  assert.equal(result.summary.proportions.positive, 1 / 4)
  assert.equal(result.by_kind.reply!.counts.negative, 1)
  assert.equal(result.stop_reason, 'completed')
})

test('筛选与指定对象送入评分提示，不虚构不存在的记录', async () => {
  const model = createFakeModel(reply)
  const result = await analyzeSentiment({ dataset, model, kinds: ['reply'], contentId: 'BV1', target: '产品价格' })
  assert.deepEqual(result.records.map((r) => r.id), ['b'])
  assert.match(model.requests[0]!.messages[0]!.content!, /产品价格/)
  assert.match(model.requests[0]!.messages[0]!.content!, /情感不是支持/)
  const empty = await analyzeSentiment({ dataset, model, contentId: 'missing' })
  assert.equal(empty.calls, 0)
  assert.equal(empty.summary.mean_score, null)
  assert.equal(empty.summary.proportions.positive, null)
})

test('遗漏不会归为中性；重复、批外 ID、非法数值和非法 JSON 使该批失败', async () => {
  const omitted = await analyzeSentiment({ dataset, model: createFakeModel([{ tool_calls: [{ name: 'submit_sentiment', args: { scores: [{ id: 'a', score: 0.7, reason: '好' }] } }] }]) })
  assert.equal(omitted.summary.evaluated, 1)
  assert.equal(omitted.summary.counts.failed, 3)
  for (const rows of [
    [{ id: 'a', score: 0, reason: '' }, { id: 'a', score: 0, reason: '' }],
    [{ id: 'unknown', score: 0, reason: '' }],
    [{ id: 'a', score: 2, reason: '' }],
  ]) {
    const result = await analyzeSentiment({ dataset, model: createFakeModel([{ tool_calls: [{ name: 'submit_sentiment', args: { scores: rows } }] }]) })
    assert.equal(result.summary.counts.failed, dataset.items.length)
    assert.equal(result.summary.counts.neutral, 0)
    assert.equal(result.stop_reason, 'partial')
  }
  const invalid = await analyzeSentiment({ dataset, model: createFakeModel([{ tool_calls: [{ name: 'submit_sentiment', raw_arguments: '{' }] }]) })
  assert.equal(invalid.summary.counts.failed, dataset.items.length)
})

test('预算耗尽停在批边界，未处理不进入已评分分母', async () => {
  const result = await analyzeSentiment({ dataset, model: createFakeModel(reply), batchSize: 1, tokenBudget: 1 })
  assert.equal(result.calls, 1)
  assert.equal(result.summary.evaluated, 1)
  assert.equal(result.summary.counts.skipped, 3)
  assert.equal(result.summary.coverage, 1 / 4)
  assert.equal(result.stop_reason, 'token_budget')
})

test('超长原文不截断评分，批字符数和条数均受限', async () => {
  const data = makeDataset([makeItem({ id: 'long', text: '长'.repeat(500) }), ...dataset.items])
  const model = createFakeModel(reply)
  const result = await analyzeSentiment({ dataset: data, model, maxBatchChars: 100, batchSize: 2 })
  assert.equal(result.records[0]!.status, 'skipped')
  for (const request of model.requests) {
    const rows = JSON.parse(request.messages[1]!.content!) as unknown[]
    assert.ok(rows.length <= 2)
    assert.ok(rows.reduce<number>((n, row) => n + JSON.stringify(row).length, 0) <= 100)
  }
  assert.equal(result.summary.evaluated, dataset.items.length)
})

test('空数据不调用模型，取消向上传递', async () => {
  const model = createFakeModel(reply)
  const result = await analyzeSentiment({ dataset: makeDataset([]), model })
  assert.equal(result.calls, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(analyzeSentiment({ dataset, model, signal: controller.signal }), { name: 'AbortError' })
  const during = new AbortController()
  await assert.rejects(analyzeSentiment({ dataset, signal: during.signal, model: { complete: async () => { during.abort(); throw during.signal.reason } } }), { name: 'AbortError' })
})

test('输出被截断或调用失败时不会计入有效分数，后续批次继续', async () => {
  const fake = createFakeModel(reply)
  let call = 0
  const result = await analyzeSentiment({ dataset, batchSize: 1, model: { complete: async (request) => {
    call++
    if (call === 1) throw new Error('模拟失败')
    const response = await fake.complete(request)
    return call === 2 ? { ...response, finishReason: 'length' } : response
  } } })
  assert.equal(result.summary.counts.failed, 2)
  assert.equal(result.summary.evaluated, 2)
  assert.equal(result.calls, dataset.items.length)
})

test('真实 fetch 路径支持拒绝强制 tool_choice 后退回 auto', async () => {
  const server = await startMockServer((request, response) => {
    const body = request.body as { tool_choice: unknown; messages: AgentModelRequest['messages'] }
    if (body.tool_choice !== 'auto') { sendJson(response, 400, { error: 'tool_choice unsupported' }); return }
    const fake = reply(body)
    sendJson(response, 200, { model: 'mock', choices: [{ message: { role: 'assistant', content: null, tool_calls: fake.tool_calls.map((t) => ({ id: 'call', type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  })
  try {
    const client = createChatClient({ provider: 'custom', baseUrl: server.baseUrl, model: 'mock', apiKey: '', timeoutMs: 1000 }, { retry: { maxRetries: 0 } })
    const result = await analyzeSentiment({ dataset, model: createLlmModel(client), batchSize: 2 })
    assert.equal(result.summary.evaluated, dataset.items.length)
    assert.equal(result.calls, server.requests.length)
    assert.equal(result.usage.input_tokens, 20)
  } finally { await server.close() }
})
