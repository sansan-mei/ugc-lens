import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getField, joinTokens, resolveTokens, tokenize } from '../../src/ingest/paths.ts'

const data = {
  info: { title: 'T' },
  answers: [{ comments: [{ text: 'a' }, { text: 'b' }] }, { comments: [{ text: 'c' }] }, { other: 1 }],
}

test('tokenize / joinTokens：互为逆运算', () => {
  assert.deepEqual(tokenize('$.answers[].comments'), ['answers', '[]', 'comments'])
  assert.deepEqual(tokenize('$'), [])
  assert.deepEqual(tokenize('$[]'), ['[]'])
  assert.deepEqual(tokenize('user.name'), ['user', 'name'])
  for (const path of ['$', '$[]', '$.answers[].comments', '$.a.b']) assert.equal(joinTokens(tokenize(path)), path)
})

test('resolveTokens：[] 展开数组，走不通的分支丢弃', () => {
  const arrays = resolveTokens([data], tokenize('$.answers[].comments'))
  assert.equal(arrays.length, 2)
  assert.deepEqual(resolveTokens([data], tokenize('$.answers[].comments[].text')), ['a', 'b', 'c'])
  assert.deepEqual(resolveTokens([data], tokenize('$.missing[].x')), [])
})

test('getField：相对路径从当前元素取，$ 开头从文件顶层取', () => {
  const element = { user: { name: '甲' } }
  assert.equal(getField(element, data, 'user.name'), '甲')
  assert.equal(getField(element, data, '$.info.title'), 'T')
  assert.equal(getField(element, data, 'user.age'), undefined)
  assert.equal(getField('字符串', data, 'x'), undefined)
})
