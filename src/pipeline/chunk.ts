import { groupDanmaku, type DanmakuGroup, type DanmakuSummary } from '../analysis/danmaku.ts'
import { dedupeKey, seededRandom } from '../analysis/text.ts'
import { getFeedback, getReplies } from '../dataset/query.ts'
import type { Dataset, FeedbackItem } from '../dataset/types.ts'
import { clock, compactRepeats, formatItem, oneLine } from '../tools/data/format.ts'

/** 一条一级内容（评论、回答）和它下面的回复，分块时不拆开 */
export interface Thread {
  root: FeedbackItem
  /** 所有层级的回复，点赞多的在前，最多 maxRepliesPerThread 条 */
  replies: FeedbackItem[]
  /** 因为数量上限没放进来的回复 */
  omitted_replies: number
  /** 内容相同、被合并进这一条的其他一级内容条数（复制粘贴的“复读”评论） */
  duplicates: number
  /** 互动热度：log(1+赞) + 0.5·log(1+回复数)，取对数是为了不让一条爆款压过所有内容 */
  score: number
}

export interface Chunk {
  index: number
  kind: 'threads' | 'danmaku'
  lines: string[]
  /** 块里出现的全部 ID，引用校验用 */
  ids: string[]
  chars: number
  /** 这一块代表了多少条原始内容（弹幕按重复次数算） */
  represents: number
}

export interface ChunkPlan {
  chunks: Chunk[]
  coverage: {
    threads_total: number
    /** 因为内容相同被合并掉的一级内容条数 */
    threads_merged: number
    threads_included: number
    /** 评论、回复、回答的总数和放进块里的条数 */
    items_total: number
    items_included: number
    /** 超出字数预算时为 true：按热度保留一部分，其余随机抽样 */
    sampled: boolean
    danmaku_total: number
    danmaku_unique: number
    danmaku_groups_included: number
    /** 放进块里的弹幕组合计代表多少条弹幕 */
    danmaku_represented: number
  }
}

export interface ChunkOptions {
  /** 每块最多多少字符，默认 12000 */
  maxChunkChars?: number
  /** 评论部分的总字符预算，超出时抽样，默认 240000 */
  maxTotalChars?: number
  /** 超出预算时，预算中按热度直接保留的比例，其余随机抽样，默认 0.3 */
  topShare?: number
  maxRepliesPerThread?: number
  /** 最多放进多少组弹幕，默认 300 */
  danmakuGroups?: number
  /** 抽样的随机种子，相同的种子得到相同的分块 */
  seed?: number
  /** 已经算好的弹幕统计，提供时高峰时段的弹幕也会放进去 */
  danmaku?: DanmakuSummary
}

const ROOT_CHARS = 500
const REPLY_CHARS = 200

function engagement(item: FeedbackItem, collectedReplies: number): number {
  return Math.log1p(item.likes ?? 0) + 0.5 * Math.log1p(Math.max(item.reply_count ?? 0, collectedReplies))
}

function descendants(dataset: Dataset, id: string): FeedbackItem[] {
  const result: FeedbackItem[] = []
  const queue = [id]
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const reply of getReplies(dataset, queue.shift()!)) {
      if (seen.has(reply.id)) continue
      seen.add(reply.id)
      result.push(reply)
      queue.push(reply.id)
    }
  }
  return result
}

/** 上一级不在数据里的回复也作为一级内容，不能因为缺了上一级就丢掉 */
export function buildThreads(dataset: Dataset, options: { maxRepliesPerThread?: number } = {}): Thread[] {
  const max = options.maxRepliesPerThread ?? 20
  const roots = dataset.items.filter(
    (item) => item.kind !== 'danmaku' && (item.parent_id === undefined || !getFeedback(dataset, item.parent_id)),
  )
  return roots.map((root) => {
    const all = descendants(dataset, root.id).sort(
      (a, b) => (b.likes ?? 0) - (a.likes ?? 0) || (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    )
    return {
      root,
      replies: all.slice(0, max),
      omitted_replies: Math.max(0, all.length - max),
      duplicates: 0,
      score: engagement(root, all.length),
    }
  })
}

/**
 * 正文相同（按 dedupeKey）的一级内容只保留热度最高的一条，记下重复次数。
 * 被合并的那些的回复不再单独列出。重复越多越优先，因为“很多人说同一句话”本身就是信号。
 */
export function mergeDuplicateThreads(threads: readonly Thread[]): Thread[] {
  const groups = new Map<string, Thread[]>()
  const unique: Thread[] = []
  for (const thread of threads) {
    const key = dedupeKey(thread.root.text)
    if (!key) {
      unique.push(thread)
      continue
    }
    const list = groups.get(key)
    if (list) list.push(thread)
    else groups.set(key, [thread])
  }
  for (const list of groups.values()) {
    const [best, ...rest] = [...list].sort((a, b) => b.score - a.score)
    unique.push(rest.length === 0 ? best! : { ...best!, duplicates: rest.length, score: best!.score + 0.5 * Math.log1p(rest.length) })
  }
  return unique
}

function threadLines(thread: Thread, showContent: boolean): string[] {
  const root = formatItem(thread.root, { maxChars: ROOT_CHARS, showContent, compact: true })
  const lines = [thread.duplicates > 0 ? `${root}（同样内容另有 ${thread.duplicates} 条）` : root]
  for (const reply of thread.replies) lines.push(`  ↳ ${formatItem(reply, { maxChars: REPLY_CHARS, compact: true })}`)
  if (thread.omitted_replies > 0) lines.push(`  ↳ （另有 ${thread.omitted_replies} 条回复未列出）`)
  return lines
}

function cost(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

/** 预算内放不下时：先按热度保留 topShare，剩下的预算随机抽，保证冷门内容也有机会被看到 */
export function selectThreads(
  threads: readonly Thread[],
  costs: ReadonlyMap<Thread, number>,
  budget: number,
  topShare: number,
  seed: number,
): { selected: Thread[]; sampled: boolean } {
  const total = threads.reduce((sum, t) => sum + costs.get(t)!, 0)
  if (total <= budget) return { selected: [...threads].sort((a, b) => b.score - a.score), sampled: false }

  const byScore = [...threads].sort((a, b) => b.score - a.score)
  const selected: Thread[] = []
  let used = 0
  let i = 0
  for (; i < byScore.length && used + costs.get(byScore[i]!)! <= budget * topShare; i++) {
    selected.push(byScore[i]!)
    used += costs.get(byScore[i]!)!
  }
  const rest = byScore.slice(i)
  const random = seededRandom(seed)
  for (let k = rest.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1))
    ;[rest[k], rest[j]] = [rest[j]!, rest[k]!]
  }
  for (const thread of rest) {
    const c = costs.get(thread)!
    if (used + c > budget) continue
    selected.push(thread)
    used += c
  }
  return { selected, sampled: true }
}

