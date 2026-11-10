import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadDataset } from '../../src/ingest/index.ts'
import { AV_FIXTURE, BV_FIXTURE } from '../helpers/fixtures.ts'

const cacheDir = mkdtempSync(join(tmpdir(), 'ugc-lens-preset-'))
after(() => rmSync(cacheDir, { recursive: true, force: true }))

test('内置规则：media_crawl 的 B 站文件无需模型和缓存即可导入，评论、回复和弹幕都在', async () => {
  const dataset = await loadDataset(BV_FIXTURE, { cacheDir })
  assert.equal(dataset.mapping.builtin, true)
  assert.equal(dataset.platform, 'bilibili')
  assert.equal(dataset.contents[0]!.id, 'BV1xx411c7mD')
  const kinds = new Set(dataset.items.map((item) => item.kind))
  for (const kind of ['comment', 'reply', 'danmaku'] as const) assert.ok(kinds.has(kind), `缺少 ${kind}`)
  assert.deepEqual(dataset.report.unmapped, [])
  assert.deepEqual(dataset.report.errors, [])
})

test('内置规则：路径只有 av 号时用目录名末尾的数字作内容 ID', async () => {
  const dataset = await loadDataset(AV_FIXTURE, { cacheDir })
  assert.equal(dataset.contents[0]!.id, '100000002')
})

test('内置规则：结构不符的 JSON 仍需要模型识别', async () => {
  const { writeFileSync } = await import('node:fs')
  const file = join(cacheDir, 'other.json')
  writeFileSync(file, JSON.stringify({ posts: [{ body: 'hello', uid: 1 }, { body: 'world', uid: 2 }] }))
  await assert.rejects(loadDataset(file, { cacheDir }), /需要提供模型/)
})
