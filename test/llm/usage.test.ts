import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addUsage, emptyUsage, formatCachedTokens } from '../../src/llm/usage.ts'

test('addUsage：未返回缓存字段的调用计为未知，不当成命中 0', () => {
  const total = emptyUsage()
  addUsage(total, { input_tokens: 100, output_tokens: 10 })
  addUsage(total, { input_tokens: 50, output_tokens: 5 })
  assert.equal(total.input_tokens, 150)
  assert.equal(total.output_tokens, 15)
  assert.equal('cached_input_tokens' in total, false)
  assert.equal(total.cached_unreported_calls, 2)
  assert.equal(formatCachedTokens(total), '未知')
})

test('addUsage：返回 0 是已知的 0；部分调用未返回时只给下限', () => {
  const known = emptyUsage()
  addUsage(known, { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 })
  assert.equal(known.cached_input_tokens, 0)
  assert.equal(formatCachedTokens(known), '0')

  addUsage(known, { input_tokens: 100, output_tokens: 10, cached_input_tokens: 1200 })
  addUsage(known, { input_tokens: 100, output_tokens: 10 })
  assert.equal(known.cached_input_tokens, 1200)
  assert.equal(known.cached_unreported_calls, 1)
  assert.equal(formatCachedTokens(known), '至少 1,200（1 次调用未返回）')
})

test('addUsage：合并子阶段汇总时沿用其未知次数，空汇总不增加未知', () => {
  const stage = emptyUsage()
  addUsage(stage, { input_tokens: 1, output_tokens: 1 })
  addUsage(stage, { input_tokens: 1, output_tokens: 1 })
  const total = emptyUsage()
  addUsage(total, stage)
  addUsage(total, emptyUsage())
  addUsage(total, undefined)
  addUsage(total, { input_tokens: 1, output_tokens: 1, cached_input_tokens: 7 })
  assert.equal(total.input_tokens, 3)
  assert.equal(total.cached_input_tokens, 7)
  assert.equal(total.cached_unreported_calls, 2)
  assert.equal(formatCachedTokens(emptyUsage()), '0')
})

test('formatCachedTokens：兼容旧记录中只有数字的用量', () => {
  assert.equal(formatCachedTokens({ input_tokens: 1, output_tokens: 1, cached_input_tokens: 500 }), '500')
  assert.equal(formatCachedTokens({ input_tokens: 1, output_tokens: 1 }), '未知')
})
