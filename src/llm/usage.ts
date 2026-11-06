import type { Usage } from './types.ts'

/** 汇总用量：cached_unreported_calls 固定存在，便于区分“没有调用”和“调用未返回缓存字段” */
export type UsageTotal = Usage & { cached_unreported_calls: number }

export function emptyUsage(): UsageTotal {
  return { input_tokens: 0, output_tokens: 0, cached_unreported_calls: 0 }
}

/**
 * 累加单次响应或子阶段汇总。接口没返回缓存字段时记为未知次数，
 * 不能当成命中 0，否则看不出中转或提供商是否支持缓存统计。
 */
export function addUsage(total: UsageTotal, usage: Usage | undefined): UsageTotal {
  if (!usage) return total
  total.input_tokens += usage.input_tokens
  total.output_tokens += usage.output_tokens
  if (usage.cached_input_tokens !== undefined) total.cached_input_tokens = (total.cached_input_tokens ?? 0) + usage.cached_input_tokens
  total.cached_unreported_calls += usage.cached_unreported_calls ?? (usage.cached_input_tokens === undefined ? 1 : 0)
  return total
}

/** 报告与命令行显示缓存命中：全部未返回为“未知”，部分未返回只给下限 */
export function formatCachedTokens(usage: Usage): string {
  const unreported = usage.cached_unreported_calls ?? (usage.cached_input_tokens === undefined ? 1 : 0)
  if (usage.cached_input_tokens === undefined) return unreported > 0 ? '未知' : '0'
  const value = usage.cached_input_tokens.toLocaleString('zh-CN')
  return unreported > 0 ? `至少 ${value}（${unreported} 次调用未返回）` : value
}
