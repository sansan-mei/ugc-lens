import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEvidence, transcriptEvidence } from '../../src/dataset/evidence.ts'
import { findCitations } from '../../src/dataset/query.ts'
import { makeDataset } from '../helpers/dataset.ts'

test('不同内容的同文字幕保持独立身份，并能用展示的 ID 回查原文', () => {
  const text = '完全相同的源正文'
  const dataset = makeDataset([], { contents: ['v1', 'v2'].map((id) => ({ id, platform: 'x', transcript: [{ start_sec: 0, end_sec: 2, text }] })) })
  const evidence = transcriptEvidence(dataset)
  assert.equal(new Set(evidence.map((line) => line.id)).size, dataset.contents.length)
  for (const line of evidence) {
    const found = getEvidence(dataset, line.id)!
    assert.equal(found.text, dataset.contents.find((c) => c.id === found.content_id)!.transcript![0]!.text)
    assert.deepEqual(findCitations(`[${line.id}]`, [dataset]), { valid: [line.id], invalid: [] })
  }
  assert.equal(getEvidence(dataset, 'missing'), undefined)
})
