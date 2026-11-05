import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mappingSchema } from '../../src/ingest/mapping.ts'
import { toParametersSchema } from '../../src/tools/define.ts'
import { BILIBILI_MAPPING } from '../helpers/fixtures.ts'

const base = { platform: 'x', collections: [{ kind: 'comment', path: '$.list', fields: { text: 'content' } }] }
const withPath = (path: string, text = 'content') => ({ ...base, collections: [{ ...base.collections[0], path, fields: { text } }] })

test('mappingSchema：能转成 JSON Schema，路径规则以 pattern 的形式出现', () => {
  const schema = JSON.stringify(toParametersSchema(mappingSchema))
  assert.match(schema, /"pattern"/)
})

test('mappingSchema：合法路径', () => {
  for (const path of ['$', '$[]', '$.list', '$.answers[].comments', '$.data.评论']) {
    assert.equal(mappingSchema.safeParse(withPath(path)).success, true, path)
  }
  for (const text of ['content', 'user.name', '$.info.title']) {
    assert.equal(mappingSchema.safeParse(withPath('$.list', text)).success, true, text)
  }
  assert.equal(mappingSchema.safeParse(BILIBILI_MAPPING).success, true)
})

test('mappingSchema：不合法路径', () => {
  for (const path of ['list', '$.', '$..a', '$.a[0]', '$.a[]b']) {
    assert.equal(mappingSchema.safeParse(withPath(path)).success, false, path)
  }
  for (const text of ['', '$', 'a..b', 'a[].b', '$x']) {
    assert.equal(mappingSchema.safeParse(withPath('$.list', text)).success, false, text)
  }
  assert.equal(mappingSchema.safeParse({ ...base, collections: [] }).success, false)
})

test('mappingSchema：多写的字段报错，不会被悄悄丢掉', () => {
  const result = mappingSchema.safeParse({ ...base, content: { path: '$.info', title: 'title' } })
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result.error?.issues), /title/)
})

test('mappingSchema：下一级默认是 reply、不递归', () => {
  const parsed = mappingSchema.parse({ ...base, collections: [{ ...base.collections[0], children: [{ path: 'replies' }] }] })
  assert.deepEqual(parsed.collections[0]?.children?.[0], { kind: 'reply', path: 'replies', recursive: false })
})
