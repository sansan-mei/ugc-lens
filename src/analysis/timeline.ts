import { median } from './text.ts'

/** 时间轴大约分成 150 段，每段 5～60 秒，取 5 的倍数 */
export function chooseBinSeconds(durationSec: number): number {
  const raw = durationSec / 150
  return Math.min(60, Math.max(5, Math.round(raw / 5) * 5))
}

/** 每段的条数，第 i 段覆盖 [i·binSec, (i+1)·binSec) */
export function binCounts(seconds: Iterable<number>, binSec: number): number[] {
  const counts: number[] = []
  for (const sec of seconds) {
    if (!(sec >= 0)) continue
    const index = Math.floor(sec / binSec)
    while (counts.length <= index) counts.push(0)
    counts[index]!++
  }
  return counts
}

export interface Peak {
  start_sec: number
  end_sec: number
  /** 这个时段里的总条数 */
  count: number
  /** 平均每段多少条，用来对比 */
  baseline: number
  /** 时段内最高一段的稳健 z 分数 */
  z: number
}

/**
 * 找出明显高于平常的时段。用中位数和 MAD（绝对中位差）算稳健 z 分数
 * （Iglewicz & Hoaglin 的修正 z 分数，默认阈值 3.5），不会被几个极端高峰拉高基准。
 * 相邻的高峰段合并成一个时段，按总条数从多到少返回。
 */
export function detectPeaks(
  counts: readonly number[],
  binSec: number,
  options: { minZ?: number; minCount?: number; limit?: number } = {},
): Peak[] {
  if (counts.length === 0) return []
  const minZ = options.minZ ?? 3.5
  const med = median(counts)
  const deviations = counts.map((c) => Math.abs(c - med))
  let scale = 1.4826 * median(deviations)
  // 大部分时段条数相同（如都是 0）时 MAD 为 0，退回平均绝对偏差
  if (scale === 0) scale = 1.2533 * (deviations.reduce((s, d) => s + d, 0) / counts.length)
  if (scale === 0) return []
  const minCount = options.minCount ?? Math.max(3, 2 * med)
  const baseline = counts.reduce((s, c) => s + c, 0) / counts.length

  const peaks: Peak[] = []
  let current: Peak | undefined
  counts.forEach((count, index) => {
    const z = (count - med) / scale
    if (z >= minZ && count >= minCount) {
      if (current && current.end_sec === index * binSec) {
        current.end_sec += binSec
        current.count += count
        current.z = Math.max(current.z, z)
      } else {
        current = { start_sec: index * binSec, end_sec: (index + 1) * binSec, count, baseline, z }
        peaks.push(current)
      }
    } else {
      current = undefined
    }
  })
  return peaks.sort((a, b) => b.count - a.count).slice(0, options.limit ?? 5)
}
