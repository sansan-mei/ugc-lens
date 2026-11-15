import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupDanmaku, summarizeDanmaku } from '../../src/analysis/danmaku.ts'
import { createTokenizer } from '../../src/analysis/keywords.ts'
import type { FeedbackItem } from '../../src/dataset/types.ts'
import { makeItem } from '../helpers/dataset.ts'

let next = 0
const dm = (text: string, sec: number): FeedbackItem => makeItem({ id: `d${++next}`, kind: 'danmaku', text, video_time_sec: sec })

test('groupDanmaku：同一句话合并计数，引用第一条的 ID，记录最早出现的时间', () => {
  const items = [dm('老尼！', 30), dm('老尼', 10), dm('哈哈哈哈哈', 5), dm('哈哈哈', 50), dm('老尼', 40), dm('？？？', 1)]
  const groups = groupDanmaku(items)
  assert.deepEqual(groups.map((g) => [g.text, g.count, g.id, g.first_sec]), [
    ['老尼！', 3, items[0]!.id, 10],
    ['哈哈哈哈哈', 2, items[2]!.id, 5],
  ])
})

test('summarizeDanmaku：找出高峰时段，列出时段里重复最多的弹幕和特有的词', () => {
  const items: FeedbackItem[] = []
  for (let sec = 0; sec < 600; sec += 3) items.push(dm(sec % 2 ? '画面好看' : '好看', sec))
  for (let i = 0; i < 60; i++) items.push(dm(i % 3 ? '前方高能' : '高能预警', 300 + (i % 10) / 2))
  items.push(makeItem({ id: 'c1', text: '评论不算' }))

  const summary = summarizeDanmaku(items, createTokenizer({ words: ['高能', '好看', '画面', '前方', '预警'] }), { binSec: 5 })
  assert.equal(summary.total, 260)
  assert.equal(summary.bin_sec, 5)
  assert.equal(summary.timeline.reduce((s, n) => s + n, 0), 260)
  const [peak] = summary.peaks
  assert.ok(peak)
  assert.equal(peak.start_sec, 300)
  assert.equal(peak.groups[0]?.text, '前方高能')
  assert.equal(peak.terms[0]?.word, '高能')
  assert.ok(summary.terms.some((t) => t.word === '好看'))
})

test('summarizeDanmaku：没有弹幕时返回空结果', () => {
  const summary = summarizeDanmaku([makeItem({ id: 'c1', text: 'x' })], createTokenizer())
  assert.deepEqual([summary.total, summary.unique, summary.peaks, summary.timeline], [0, 0, [], []])
})

test('summarizeDanmaku：每个时间段给出段内重复最多的几种弹幕，供悬浮查看', () => {
  const items = [dm('开头', 1), dm('开头', 2), dm('第二句', 3), dm('中间', 12), dm('结尾', 26), dm('结尾', 27), dm('结尾', 29)]
  const summary = summarizeDanmaku(items, createTokenizer(), { binSec: 10, groupsPerBin: 2 })
  assert.equal(summary.bins.length, summary.timeline.length)
  summary.bins.forEach((groups, i) => {
    assert.ok(groups.length <= 2)
    assert.ok(groups.reduce((s, g) => s + g.count, 0) <= summary.timeline[i]!)
    for (const g of groups) assert.ok(g.first_sec! >= i * 10 && g.first_sec! < (i + 1) * 10)
  })
  assert.deepEqual(summary.bins.map((groups) => groups.map((g) => [g.text, g.count])), [[['开头', 2], ['第二句', 1]], [['中间', 1]], [['结尾', 3]]])
})
