import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { findCitations } from '../../src/dataset/query.ts'
import { getEvidence } from '../../src/dataset/evidence.ts'
import { applyMapping } from '../../src/ingest/apply.ts'
import { mappingSchema } from '../../src/ingest/mapping.ts'
import { analyzeDataset } from '../../src/pipeline/analyze.ts'
import { makeDataset } from '../helpers/dataset.ts'

test('综合证据从重复导入、多视频和分叉回复到模型输入与报告保持可追溯', async () => {
  const data = { videos: [
    { id: 'v1', captions: [{ start: 0, end: 10, text: '源正文：功能仅限离线' }], comments: [
      { id: 'p1', text: '建议很好', replies: [{ id: 'r1', text: '我反对', target: 'p1' }] },
      { id: 'p1', text: '建议很好', replies: [{ id: 'r2', text: '我同意你', target: 'r1' }] },
    ] },
    { id: 'v2', captions: [], comments: [{ id: 'p2', text: '建议很好', replies: [{ id: 'r3', text: '另一视频的反对', target: 'p2' }] }] },
  ] }
  const rule = mappingSchema.parse({ platform: 'x', content: { path: '$.videos', fields: { id: 'id' }, transcript: { path: 'captions', start: 'start', end: 'end', text: 'text' } }, collections: [{ path: '$.videos[].comments', kind: 'comment', fields: { id: 'id', text: 'text' }, children: [{ path: 'replies', kind: 'reply', fields: { id: 'id', text: 'text', parent_id: 'target' } }] }] })
  const imported = applyMapping(data, rule, { file_path: '/fixture.json' })
  assert.deepEqual(imported.report.errors, [])
  const dataset = makeDataset(imported.items, { contents: imported.contents, report: imported.report })
  const model = createFakeModel((request) => {
    const name = request.tools[0]!.function.name
    return { tool_calls: [{ name, args: name === 'submit_themes' ? { themes: [] } : { findings: [{ direction: 1, title: '可回查观点', criteria: '依原文', refs: [1], support: 1 }] } }] }
  })
  const result = await analyzeDataset({ dataset, model, outDir: false, minSupport: 1 })
  const input = JSON.stringify(model.requests)
  for (const item of dataset.items) assert.ok(input.includes(item.text), item.id)
  assert.match(input, /parent=r1.*root=p1/)
  assert.match(input, /源正文：功能仅限离线/)
  const refs = result.plan.chunks.flatMap((c) => c.ids)
  for (const id of refs) assert.ok(getEvidence(dataset, id))
  assert.equal(new Set(refs).size, dataset.items.length + 1)
  assert.deepEqual(findCitations(refs.map((id) => `[${id}]`).join(' '), [dataset]).invalid, [])
  assert.match(result.markdown, /正文字幕覆盖/)
  assert.equal(result.coverage.transcripts.find((t) => t.content_id === 'v1')?.submitted, 1)
  assert.equal(result.coverage.transcripts.find((t) => t.content_id === 'v2')?.source_status, 'empty')
  assert.equal(result.task_usage.calls.length, model.requests.length)
  assert.equal(result.task_usage.known_tokens, result.usage.input_tokens + result.usage.output_tokens)
})
