import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binCounts, chooseBinSeconds, detectPeaks } from '../../src/analysis/timeline.ts'

test('chooseBinSeconds：大约 150 段，限制在 5～60 秒', () => {
  assert.equal(chooseBinSeconds(60), 5)
  assert.equal(chooseBinSeconds(1500), 10)
  assert.equal(chooseBinSeconds(36_000), 60)
})

test('binCounts：按段计数，忽略负数和非法值', () => {
  assert.deepEqual(binCounts([0, 4.9, 5, 21, -1, Number.NaN], 5), [2, 1, 0, 0, 1])
  assert.deepEqual(binCounts([], 5), [])
})

test('detectPeaks：找出明显高于平常的时段，相邻段合并', () => {
  const counts = Array.from({ length: 60 }, (_, i) => 10 + (i % 3))
  counts[20] = 80
  counts[21] = 60
  counts[45] = 40
  const peaks = detectPeaks(counts, 10)
  assert.equal(peaks.length, 2)
  assert.deepEqual(peaks[0] && [peaks[0].start_sec, peaks[0].end_sec, peaks[0].count], [200, 220, 140])
  assert.deepEqual(peaks[1] && [peaks[1].start_sec, peaks[1].count], [450, 40])
  assert.ok(peaks[0]!.baseline > 10 && peaks[0]!.baseline < 20)
})

test('detectPeaks：一个极端高峰不会让其他高峰消失（稳健基准）', () => {
  const counts = Array.from({ length: 100 }, (_, i) => 5 + (i % 3))
  counts[10] = 1000
  counts[50] = 30
  assert.deepEqual(detectPeaks(counts, 5).map((p) => p.start_sec), [50, 250])
})

test('detectPeaks：平稳的时间轴、空时间轴没有高峰；limit 限制个数', () => {
  assert.deepEqual(detectPeaks(Array.from({ length: 50 }, () => 7), 5), [])
  assert.deepEqual(detectPeaks([], 5), [])
  const counts = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 50 : 2 + (i % 2)))
  assert.equal(detectPeaks(counts, 5, { limit: 3 }).length, 3)
})
