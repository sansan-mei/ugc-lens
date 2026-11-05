import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findCitations, getFeedback, getReplies, searchFeedback } from '../../src/dataset/query.ts'
import { fixtureDataset, makeDataset, makeItem } from '../helpers/dataset.ts'

const items = [
  makeItem({ id: 'c1', text: '标题党，退钱！', likes: 10, reply_count: 2, created_at: '2024-05-02T00:00:00.000Z', author: { location: '广东' } }),
  makeItem({ id: 'c2', text: 'UP 主讲得很清楚', likes: 50, created_at: '2024-05-01T00:00:00.000Z', author: { location: '北京' } }),
  makeItem({ id: 'r1', kind: 'reply', parent_id: 'c1', text: '确实是标题党', likes: 3, created_at: '2024-05-04T00:00:00.000Z' }),
  makeItem({ id: 'r2', kind: 'reply', parent_id: 'c1', text: '我觉得还行', likes: 0, created_at: '2024-05-03T00:00:00.000Z' }),
  makeItem({ id: 'd1', kind: 'danmaku', text: '骗人的吧', video_time_sec: 30 }),
  makeItem({ id: 'd2', kind: 'danmaku', text: '前方高能', video_time_sec: 5 }),
]
const dataset = makeDataset(items)
const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id)

test('searchFeedback：默认按点赞从多到少，没有点赞的排在最后', () => {
  assert.deepEqual(ids(searchFeedback(dataset)), ['c2', 'c1', 'r1', 'r2', 'd1', 'd2'])
})

test('searchFeedback：空格分隔的词都要出现，| 表示任意一个，不区分大小写', () => {
  assert.deepEqual(ids(searchFeedback(dataset, { query: '标题党' })), ['c1', 'r1'])
  assert.deepEqual(ids(searchFeedback(dataset, { query: '标题党 退钱' })), ['c1'])
  assert.deepEqual(ids(searchFeedback(dataset, { query: '退钱|骗' })).sort(), ['c1', 'd1'])
  assert.deepEqual(ids(searchFeedback(dataset, { query: 'up' })), ['c2'])
})

test('searchFeedback：按类型、上一级、点赞数、属地筛选', () => {
  assert.deepEqual(ids(searchFeedback(dataset, { kinds: ['danmaku'] })), ['d1', 'd2'])
  assert.deepEqual(ids(searchFeedback(dataset, { parent_id: 'c1' })), ['r1', 'r2'])
  assert.deepEqual(ids(searchFeedback(dataset, { min_likes: 10 })), ['c2', 'c1'])
  assert.deepEqual(ids(searchFeedback(dataset, { location: '广东' })), ['c1'])
})

test('searchFeedback：按时间筛选时排除没有发布时间的条目，非法日期报错', () => {
  assert.deepEqual(ids(searchFeedback(dataset, { since: '2024-05-02', sort: 'oldest' })), ['c1', 'r2', 'r1'])
  assert.deepEqual(ids(searchFeedback(dataset, { until: '2024-05-01T12:00:00Z' })), ['c2'])
  assert.throws(() => searchFeedback(dataset, { since: '昨天' }), /since 不是有效的日期/)
})

test('searchFeedback：各种排序', () => {
  assert.deepEqual(ids(searchFeedback(dataset, { sort: 'newest', limit: 2 })), ['r1', 'r2'])
  assert.deepEqual(ids(searchFeedback(dataset, { sort: 'oldest' })).slice(-2), ['d1', 'd2'], '没有时间的排在最后')
  assert.deepEqual(ids(searchFeedback(dataset, { sort: 'video_time' })).slice(0, 2), ['d2', 'd1'])
  assert.deepEqual(ids(searchFeedback(dataset, { sort: 'replies' }))[0], 'c1')
})

test('searchFeedback：分页时 total 是全部匹配数，各页拼起来等于完整结果', () => {
  const all = ids(searchFeedback(dataset, { limit: 100 }))
  const pages = [0, 2, 4].map((offset) => searchFeedback(dataset, { offset, limit: 2 }))
  assert.ok(pages.every((page) => page.total === items.length))
  assert.deepEqual(pages.flatMap(ids), all)
  assert.deepEqual(searchFeedback(dataset, { offset: 100 }).items, [])
})

test('getFeedback / getReplies：按 ID 取条目，回复按时间从早到晚', () => {
  assert.equal(getFeedback(dataset, 'c2')?.text, 'UP 主讲得很清楚')
  assert.equal(getFeedback(dataset, 'nope'), undefined)
  assert.deepEqual(getReplies(dataset, 'c1').map((item) => item.id), ['r2', 'r1'])
  assert.deepEqual(getReplies(dataset, 'c2'), [])
})

test('findCitations：区分存在和不存在的 ID，忽略 Markdown 链接，重复的只算一次', () => {
  const text = '很多人说标题党 [c1] [r1]，也有人夸 [c2][c1]。见 [官网](https://x.com)。编造的 [c99]'
  assert.deepEqual(findCitations(text, [dataset]), { valid: ['c1', 'r1', 'c2'], invalid: ['c99'] })
  assert.deepEqual(findCitations('没有引用', [dataset]), { valid: [], invalid: [] })
})

test('findCitations：原文里自带的方括号（如 B 站表情 [干杯]）被引用时不算编造的 ID', () => {
  const withEmoji = makeDataset([makeItem({ id: 'e1', text: '请问价格嘛[干杯][干杯]' })])
  const answer = '有人问价格：“请问价格嘛[干杯][干杯]” [e1]，另见 [e404]'
  assert.deepEqual(findCitations(answer, [withEmoji]), { valid: ['e1'], invalid: ['e404'] })
})

test('样本数据：每条回复都能通过 getReplies 从上一级找到', async () => {
  const fixture = await fixtureDataset()
  const replies = fixture.items.filter((item) => item.kind === 'reply')
  assert.ok(replies.length > 0)
  for (const reply of replies) {
    assert.ok(getReplies(fixture, reply.parent_id!).some((item) => item.id === reply.id))
  }
  const page = searchFeedback(fixture, { kinds: ['comment'], limit: 1000 })
  assert.equal(page.total, fixture.items.filter((item) => item.kind === 'comment').length)
})
