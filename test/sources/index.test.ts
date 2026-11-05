import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { datasetId, detectFile, loadDataset, SourceError } from '../../src/sources/index.ts'
import { BV_FIXTURE, AV_FIXTURE } from '../helpers/fixtures.ts'

test('detectFile：按文件名区分支持、暂不支持、汇总文件和未知文件', () => {
  const supported = detectFile('/data/x/bilibili_all.json')
  assert.equal(supported.status, 'supported')
  assert.equal(supported.status === 'supported' && supported.adapter.platform, 'bilibili')

  const notYet = detectFile('/data/x/all_xhs.json')
  assert.equal(notYet.status, 'unsupported')
  assert.equal(notYet.status === 'unsupported' && notYet.platform, 'xhs')

  assert.equal(detectFile('/data/all_search.json').status, 'ignored')
  assert.equal(detectFile('/data/bilibili_comments.json').status, 'unknown')
  assert.equal(detectFile('/data/notes.txt').status, 'unknown')
})

test('datasetId：同一文件得到同一 ID，相对路径与绝对路径等价', () => {
  assert.equal(datasetId(BV_FIXTURE), datasetId(BV_FIXTURE))
  assert.notEqual(datasetId(BV_FIXTURE), datasetId(AV_FIXTURE))
  assert.equal(datasetId(join(process.cwd(), 'a/bilibili_all.json')), datasetId('a/bilibili_all.json'))
  assert.match(datasetId(BV_FIXTURE), /^[0-9a-f]{12}$/)
})

test('loadDataset：读入 B 站样本，条目数量与原始文件一致', async () => {
  const raw = JSON.parse(await readFile(BV_FIXTURE, 'utf8')) as {
    video_comments: Array<{ replyList: unknown[] }>
    video_danmus: unknown[]
  }
  const dataset = await loadDataset(BV_FIXTURE)

  assert.equal(dataset.platform, 'bilibili')
  assert.equal(dataset.source, 'media_crawl/bilibili')
  assert.equal(dataset.file_path, BV_FIXTURE)
  assert.equal(dataset.id, datasetId(BV_FIXTURE))
  assert.equal(dataset.contents.length, 1)
  assert.equal(dataset.contents[0]?.id, 'bilibili:BV1xx411c7mD')

  const count = (kind: string) => dataset.items.filter((item) => item.kind === kind).length
  assert.equal(count('comment'), raw.video_comments.length)
  assert.equal(count('reply'), raw.video_comments.reduce((sum, c) => sum + c.replyList.length, 0))
  assert.equal(count('danmaku'), raw.video_danmus.length)
  assert.equal(new Set(dataset.items.map((item) => item.id)).size, dataset.items.length)
  assert.ok(dataset.items.every((item) => item.content_id === dataset.contents[0]?.id))
})

test('loadDataset：路径里没有 BV 号时用目录名末尾的 av 号', async () => {
  const dataset = await loadDataset(AV_FIXTURE)
  assert.equal(dataset.contents[0]?.id, 'bilibili:av100000002')
  assert.equal(dataset.contents[0]?.url, 'https://www.bilibili.com/video/av100000002')
})

test('loadDataset：不支持的文件、不存在的文件、不是 JSON 的文件都抛出 SourceError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-lens-sources-'))
  try {
    await assert.rejects(loadDataset(join(dir, 'all_xhs.json')), SourceError)
    await assert.rejects(loadDataset(join(dir, 'missing-1', 'bilibili_all.json')), SourceError)

    const broken = join(dir, 'bilibili_all.json')
    await writeFile(broken, '{ not json')
    await assert.rejects(loadDataset(broken), (error: unknown) => {
      assert.ok(error instanceof SourceError)
      assert.match(error.message, /无法读取/)
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