function danmakuLine(group: DanmakuGroup): string {
  const time = group.first_sec === undefined ? '' : ` 视频${clock(group.first_sec)}`
  return `[${group.id}] 弹幕×${group.count}${time} ${compactRepeats(oneLine(group.text)).slice(0, REPLY_CHARS)}`
}

/** 依次装块，当前块放不下或类型不同时开新块 */
function chunkBuilder(maxChars: number) {
  const chunks: Chunk[] = []
  let current: Chunk | undefined
  const add = (kind: Chunk['kind'], lines: string[], ids: string[], represents: number): void => {
    const chars = cost(lines)
    if (!current || current.kind !== kind || current.chars + chars > maxChars) {
      current = { index: chunks.length, kind, lines: [], ids: [], chars: 0, represents: 0 }
      chunks.push(current)
    }
    current.lines.push(...lines)
    current.ids.push(...ids)
    current.chars += chars
    current.represents += represents
  }
  return { chunks, add }
}

/** 一条串本身超过一块的上限时，从后往前去掉回复，一级内容总是保留 */
function fitThread(thread: Thread, showContent: boolean, maxChars: number): { lines: string[]; replies: FeedbackItem[] } {
  let replies = thread.replies
  let lines = threadLines(thread, showContent)
  while (cost(lines) > maxChars && replies.length > 0) {
    replies = replies.slice(0, -1)
    lines = threadLines({ ...thread, replies, omitted_replies: thread.omitted_replies + thread.replies.length - replies.length }, showContent)
  }
  return { lines, replies }
}

export function planChunks(dataset: Dataset, options: ChunkOptions = {}): ChunkPlan {
  const maxChunkChars = options.maxChunkChars ?? 12_000
  const showContent = dataset.contents.length > 1
  const allThreads = buildThreads(dataset, options)
  const threads = mergeDuplicateThreads(allThreads)
  const costs = new Map(threads.map((t) => [t, cost(threadLines(t, showContent))]))
  const { selected, sampled } = selectThreads(
    threads,
    costs,
    options.maxTotalChars ?? 240_000,
    options.topShare ?? 0.3,
    options.seed ?? 42,
  )

  const builder = chunkBuilder(maxChunkChars)
  let itemsIncluded = 0
  for (const thread of selected) {
    const { lines, replies } = fitThread(thread, showContent, maxChunkChars)
    const ids = [thread.root.id, ...replies.map((r) => r.id)]
    builder.add('threads', lines, ids, ids.length + thread.duplicates)
    itemsIncluded += ids.length
  }

  const danmaku = dataset.items.filter((item) => item.kind === 'danmaku')
  const groups = options.danmaku?.groups ?? groupDanmaku(danmaku)
  const chosen = new Map<string, DanmakuGroup>()
  for (const group of groups.slice(0, options.danmakuGroups ?? 300)) chosen.set(group.id, group)
  for (const peak of options.danmaku?.peaks ?? []) for (const group of peak.groups) if (!chosen.has(group.id)) chosen.set(group.id, group)
  let represented = 0
  for (const group of chosen.values()) {
    builder.add('danmaku', [danmakuLine(group)], [group.id], group.count)
    represented += group.count
  }

  return {
    chunks: builder.chunks,
    coverage: {
      threads_total: allThreads.length,
      threads_merged: allThreads.length - threads.length,
      threads_included: selected.length,
      items_total: dataset.items.length - danmaku.length,
      items_included: itemsIncluded,
      sampled,
      danmaku_total: danmaku.length,
      danmaku_unique: groups.length,
      danmaku_groups_included: chosen.size,
      danmaku_represented: represented,
    },
  }
}
