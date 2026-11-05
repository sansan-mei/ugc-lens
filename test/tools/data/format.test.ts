import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatItem, takeLines } from '../../../src/tools/data/format.ts'
import { makeItem } from '../../helpers/dataset.ts'

test('formatItem：ID 在最前，带上类型、点赞、日期、属地、上一级和作者', () => {
  const line = formatItem(
    makeItem({
      id: 'r1',
      kind: 'reply',
      parent_id: 'c1',
      text: '第一行\n  第二行',
      likes: 0,
      reply_count: 0,
      created_at: '2024-10-22T08:00:00.000Z',
      author: { name: '用户3', location: '浙江' },
    }),
  )
  assert.equal(line, '[r1] 回复 赞0 2024-10-22 浙江 回复[c1] 用户3：第一行 第二行')
})

test('formatItem：弹幕显示视频时间；超长正文截断并注明全文长度', () => {
  const item = makeItem({ id: 'd1', kind: 'danmaku', text: '哈'.repeat(30), video_time_sec: 3725.4 })
  assert.equal(formatItem(item, { maxChars: 10 }), `[d1] 弹幕 视频1:02:05 ${'哈'.repeat(10)}…（全文 30 字）`)
  assert.match(formatItem(makeItem({ id: 'x', video_time_sec: 81 })), /视频01:21/)
  assert.match(formatItem(makeItem({ id: 'x' }), { showContent: true }), /内容BV1/)
})

test('takeLines：超过上限时停下，但至少保留一行', () => {
  assert.deepEqual(takeLines(['aaaa', 'bbbb', 'cccc'], 9), { shown: ['aaaa', 'bbbb'], omitted: 1 })
  assert.deepEqual(takeLines(['a'.repeat(100), 'b'], 10), { shown: ['a'.repeat(100)], omitted: 1 })
  assert.deepEqual(takeLines([], 10), { shown: [], omitted: 0 })
})
