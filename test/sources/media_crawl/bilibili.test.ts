import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { bilibiliAdapter, parseClock, videoIdFromPath } from '../../../src/sources/media_crawl/bilibili.ts'
import { SourceError } from '../../../src/sources/types.ts'
import { BV_FIXTURE, AV_FIXTURE } from '../../helpers/fixtures.ts'

const FILE = '/data/super_collect/BV1xx411c7mD/示例-123/bilibili_all.json'

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { video_info: { title: '标题' }, ...overrides }
}

test('videoIdFromPath：BV 号优先，其次目录名末尾的 av 号', () => {
  assert.deepEqual(videoIdFromPath(FILE), { bvid: 'BV1xx411c7mD' })
  assert.deepEqual(videoIdFromPath('/data/某个视频-555878764/bilibili_all.json'), { aid: '555878764' })
  assert.deepEqual(videoIdFromPath('/data/某个视频/bilibili_all.json'), {})
  // BV 号必须是完整的一段目录名
  assert.deepEqual(videoIdFromPath('/data/xBV1xx411c7mD/bilibili_all.json'), {})
})

test('parseClock：支持 时:分:秒 和 分:秒，格式不对返回 undefined', () => {
  assert.equal(parseClock('01:02:03'), 3723)
  assert.equal(parseClock('00:01:21'), 81)
  assert.equal(parseClock('02:03'), 123)
  for (const bad of ['', '12', '1:2:3:4', 'a:01', '01:-1']) assert.equal(parseClock(bad), undefined, bad)
})

test('parse：一级评论、回复、弹幕的关系', async () => {
  const raw = JSON.parse(await readFile(BV_FIXTURE, 'utf8'))
  const { contents, items } = bilibiliAdapter.parse(raw, { file_path: BV_FIXTURE })
  const byId = new Map(items.map((item) => [item.id, item]))

  for (const item of items) {
    if (item.kind === 'reply') assert.equal(byId.get(item.parent_id ?? '')?.kind, 'comment')
    else assert.equal(item.parent_id, undefined)
    if (item.kind === 'danmaku') {
      assert.equal(item.created_at, undefined)
      assert.equal(typeof item.video_time_sec, 'number')
    } else {
      assert.ok(item.created_at && !Number.isNaN(Date.parse(item.created_at)))
      assert.ok(item.author?.name)
    }
  }

  const content = contents[0]
  assert.ok(content)
  assert.equal(content.transcript?.length, raw.video_zimu.length)
  assert.equal(content.published_at, new Date(raw.video_info.pubdate * 1000).toISOString())
  assert.equal(content.stats?.views, raw.video_info.view)
})

test('parse：缺失或为空的可选字段不出现在结果里', async () => {
  const raw = JSON.parse(await readFile(AV_FIXTURE, 'utf8'))
  const [content] = bilibiliAdapter.parse(raw, { file_path: AV_FIXTURE }).contents
  assert.equal(content?.summary, undefined, 'AI 总结为空字符串时不保留')

  const bare = bilibiliAdapter.parse(minimal(), { file_path: FILE })
  assert.deepEqual(bare.items, [])
  assert.equal(bare.contents[0]?.stats, undefined)
  assert.equal(bare.contents[0]?.transcript, undefined)
})

test('parse：数字或字符串形式的 ID 都转成字符串', () => {
  const raw = minimal({ video_comments: [{ rpid: 7, mid: '8', content: '好' }] })
  const [item] = bilibiliAdapter.parse(raw, { file_path: FILE }).items
  assert.equal(item?.id, 'bilibili:7')
  assert.equal(item?.author?.id, '8')
})

test('parse：原始数据不符合格式时，错误信息带出问题位置', () => {
  const raw = minimal({ video_comments: [{ rpid: 1 }] })
  assert.throws(
    () => bilibiliAdapter.parse(raw, { file_path: FILE }),
    (error: unknown) => {
      assert.ok(error instanceof SourceError)
      assert.match(error.message, /video_comments\.0\.content/)
      return true
    },
  )
  assert.throws(() => bilibiliAdapter.parse([], { file_path: FILE }), SourceError)
})

test('parse：路径中得不到视频 ID 时报错', () => {
  assert.throws(() => bilibiliAdapter.parse(minimal(), { file_path: '/data/x/bilibili_all.json' }), /视频 ID/)
})
