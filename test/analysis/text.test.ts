import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJunkWord, STOP_WORDS } from '../../src/analysis/stopwords.ts'
import { dedupeKey, isLowInfo, median, normalizeText, seededRandom, stripEmoji, stripReplyPrefix } from '../../src/analysis/text.ts'

test('stripReplyPrefix：只去掉开头的“回复 @某人 :”', () => {
  assert.equal(stripReplyPrefix('回复 @某用户 :确实'), '确实')
  assert.equal(stripReplyPrefix('我想回复 @某用户 :好'), '我想回复 @某用户 :好')
})

test('isLowInfo：去掉表情和标点后不超过 3 个字', () => {
  for (const text of ['哈哈哈哈哈', '666666', '[笑哭][笑哭]', '牛！', '+1', '']) assert.equal(isLowInfo(text), true, text)
  for (const text of ['价格太贵', '讲得很清楚', '[笑哭]太真实了']) assert.equal(isLowInfo(text), false, text)
})

test('normalizeText：去掉回复前缀和链接，全角转半角，英文转小写', () => {
  assert.equal(normalizeText('回复 @某用户 :ＵＰ主  讲得好 https://b23.tv/abc'), 'up主 讲得好')
  assert.equal(normalizeText('回复@张三：好'), '好')
})

test('dedupeKey：标点、空格、重复字的差异不影响判断是不是同一句', () => {
  assert.equal(dedupeKey('老尼！'), dedupeKey('老尼'))
  assert.equal(dedupeKey('哈哈哈哈哈哈'), dedupeKey('哈哈哈哈'))
  assert.notEqual(dedupeKey('哈哈'), dedupeKey('哈哈哈'))
  assert.equal(dedupeKey('6 6 6 6 6'), dedupeKey('66666'))
  assert.equal(dedupeKey('！！！'), '')
})

test('stripEmoji：去掉方括号表情', () => {
  assert.equal(stripEmoji('笑死[笑哭][doge]了').replace(/\s+/g, ''), '笑死了')
})

test('seededRandom：同一个种子得到同一串数，结果在 [0, 1)', () => {
  const a = seededRandom(7)
  const b = seededRandom(7)
  const xs = Array.from({ length: 100 }, () => a())
  assert.deepEqual(xs, Array.from({ length: 100 }, () => b()))
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, seededRandom(8)))
})

test('median', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), 0)
})

test('isJunkWord / STOP_WORDS：过滤不成词的组合，保留实词', () => {
  for (const word of ['好的', '很大', '一', '123', '看不懂']) assert.ok(isJunkWord(word), word)
  for (const word of ['标题党', '肺活量', '国开']) assert.ok(!isJunkWord(word) && !STOP_WORDS.has(word), word)
})
