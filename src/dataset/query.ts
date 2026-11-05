import type { Dataset, FeedbackItem, FeedbackKind } from './types.ts'

export type FeedbackSort = 'likes' | 'replies' | 'newest' | 'oldest' | 'video_time'

export interface FeedbackQuery {
  /** 空格分隔的词都要出现；一个词里用 | 分隔表示任意一个出现即可，如 "退钱|骗 标题" */
  query?: string
  kinds?: readonly FeedbackKind[]
  content_id?: string
  parent_id?: string
  min_likes?: number
  /** 日期或时间字符串，按 created_at 筛选；没有发布时间的条目（弹幕）会被排除 */
  since?: string
  until?: string
  location?: string
  sort?: FeedbackSort
  offset?: number
  limit?: number
}

export interface FeedbackPage {
  total: number
  offset: number
  items: FeedbackItem[]
}

interface DatasetIndex {
  byId: Map<string, FeedbackItem>
  children: Map<string, FeedbackItem[]>
  /** 原文里自带的 [xxx]，如 B 站表情 [干杯]、[doge] */
  bracketed: Set<string>
}

const BRACKETED = /\[([^[\]\s]{1,64})\](?!\()/g

const indexes = new WeakMap<Dataset, DatasetIndex>()

function indexOf(dataset: Dataset): DatasetIndex {
  let index = indexes.get(dataset)
  if (!index) {
    const byId = new Map<string, FeedbackItem>()
    const children = new Map<string, FeedbackItem[]>()
    const bracketed = new Set<string>()
    for (const item of dataset.items) {
      byId.set(item.id, item)
      for (const match of item.text.matchAll(BRACKETED)) bracketed.add(match[1]!)
      if (item.parent_id !== undefined) {
        const list = children.get(item.parent_id) ?? []
        list.push(item)
        children.set(item.parent_id, list)
      }
    }
    index = { byId, children, bracketed }
    indexes.set(dataset, index)
  }
  return index
}

function parseTerms(query: string | undefined): string[][] {
  if (!query) return []
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.split('|').filter(Boolean))
    .filter((alternatives) => alternatives.length > 0)
}

function parseTime(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw new Error(`${name} 不是有效的日期：${value}`)
  return time
}

const SORTERS: Record<FeedbackSort, (a: FeedbackItem, b: FeedbackItem) => number> = {
  likes: (a, b) => (b.likes ?? -1) - (a.likes ?? -1),
  replies: (a, b) => (b.reply_count ?? -1) - (a.reply_count ?? -1),
  newest: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  oldest: (a, b) => (a.created_at ?? '\uffff').localeCompare(b.created_at ?? '\uffff'),
  video_time: (a, b) => (a.video_time_sec ?? Infinity) - (b.video_time_sec ?? Infinity),
}

export function searchFeedback(dataset: Dataset, query: FeedbackQuery = {}): FeedbackPage {
  const terms = parseTerms(query.query)
  const kinds = query.kinds?.length ? new Set(query.kinds) : undefined
  const since = parseTime(query.since, 'since')
  const until = parseTime(query.until, 'until')
  const offset = query.offset ?? 0
  const limit = query.limit ?? 20

  const matched = dataset.items.filter((item) => {
    if (kinds && !kinds.has(item.kind)) return false
    if (query.content_id !== undefined && item.content_id !== query.content_id) return false
    if (query.parent_id !== undefined && item.parent_id !== query.parent_id) return false
    if (query.min_likes !== undefined && (item.likes ?? 0) < query.min_likes) return false
    if (query.location !== undefined && item.author?.location !== query.location) return false
    if (since !== undefined || until !== undefined) {
      if (!item.created_at) return false
      const time = Date.parse(item.created_at)
      if (since !== undefined && time < since) return false
      if (until !== undefined && time > until) return false
    }
    if (terms.length > 0) {
      const text = item.text.toLowerCase()
      if (!terms.every((alternatives) => alternatives.some((term) => text.includes(term)))) return false
    }
    return true
  })

  // Array.prototype.sort 是稳定排序，同分时保持文件里的顺序
  matched.sort(SORTERS[query.sort ?? 'likes'])
  return { total: matched.length, offset, items: matched.slice(offset, offset + limit) }
}

export function getFeedback(dataset: Dataset, id: string): FeedbackItem | undefined {
  return indexOf(dataset).byId.get(id)
}

/** 直接回复这一条的条目，按时间从早到晚 */
export function getReplies(dataset: Dataset, id: string): FeedbackItem[] {
  return [...(indexOf(dataset).children.get(id) ?? [])].sort(SORTERS.oldest)
}

/**
 * 回答中用 [ID] 引用的条目，区分数据集里存在和不存在的。
 * 不是 ID、但在原文里出现过的方括号内容（模型引用原文时带上的表情）不算引用；Markdown 链接 [文字](地址) 也不算。
 */
export function findCitations(text: string, datasets: readonly Dataset[]): { valid: string[]; invalid: string[] } {
  const ids = new Set<string>()
  for (const match of text.matchAll(BRACKETED)) ids.add(match[1]!)
  const valid: string[] = []
  const invalid: string[] = []
  for (const id of ids) {
    if (datasets.some((dataset) => getFeedback(dataset, id))) valid.push(id)
    else if (!datasets.some((dataset) => indexOf(dataset).bracketed.has(id))) invalid.push(id)
  }
  return { valid, invalid }
}
