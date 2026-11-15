import { FEEDBACK_KINDS, type Dataset, type FeedbackKind } from './types.ts'

export interface DatasetStats {
  contents: number
  items: Record<FeedbackKind, number>
  /** 已导入主评论的 reply_count 之和与所有导入回复数（可能含孤立回复），不是全视频覆盖率 */
  replies: { reported: number; collected: number }
  /** 评论、回复、回答的发布时间范围，弹幕没有发布时间 */
  time_range?: { from: string; to: string }
  /** 按出现次数从多到少 */
  locations: Array<{ name: string; count: number }>
  /** 有 IP 属地的条目数，用来判断属地分布有多大代表性 */
  with_location: number
}

export function computeStats(dataset: Dataset, options: { topLocations?: number } = {}): DatasetStats {
  const items = Object.fromEntries(FEEDBACK_KINDS.map((kind) => [kind, 0])) as Record<FeedbackKind, number>
  const replies = { reported: 0, collected: 0 }
  const locations = new Map<string, number>()
  let from: string | undefined
  let to: string | undefined
  let withLocation = 0

  for (const item of dataset.items) {
    items[item.kind]++
    if (item.kind === 'comment') replies.reported += item.reply_count ?? 0
    if (item.kind === 'reply') replies.collected++
    if (item.created_at) {
      if (!from || item.created_at < from) from = item.created_at
      if (!to || item.created_at > to) to = item.created_at
    }
    const location = item.author?.location
    if (location) {
      withLocation++
      locations.set(location, (locations.get(location) ?? 0) + 1)
    }
  }

  return {
    contents: dataset.contents.length,
    items,
    replies,
    time_range: from && to ? { from, to } : undefined,
    locations: [...locations]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, options.topLocations ?? 10),
    with_location: withLocation,
  }
}

/**
 * 占比列表：取前 limit 项，其余合成“其他”，百分比用最大余数法取整，合计正好 100。
 * 分母取 total 与各项之和中较大的一个，统计口径不一致时也不会出现超过 100% 的项。
 */
export function shareRows(rows: ReadonlyArray<{ name: string; count: number }>, total: number, limit: number): Array<{ name: string; count: number; percent: number; other?: true }> {
  const listed = rows.slice(0, limit)
  const sum = rows.reduce((s, r) => s + r.count, 0)
  const denominator = Math.max(total, sum)
  if (denominator <= 0) return []
  const other = denominator - listed.reduce((s, r) => s + r.count, 0)
  const all: Array<{ name: string; count: number; other?: true }> = other > 0 ? [...listed, { name: '其他', count: other, other: true }] : [...listed]
  const exact = all.map((r) => (r.count / denominator) * 100)
  const percents = exact.map(Math.floor)
  let left = 100 - percents.reduce((s, p) => s + p, 0)
  for (const i of exact.map((x, i) => i).sort((a, b) => (exact[b]! - percents[b]!) - (exact[a]! - percents[a]!))) {
    if (left <= 0) break
    percents[i]!++
    left--
  }
  return all.map((r, i) => ({ ...r, percent: percents[i]! }))
}
