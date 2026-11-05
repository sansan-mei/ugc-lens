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
