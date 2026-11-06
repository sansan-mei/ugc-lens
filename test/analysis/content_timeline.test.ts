import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentTimeline } from '../../src/analysis/content_timeline.ts'
import { findCitations } from '../../src/dataset/query.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import { summarizeChunks } from '../../src/pipeline/summarize.ts'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { makeDataset } from '../helpers/dataset.ts'

test('仅字幕也有时间轴，字幕进入模型且生成的引用可校验', async () => {
  const dataset = makeDataset([], { contents: [{ id: 'BV1', platform: 'bilibili', transcript: [{ start_sec: 0, end_sec: 45, text: '正文证据：这款产品仅支持离线使用。' }] }] })
  const timeline = contentTimeline(dataset)
  assert.ok(timeline.rows.length > 0)
  const ref = timeline.rows[0]!.transcript[0]!.ref
  assert.deepEqual(findCitations(`[${ref}]`, [dataset]), { valid: [ref], invalid: [] })
  const plan = planChunks(dataset)
  assert.ok(plan.chunks.some((chunk) => chunk.ids.includes(ref)))
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_findings', args: { findings: [{ direction: 1, title: '离线使用', criteria: '原文说明限制', refs: [1], quotes: [{ ref: 1, text: '仅支持离线使用' }] }] } }] }])
  const result = await summarizeChunks({ model, dataset, plan })
  assert.match(JSON.stringify(model.requests), /正文证据/)
  assert.equal(result.findings[0]?.refs[0]?.id, ref)
  assert.equal(result.chunks[0]?.dropped.bad_quote, 0)
})

test('阶段覆盖区分源状态、导入、计划、提交与成功', async () => {
  const { analysisCoverage } = await import('../../src/analysis/coverage.ts')
  const dataset = makeDataset([], { contents: [{ id: 'BV1', platform: 'bilibili', transcript: [{ start_sec: 0, end_sec: 1, text: '源正文' }] }], report: { contents: 1, items: 0, collections: [], errors: [], warnings: [], unmapped: [], transcripts: [{ content_id: 'BV1', path: 'captions', status: 'imported', elements: 1, imported: 1, failed: 0 }] } })
  const plan = planChunks(dataset)
  const before = analysisCoverage(dataset, plan)
  assert.equal(before.transcripts[0]?.imported, 1)
  assert.equal(before.transcripts[0]?.submitted, 0)
  const result = await summarizeChunks({ model: createFakeModel([{ tool_calls: [{ name: 'submit_findings', args: { findings: [] } }] }]), dataset, plan })
  const after = analysisCoverage(dataset, plan, result.chunks)
  assert.equal(after.transcripts[0]?.submitted, 1)
  assert.equal(after.transcripts[0]?.processed, 1)
  assert.equal(after.transcripts[0]?.source_status, 'imported')
})


test('时间轴字幕引用可由 get_feedback 回查原文', async () => {
  const { createGetFeedbackTool } = await import('../../src/tools/data/get_feedback.ts')
  const { createDatasetStore } = await import('../../src/dataset/store.ts')
  const dataset = makeDataset([], { contents: [{ id: 'BV1', platform: 'bilibili', transcript: [{ start_sec: 1, end_sec: 2, text: '可回查的字幕证据' }] }] })
  const ref = contentTimeline(dataset).rows[0]!.transcript[0]!.ref
  const tool = createGetFeedbackTool(createDatasetStore([dataset]))
  const result = await tool.execute({ ids: [ref] }, { run_id: 'test', signal: new AbortController().signal, cwd: '/', approve: async () => false })
  assert.match(result, /可回查的字幕证据/)
  assert.match(result, /字幕/)
})
