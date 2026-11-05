import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { ASK_SYSTEM_PROMPT, askDataset } from '../../src/ask/index.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const dataset = makeDataset([
  makeItem({ id: 'c1', text: '标题党，退钱！', likes: 10 }),
  makeItem({ id: 'c2', text: '又是标题党', likes: 5 }),
  makeItem({ id: 'c3', text: '讲得很好', likes: 1 }),
])

test('askDataset：模型通过数据工具查询，回答里的引用分为存在和不存在', async () => {
  const model = createFakeModel([
    { tool_calls: [{ name: 'get_dataset_stats' }, { name: 'search_feedback', args: { query: '标题党' } }] },
    { content: '主要在吐槽标题党 [c1] [c2]，另有 [c404]。' },
  ])
  const result = await askDataset({ model, datasets: [dataset], question: '大家在吐槽什么？' })

  assert.equal(result.run.stop_reason, 'completed')
  assert.deepEqual(result.citations, { valid: ['c1', 'c2'], invalid: ['c404'] })
  assert.deepEqual(model.requests[0]?.tools.map((t) => t.function.name), ['list_datasets', 'get_dataset_stats', 'search_feedback', 'get_feedback', 'analyze_sentiment', 'get_analysis_coverage', 'get_content_timeline', 'analyze_topics', 'analyze_business'])
  assert.deepEqual(model.requests[0]?.messages, [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    { role: 'user', content: '大家在吐槽什么？' },
  ])
  // 模型看到的搜索结果里有被引用的 ID
  const searchResult = model.requests[1]?.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? ''
  assert.match(searchResult, /^\[c1\][\s\S]*\[c2\]/)
  assert.doesNotMatch(searchResult, /\[c3\]/)
})

test('askDataset：传入上一轮的消息即可连续追问，system prompt 只有一条', async () => {
  const first = await askDataset({ model: createFakeModel([{ content: '吐槽标题党 [c1]' }]), datasets: [dataset], question: '吐槽什么？' })
  const model = createFakeModel([{ content: '有一条正面评价 [c3]' }])
  const second = await askDataset({ model, datasets: [dataset], question: '有好评吗？', history: first.run.messages })

  const sent = model.requests[0]?.messages ?? []
  assert.deepEqual(sent.slice(0, first.run.messages.length), first.run.messages)
  assert.equal(sent.filter((m) => m.role === 'system').length, 1)
  assert.deepEqual(sent.at(-1), { role: 'user', content: '有好评吗？' })
  assert.deepEqual(second.citations.valid, ['c3'])
})

test('askDataset：默认最多 12 步，可以覆盖', async () => {
  const model = createFakeModel((request) =>
    request.toolChoice === 'none' ? { content: '证据不足' } : { tool_calls: [{ name: 'list_datasets' }] },
  )
  const result = await askDataset({ model, datasets: [dataset], question: 'q', limits: { maxSteps: 2 } })
  assert.equal(result.run.stop_reason, 'max_steps')
  assert.equal(result.run.steps.filter((s) => !s.final).length, 2)
  assert.deepEqual(result.citations, { valid: [], invalid: [] })
})
