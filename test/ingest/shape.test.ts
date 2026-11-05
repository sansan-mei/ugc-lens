import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { describeShape } from '../../src/ingest/shape.ts'
import { AV_FIXTURE, BV_FIXTURE } from '../helpers/fixtures.ts'

test('describeShape：列出路径、类型、数组长度和截断的示例值', () => {
  const shape = describeShape({ list: [{ text: 'a'.repeat(100), n: 3 }, { text: 'b' }], empty: [] }, { maxExampleChars: 10 })
  const lines = shape.text.split('\n')
  assert.ok(lines.includes('$.list  array  长度 2'))
  assert.ok(lines.includes(`$.list[].text  string  例："${'a'.repeat(10)}…"`))
  assert.ok(lines.includes('$.list[].n  number  例：3'))
  assert.ok(lines.includes('$.empty  array  长度 0'))
  assert.deepEqual(shape.arrays, [
    { path: '$.list', total: 2, objects: true },
    { path: '$.empty', total: 0, objects: false },
  ])
})

test('describeShape：抽样合并多个元素的字段，不只看第一条', () => {
  const list = Array.from({ length: 1000 }, (_, i) => (i === 999 ? { a: 1, late: 'x' } : { a: 1 }))
  assert.match(describeShape({ list }, { sampleSize: 10 }).text, /\$\.list\[\]\.late/)
})

test('describeShape：指纹只取决于路径和类型，与值、数组长度无关', () => {
  const a = describeShape({ list: [{ text: '一', n: 1 }] })
  const b = describeShape({ list: [{ text: '二', n: 2 }, { text: '三', n: 3 }] })
  const c = describeShape({ list: [{ text: '一', n: '1' }] })
  assert.equal(a.fingerprint, b.fingerprint)
  assert.notEqual(a.fingerprint, c.fingerprint)
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/)
})

test('describeShape：超过行数上限时注明未列出的数量', () => {
  const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
  const lines = describeShape(wide, { maxLines: 5 }).text.split('\n')
  assert.equal(lines.length, 6)
  assert.match(lines[5]!, /另有 16 个路径未列出/)
})

test('describeShape：B 站样本里能看到评论、回复、弹幕、字幕的路径', async () => {
  const shape = describeShape(JSON.parse(await readFile(BV_FIXTURE, 'utf8')))
  for (const path of ['$.video_comments[].content', '$.video_comments[].replyList[].content', '$.video_danmus[].time', '$.video_zimu[].from']) {
    assert.match(shape.text, new RegExp(`^${path.replaceAll(/[$.[\]]/g, '\\$&')}  `, 'm'), path)
  }
  const other = describeShape(JSON.parse(await readFile(AV_FIXTURE, 'utf8')))
  assert.notEqual(shape.fingerprint, other.fingerprint, '空数组没有元素结构，指纹不同')
})
