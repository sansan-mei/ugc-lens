import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compilePatterns, DEFAULT_PATTERNS, parsePatterns, scanFiles } from '../../src/watch/pattern.ts'

test('compilePatterns：* 和 ? 按文件名整体匹配，不区分大小写，点号是普通字符', () => {
  const match = compilePatterns(['*_all.json', 'data?.csv'])
  assert.ok(match('bilibili_all.json'))
  assert.ok(match('Douyin_ALL.JSON'))
  assert.ok(match('data1.csv'))
  assert.ok(!match('bilibili_comment.json'))
  assert.ok(!match('bilibili_all.json.tmp'))
  assert.ok(!match('bilibili_allXjson'))
  assert.ok(!match('data12.csv'))
})

test('parsePatterns：逗号分开，空时用默认规则', () => {
  assert.deepEqual(parsePatterns(' a.json，b_*.json ,'), ['a.json', 'b_*.json'])
  assert.deepEqual(parsePatterns(undefined), DEFAULT_PATTERNS)
  assert.deepEqual(parsePatterns(' , '), DEFAULT_PATTERNS)
})

test('scanFiles：递归查找，跳过 . 开头的目录和 node_modules；目录不存在时报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-scan-'))
  try {
    for (const path of ['v1/bilibili_all.json', 'v1/bilibili_comment.json', 'a/b/c/x_all.json', '.ugc-lens/y_all.json', 'node_modules/z_all.json']) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), '{}')
    }
    const found = await scanFiles(dir, compilePatterns(DEFAULT_PATTERNS))
    assert.deepEqual(found, [join(dir, 'a/b/c/x_all.json'), join(dir, 'v1/bilibili_all.json')])
    await assert.rejects(scanFiles(join(dir, 'missing'), () => true))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
