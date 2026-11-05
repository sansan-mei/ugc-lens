import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { createSession } from '../../src/chat/session.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'
import { toolSandbox } from '../helpers/tool_context.ts'

test('对话自动导入、分批评分，最后一轮读取实际汇总并解释', async () => {
  const sandbox = toolSandbox()
  const data = makeDataset([makeItem({ id: 'a', text: '真好' }), makeItem({ id: 'b', text: '真差' })])
  const scoring = createFakeModel([{ tool_calls: [{ name: 'submit_sentiment', args: { scores: [
    { id: 'a', score: 0.8, reason: '好评' }, { id: 'b', score: -0.8, reason: '差评' },
  ] } }] }])
  const model = createFakeModel([
    { tool_calls: [{ name: 'load_dataset', args: { file: 'data.json' } }] },
    { tool_calls: [{ name: 'analyze_sentiment' }] },
    { content: '已评估 2 条，正负面各 50%，整体均值 0。[a] [b]' },
  ])
  const session = createSession({ cwd: sandbox.dir, model, analysisModel: scoring, load: async () => data })
  try {
    const result = await session.ask('分析 data.json 情感分布')
    assert.match(result.answer, /各 50%/)
    const last = model.requests.at(-1)!
    const returned = JSON.parse(last.messages.filter((m) => m.role === 'tool').at(-1)!.content!)
    assert.equal(returned.summary.proportions.positive, 0.5)
    assert.equal(returned.summary.mean_score, 0)
    assert.equal(last.messages.filter((m) => m.role === 'user').length, 1)
    assert.equal(last.messages.filter((m) => m.role === 'system').length, 1)
    assert.deepEqual(scoring.requests[0]!.messages.map((m) => m.role), ['system', 'user'])
    assert.deepEqual(model.requests[0]!.messages[0], last.messages[0])
  } finally { await session.close(); sandbox.cleanup() }
})
