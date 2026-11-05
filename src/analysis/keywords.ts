import { isJunkWord, STOP_WORDS } from './stopwords.ts'
import { normalizeText, stripEmoji } from './text.ts'

export interface Doc {
  id: string
  text: string
}

// ---------- 新词发现 ----------

export interface DiscoverOptions {
  /** 最长几个字，默认 4 */
  maxLen?: number
  /** 最少出现次数，默认按语料长度自动确定 */
  minCount?: number
  /** 凝固度下限：log2(P(词) / (P(左半)·P(右半)))，取所有切分方式中最小的 */
  minPmi?: number
  /** 自由度下限：左右相邻字的信息熵中较小的那个（自然对数） */
  minEntropy?: number
  limit?: number
}

export interface DiscoveredWord {
  word: string
  count: number
  pmi: number
  entropy: number
}

function chineseRuns(text: string): string[] {
  return normalizeText(stripEmoji(text)).match(/[\u4e00-\u9fff]{2,}/g) ?? []
}

function entropy(neighbors: Map<string, number>, boundaries: number): number {
  const total = [...neighbors.values()].reduce((sum, n) => sum + n, 0) + boundaries
  if (total === 0) return 0
  let h = 0
  for (const n of neighbors.values()) h -= (n / total) * Math.log(n / total)
  // 句首、句尾每次都算作不同的邻字：出现在边界上说明它能独立使用
  if (boundaries > 0) h += boundaries * (1 / total) * Math.log(total)
  return h
}

/**
 * 从语料本身找出词典里没有的词（网络用语、专有名词，如“国开”“标题党”）。
 * 方法来自 Matrix67《互联网时代的社会语言学：基于 SNS 的文本数据挖掘》：
 * 一个片段内部结合得紧（凝固度高）、左右能搭配很多不同的字（自由度高），就很可能是一个词。
 */
export function discoverWords(texts: Iterable<string>, options: DiscoverOptions = {}): DiscoveredWord[] {
  const maxLen = options.maxLen ?? 4
  const runs: string[] = []
  for (const text of texts) runs.push(...chineseRuns(text))

  const counts = new Map<string, number>()
  let chars = 0
  for (const run of runs) {
    chars += run.length
    for (let i = 0; i < run.length; i++) {
      for (let len = 1; len <= maxLen && i + len <= run.length; len++) {
        const piece = run.slice(i, i + len)
        counts.set(piece, (counts.get(piece) ?? 0) + 1)
      }
    }
  }
  if (chars === 0) return []

  const minCount = options.minCount ?? Math.max(3, Math.round(chars / 20_000))
  const minPmi = options.minPmi ?? 5
  const minEntropy = options.minEntropy ?? 1.5

  const candidates = new Map<string, { count: number; pmi: number }>()
  for (const [piece, count] of counts) {
    if (piece.length < 2 || count < minCount) continue
    if (STOP_WORDS.has(piece) || isJunkWord(piece)) continue
    let pmi = Infinity
    for (let k = 1; k < piece.length; k++) {
      const left = counts.get(piece.slice(0, k))!
      const right = counts.get(piece.slice(k))!
      pmi = Math.min(pmi, Math.log2((count * chars) / (left * right)))
    }
    if (pmi >= minPmi) candidates.set(piece, { count, pmi })
  }

  const left = new Map<string, Map<string, number>>()
  const right = new Map<string, Map<string, number>>()
  const leftEdge = new Map<string, number>()
  const rightEdge = new Map<string, number>()
  const bump = (map: Map<string, Map<string, number>>, word: string, char: string) => {
    let neighbors = map.get(word)
    if (!neighbors) map.set(word, (neighbors = new Map()))
    neighbors.set(char, (neighbors.get(char) ?? 0) + 1)
  }
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      for (let len = 2; len <= maxLen && i + len <= run.length; len++) {
        const piece = run.slice(i, i + len)
        if (!candidates.has(piece)) continue
        if (i > 0) bump(left, piece, run[i - 1]!)
        else leftEdge.set(piece, (leftEdge.get(piece) ?? 0) + 1)
        if (i + len < run.length) bump(right, piece, run[i + len]!)
        else rightEdge.set(piece, (rightEdge.get(piece) ?? 0) + 1)
      }
    }
  }

  const accepted: DiscoveredWord[] = []
  for (const [word, { count, pmi }] of candidates) {
    const h = Math.min(
      entropy(left.get(word) ?? new Map(), leftEdge.get(word) ?? 0),
      entropy(right.get(word) ?? new Map(), rightEdge.get(word) ?? 0),
    )
    if (h >= minEntropy) accepted.push({ word, count, pmi, entropy: h })
  }

  // 短词几乎总是作为某个长词的一部分出现时（如“题党”之于“标题党”），只保留长词
  accepted.sort((a, b) => b.word.length - a.word.length)
  const kept: DiscoveredWord[] = []
  for (const candidate of accepted) {
    if (kept.some((longer) => longer.word.includes(candidate.word) && longer.count >= candidate.count * 0.8)) continue
    kept.push(candidate)
  }
  return kept.sort((a, b) => b.count - a.count).slice(0, options.limit ?? 500)
}

