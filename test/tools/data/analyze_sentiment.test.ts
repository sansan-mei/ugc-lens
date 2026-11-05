import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createFakeModel } from '../../../src/agent/fake_model.ts'
import { createDatasetStore } from '../../../src/dataset/store.ts'
import { createDataTools } from '../../../src/tools/data/index.ts'
import { makeDataset, makeItem } from '../../helpers/dataset.ts'
import { toolSandbox } from '../../helpers/tool_context.ts'

test('情感工具保存完整逐条结果，对外返回紧凑汇总和可核对 ID', async () => {
  const sandbox = toolSandbox()
  const dataset = makeDataset([makeItem({ id: 'a', text: '真棒' })])
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_sentiment', args: { scores: [{ id: 'a', score: 0.9, reason: '称赞' }] } }] }])
  try {
    const tool = createDataTools(createDatasetStore([dataset]), { sentimentModel: model }).find((t) => t.name === 'analyze_sentiment')!
    const result = JSON.parse(await tool.execute({}, sandbox.ctx))
    assert.equal(result.records, undefined)
    assert.equal(result.summary.counts.positive, 1)
    assert.equal(result.examples[0].id, 'a')
    assert.ok(result.path.startsWith(sandbox.dir))
    const saved = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(saved.records[0].score, 0.9)
    await assert.rejects(tool.execute({ token_budget: 0 }, sandbox.ctx), /参数/)
  } finally { sandbox.cleanup() }
})
