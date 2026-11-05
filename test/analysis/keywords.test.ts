import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTerms, createTokenizer, createTokenizerFor, discoverWords, distinctiveTerms, topTerms } from '../../src/analysis/keywords.ts'

const FILLERS = ['今天天气', '我们一起', '看看这个', '真的不错', '晚上吃饭', '路上小心', '明天再说', '早点睡吧']

/**
 * 每条都由一个“新词”和不同的上下文拼成，新词的左右邻字各不相同。
 * 语料很小，新词占比很高，凝固度达不到为真实数据设的默认阈值，所以测试里调低 minPmi。
 */
const SMALL = { minCount: 5, minPmi: 3 }
function corpus(word: string, times: number): string[] {
  return Array.from({ length: times }, (_, i) => `${FILLERS[i % FILLERS.length]}${word}${FILLERS[(i * 3 + 1) % FILLERS.length]}`)
}

test('discoverWords：找出反复出现、内部结合紧、左右搭配多样的片段', () => {
  const words = discoverWords(corpus('标题党', 40), SMALL)
  assert.ok(words.some((w) => w.word === '标题党'), words.map((w) => w.word).join(' '))
  assert.ok(!words.some((w) => w.word === '题党' || w.word === '标题'), '只保留长词')
  const found = words.find((w) => w.word === '标题党')!
  assert.equal(found.count, 40)
  assert.ok(found.pmi > 0 && found.entropy > 0)
})

test('discoverWords：忽略表情、停用词和出现次数不够的片段', () => {
  const texts = Array.from({ length: 30 }, (_, i) => `${FILLERS[i % 8]}[笑哭]${FILLERS[(i + 3) % 8]}`)
  assert.ok(!discoverWords(texts, SMALL).some((w) => w.word.includes('笑哭')))
  assert.deepEqual(discoverWords(['只出现一次的句子'], { minCount: 3 }), [])
  assert.deepEqual(discoverWords([]), [])
})

test('createTokenizer：词典里的词不会被拆开，停用词和不成词的片段被去掉', () => {
  const plain = createTokenizer()
  assert.ok(!plain.tokenize('国开怎么报比较靠谱').includes('国开'), 'Intl.Segmenter 默认会拆开')
  const tokenizer = createTokenizer({ words: ['国开', '靠谱'] })
  const tokens = tokenizer.tokenize('国开怎么报比较靠谱[doge]')
  assert.ok(tokens.includes('国开') && tokens.includes('靠谱'), tokens.join('/'))
  assert.ok(!tokens.includes('怎么') && !tokens.includes('比较'))
  assert.ok(!tokens.some((t) => t.includes('doge')))
  assert.deepEqual(createTokenizer({ stopWords: ['国开'], words: ['国开'] }).tokenize('国开'), [])
})

test('createTokenizerFor：发现的新词直接用于分词', () => {
  const texts = corpus('肺活量', 30)
  const { tokenizer, words } = createTokenizerFor(texts, SMALL)
  assert.ok(words.some((w) => w.word === '肺活量'))
  assert.ok(tokenizer.tokenize(texts[0]!).includes('肺活量'))
})

test('countTerms：一条内容里出现多次只算一次，ID 按传入顺序记录', () => {
  const tokenizer = createTokenizer({ words: ['标题党'] })
  const counts = countTerms(
    [
      { id: 'a', text: '标题党标题党标题党' },
      { id: 'b', text: '又是标题党' },
      { id: 'c', text: '讲得清楚' },
    ],
    tokenizer,
    { idsPerTerm: 1 },
  )
  assert.equal(counts.docs, 3)
  assert.equal(counts.df.get('标题党'), 2)
  assert.deepEqual(counts.ids.get('标题党'), ['a'])
  assert.equal(topTerms(counts, 1)[0]?.word, '标题党')
})

test('distinctiveTerms：目标部分特有的词排在前面，两边都常见的词不算', () => {
  const tokenizer = createTokenizer({ words: ['退钱', '画质', '好看'] })
  const doc = (id: number, text: string) => ({ id: String(id), text })
  const target = countTerms(
    Array.from({ length: 20 }, (_, i) => doc(i, i % 2 ? '退钱 好看' : '退钱')),
    tokenizer,
  )
  const rest = countTerms(
    Array.from({ length: 80 }, (_, i) => doc(i + 100, i % 2 ? '画质 好看' : '好看')),
    tokenizer,
  )
  const terms = distinctiveTerms(target, rest)
  assert.equal(terms[0]?.word, '退钱')
  assert.ok(!terms.some((t) => t.word === '画质'), '目标里没有的词不出现')
  const common = terms.find((t) => t.word === '好看')
  assert.ok(!common || common.z < terms[0]!.z)
  assert.deepEqual(distinctiveTerms(countTerms([], tokenizer), rest), [])
})
