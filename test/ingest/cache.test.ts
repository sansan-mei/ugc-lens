import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addCacheRule, listCache, readCache, type CacheRule } from '../../src/ingest/cache.ts'
import { mappingSchema } from '../../src/ingest/mapping.ts'
import { BILIBILI_MAPPING } from '../helpers/fixtures.ts'

const rule: CacheRule = {
  created_at: new Date(0).toISOString(),
  file_name: 'bilibili_all.json',
  outcome: { type: 'mapping', mapping: mappingSchema.parse(BILIBILI_MAPPING) },
}

test('addCacheRule / readCache：追加后能读回，目录自动创建，相同规则不重复保存，不留临时文件', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ugc-lens-cache-')), 'nested')
  try {
    await addCacheRule(dir, 'abc123', rule)
    await addCacheRule(dir, 'abc123', { ...rule, created_at: new Date(1).toISOString() })
    const other: CacheRule = { ...rule, outcome: { type: 'rejected', reason: '搜索结果' } }
    await addCacheRule(dir, 'abc123', other)

    assert.deepEqual(await readCache(dir, 'abc123'), { version: 2, fingerprint: 'abc123', rules: [rule, other] })
    assert.deepEqual(await readdir(dir), ['abc123.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCache / listCache：不存在、不是 JSON、格式不对、指纹不一致时都跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-lens-cache-'))
  try {
    assert.equal(await readCache(dir, 'missing'), undefined)
    assert.deepEqual(await listCache(join(dir, 'missing')), [])
    await writeFile(join(dir, 'bad.json'), '{')
    assert.equal(await readCache(dir, 'bad'), undefined)
    await writeFile(join(dir, 'old.json'), JSON.stringify({ version: 1, fingerprint: 'old', rules: [rule] }))
    assert.equal(await readCache(dir, 'old'), undefined)
    await writeFile(join(dir, 'renamed.json'), JSON.stringify({ version: 2, fingerprint: 'other', rules: [rule] }))
    assert.equal(await readCache(dir, 'renamed'), undefined)
    await addCacheRule(dir, 'good', rule)
    assert.deepEqual((await listCache(dir)).map((entry) => entry.fingerprint).sort(), ['good', 'other'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