// ---------- 分词 ----------

export interface Tokenizer {
  /** 去掉停用词和不成词的片段，同一个词可能出现多次 */
  tokenize(text: string): string[]
}

const MAX_LATIN_TOKEN = 15

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Intl.Segmenter 的中文分词，加上用户词典保护：词典里的词不会被拆开（Segmenter 会把“国开”拆成“国/开”）。
 * 做法：先按词典切出这些词，剩下的部分再交给 Segmenter。
 */
export function createTokenizer(options: { words?: Iterable<string>; stopWords?: Iterable<string> } = {}): Tokenizer {
  const words = [...new Set(options.words ?? [])].filter((word) => word.length >= 2).sort((a, b) => b.length - a.length)
  const protectedWords = new Set(words)
  const stopWords = new Set([...STOP_WORDS, ...(options.stopWords ?? [])])
  const splitter = words.length > 0 ? new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'g') : undefined
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

  const accept = (token: string, isProtected: boolean): boolean => {
    if (stopWords.has(token)) return false
    if (/^[a-z0-9]+$/.test(token) && token.length > MAX_LATIN_TOKEN) return false
    return isProtected || !isJunkWord(token)
  }

  return {
    tokenize(text) {
      const normalized = normalizeText(stripEmoji(text))
      const parts = splitter ? normalized.split(splitter) : [normalized]
      const tokens: string[] = []
      for (const part of parts) {
        if (!part) continue
        if (protectedWords.has(part)) {
          if (accept(part, true)) tokens.push(part)
          continue
        }
        for (const { segment, isWordLike } of segmenter.segment(part)) {
          const token = segment.trim()
          if (isWordLike && token && accept(token, false)) tokens.push(token)
        }
      }
      return tokens
    },
  }
}

/** 先从这批文本里发现新词，再用它们保护分词 */
export function createTokenizerFor(texts: readonly string[], options: DiscoverOptions = {}): { tokenizer: Tokenizer; words: DiscoveredWord[] } {
  const words = discoverWords(texts, options)
  return { tokenizer: createTokenizer({ words: words.map((w) => w.word) }), words }
}

// ---------- 词频与区分度 ----------

export interface TermCounts {
  /** 文档数 */
  docs: number
  /** 词 → 包含它的文档数（一条内容里出现多次只算一次，避免刷屏的内容占比过高） */
  df: Map<string, number>
  /** 词 → 包含它的前几条内容的 ID，按传入顺序 */
  ids: Map<string, string[]>
}

export function countTerms(docs: Iterable<Doc>, tokenizer: Tokenizer, options: { idsPerTerm?: number } = {}): TermCounts {
  const idsPerTerm = options.idsPerTerm ?? 5
  const df = new Map<string, number>()
  const ids = new Map<string, string[]>()
  let total = 0
  for (const doc of docs) {
    total++
    for (const term of new Set(tokenizer.tokenize(doc.text))) {
      df.set(term, (df.get(term) ?? 0) + 1)
      const list = ids.get(term) ?? []
      if (list.length < idsPerTerm) list.push(doc.id)
      ids.set(term, list)
    }
  }
  return { docs: total, df, ids }
}

export interface TermStat {
  word: string
  docs: number
  ids: string[]
}

export function topTerms(counts: TermCounts, limit = 30): TermStat[] {
  return [...counts.df]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, docs]) => ({ word, docs, ids: counts.ids.get(word) ?? [] }))
}

export interface DistinctiveTerm extends TermStat {
  /** 越大越是这一部分特有的词，2 以上可以认为明显 */
  z: number
}

/**
 * 一部分内容（如弹幕高峰时段、某个主题）相对其余内容特别常用的词。
 * 用带先验的对数几率比（Monroe, Colaresi & Quinn 2008, “Fightin' Words”）：
 * 比单纯比较词频更稳，低频词不会因为偶然出现一两次就排到前面。
 */
export function distinctiveTerms(
  target: TermCounts,
  rest: TermCounts,
  options: { limit?: number; minDocs?: number; prior?: number } = {},
): DistinctiveTerm[] {
  const minDocs = options.minDocs ?? 3
  const a0 = options.prior ?? 100
  const sum = (counts: TermCounts) => [...counts.df.values()].reduce((s, n) => s + n, 0)
  const ni = sum(target)
  const nj = sum(rest)
  const n = ni + nj
  if (ni === 0 || n === 0) return []

  const result: DistinctiveTerm[] = []
  for (const [word, yi] of target.df) {
    if (yi < minDocs) continue
    const yj = rest.df.get(word) ?? 0
    const a = (a0 * (yi + yj)) / n
    const delta = Math.log((yi + a) / (ni + a0 - yi - a)) - Math.log((yj + a) / (nj + a0 - yj - a))
    const z = delta / Math.sqrt(1 / (yi + a) + 1 / (yj + a))
    if (z > 0) result.push({ word, docs: yi, z, ids: target.ids.get(word) ?? [] })
  }
  return result.sort((x, y) => y.z - x.z).slice(0, options.limit ?? 10)
}
