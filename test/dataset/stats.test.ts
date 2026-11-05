import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeStats } from '../../src/dataset/stats.ts'
import type { Dataset, FeedbackItem } from '../../src/dataset/types.ts'

function item(partial: Partial<FeedbackItem> & Pick<FeedbackItem, 'id' | 'kind'>): FeedbackItem {
  return { platform: 'bilibili', content_id: 'bilibili:BV1', text: '', ...partial }
}

function dataset(items: FeedbackItem[]): Dataset {
  return {
    id: 'test',
    platform: 'bilibili',
    file_path: '/x',
    contents: [{ id: 'bilibili:BV1', platform: 'bilibili', title: 't' }],
    items,
    imported_at: new Date(0).toISOString(),
    mapping: { fingerprint: 'test', from_cache: false },
    report: { contents: 1, items: items.length, collections: [], errors: [], warnings: [], unmapped: [] },
  }
}

test('computeStats：按类型计数，回复数分为平台显示与实际搜集', () => {
  const stats = computeStats(
    dataset([
      item({ id: 'c1', kind: 'comment', reply_count: 5 }),
      item({ id: 'c2', kind: 'comment', reply_count: 0 }),
      item({ id: 'r1', kind: 'reply', parent_id: 'c1', reply_count: 9 }),
      item({ id: 'd1', kind: 'danmaku' }),
    ]),
  )
  assert.equal(stats.contents, 1)
  assert.deepEqual(stats.items, { comment: 2, reply: 1, danmaku: 1, answer: 0 })
  assert.deepEqual(stats.replies, { reported: 5, collected: 1 }, '回复自身的 reply_count 不计入')
})

test('computeStats：时间范围取最早和最晚，没有时间时不给出', () => {
  const stats = computeStats(
    dataset([
      item({ id: 'a', kind: 'comment', created_at: '2024-05-01T00:00:00.000Z' }),
      item({ id: 'b', kind: 'reply', created_at: '2024-01-01T00:00:00.000Z' }),
      item({ id: 'c', kind: 'comment', created_at: '2024-09-01T00:00:00.000Z' }),
      item({ id: 'd', kind: 'danmaku' }),
    ]),
  )
  assert.deepEqual(stats.time_range, { from: '2024-01-01T00:00:00.000Z', to: '2024-09-01T00:00:00.000Z' })
  assert.equal(computeStats(dataset([item({ id: 'd', kind: 'danmaku' })])).time_range, undefined)
})

test('computeStats：属地按次数排序并截取，with_location 统计全部有属地的条目', () => {
  const locations = ['广东', '北京', '广东', '江苏', '北京', '广东', undefined]
  const items = locations.map((location, i) => item({ id: String(i), kind: 'comment', author: { location } }))
  const stats = computeStats(dataset(items), { topLocations: 2 })
  assert.deepEqual(stats.locations, [
    { name: '广东', count: 3 },
    { name: '北京', count: 2 },
  ])
  assert.equal(stats.with_location, 6)
})
