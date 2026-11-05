import type { FeedbackItem } from '../dataset/types.ts'
import { countTerms, distinctiveTerms, topTerms, type DistinctiveTerm, type TermStat, type Tokenizer } from './keywords.ts'
import { dedupeKey } from './text.ts'
import { binCounts, chooseBinSeconds, detectPeaks, type Peak } from './timeline.ts'

/** 说的是同一句话的弹幕 */
export interface DanmakuGroup {
  /** 第一次出现的那条的原文 */
  text: string
  count: number
  /** 第一条的 ID，引用时用它 */
  id: string
  /** 第一次出现的视频时间 */
  first_sec?: number
}

export interface DanmakuPeak extends Peak {
  /** 这个时段里重复最多的弹幕 */
  groups: DanmakuGroup[]
  /** 这个时段相对其他时段特有的词 */
  terms: DistinctiveTerm[]
}

export interface DanmakuSummary {
  total: number
  /** 去重后的条数 */
  unique: number
  /** 按重复次数从多到少 */
  groups: DanmakuGroup[]
  bin_sec: number
  /** 每段的弹幕数 */
  timeline: number[]
  peaks: DanmakuPeak[]
  terms: TermStat[]
}

export function groupDanmaku(items: readonly FeedbackItem[]): DanmakuGroup[] {
  const groups = new Map<string, DanmakuGroup>()
  for (const item of items) {
    const key = dedupeKey(item.text)
    if (!key) continue
    const group = groups.get(key)
    if (group) {
      group.count++
      if (item.video_time_sec !== undefined && (group.first_sec === undefined || item.video_time_sec < group.first_sec)) {
        group.first_sec = item.video_time_sec
      }
    } else {
      groups.set(key, { text: item.text, count: 1, id: item.id, first_sec: item.video_time_sec })
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.first_sec ?? 0) - (b.first_sec ?? 0))
}

export interface DanmakuOptions {
  binSec?: number
  peaks?: number
  groupsPerPeak?: number
  terms?: number
}

export function summarizeDanmaku(items: readonly FeedbackItem[], tokenizer: Tokenizer, options: DanmakuOptions = {}): DanmakuSummary {
  const danmaku = items.filter((item) => item.kind === 'danmaku')
  const groups = groupDanmaku(danmaku)
  const timed = danmaku.filter((item) => item.video_time_sec !== undefined)
  const duration = Math.max(0, ...timed.map((item) => item.video_time_sec!))
  const binSec = options.binSec ?? chooseBinSeconds(duration)
  const timeline = binCounts(timed.map((item) => item.video_time_sec!), binSec)
  const docs = (list: readonly FeedbackItem[]) => list.map((item) => ({ id: item.id, text: item.text }))

  const peaks = detectPeaks(timeline, binSec, { limit: options.peaks ?? 5 }).map((peak): DanmakuPeak => {
    const inside = (item: FeedbackItem) => item.video_time_sec! >= peak.start_sec && item.video_time_sec! < peak.end_sec
    const within = timed.filter(inside)
    const outside = timed.filter((item) => !inside(item))
    return {
      ...peak,
      groups: groupDanmaku(within).slice(0, options.groupsPerPeak ?? 8),
      terms: distinctiveTerms(countTerms(docs(within), tokenizer), countTerms(docs(outside), tokenizer), { limit: options.terms ?? 8 }),
    }
  })

  return {
    total: danmaku.length,
    unique: groups.length,
    groups,
    bin_sec: binSec,
    timeline,
    peaks,
    terms: topTerms(countTerms(docs(danmaku), tokenizer), options.terms ?? 20),
  }
}
