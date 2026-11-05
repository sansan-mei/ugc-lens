import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approxTokens } from '../../src/llm/tokens.ts'

test('approxTokens：汉字比英文字母算得多，空字符串为 0', () => {
  assert.equal(approxTokens(''), 0)
  assert.ok(approxTokens('价格太贵了') > approxTokens('price'))
  assert.ok(approxTokens('价格'.repeat(100)) > approxTokens('价格'.repeat(10)))
  assert.equal(approxTokens('，！'), approxTokens('价格'), '全角标点按汉字算')
})
