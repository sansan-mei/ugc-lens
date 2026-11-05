import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactRepeats, formatItem, sliceText, takeLines } from '../../../src/tools/data/format.ts'
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

test('compactRepeats：8 个以上相同字符压成 3 个并注明个数，短的不变', () => {
  assert.equal(compactRepeats('牛'.repeat(3) + '6'.repeat(20) + '!'), '牛牛牛666…（6×20）!')
  assert.equal(compactRepeats('哈哈哈哈哈哈哈'), '哈哈哈哈哈哈哈')
  assert.match(formatItem(makeItem({ id: 'x', text: '6'.repeat(30) }), { compact: true }), /666…（6×30）$/)
})

test('takeLines：超过上限时停下，但至少保留一行', () => {
  assert.deepEqual(takeLines(['aaaa', 'bbbb', 'cccc'], 9), { shown: ['aaaa', 'bbbb'], omitted: 1 })
  assert.deepEqual(takeLines(['a'.repeat(100), 'b'], 10), { shown: ['a'.repeat(100)], omitted: 1 })
  assert.deepEqual(takeLines([], 10), { shown: [], omitted: 0 })
})

test('截断不拆开 emoji 这类占两个 UTF-16 单位的字符，避免产生半个字符', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  for (let max = 1; max <= 6; max++) {
    const line = formatItem(makeItem({ id: 'a', text: '好😰😰😰😰😰😰' }), { maxChars: max })
    assert.doesNotMatch(line, lone, `maxChars=${max}`)
  }
  assert.equal(sliceText('好😰', 2), '好')
  assert.equal(sliceText('好😰', 3), '好😰')
})
