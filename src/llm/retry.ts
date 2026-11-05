import { setTimeout as sleep } from 'node:timers/promises'

export interface RetryPolicy {
  /** 首次请求之外最多再试几次 */
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Retry-After 超过这个值时不再照办，改用退避时间，避免一次等待太久 */
  maxRetryAfterMs: number
  /** 测试时替换，得到确定的等待时间 */
  random: () => number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 60_000,
  random: Math.random,
}

export interface RetryInfo {
  /** 第几次重试，从 1 开始 */
  attempt: number
  delayMs: number
  error: Error
}

/** 带有重试判断信息的错误。只有明确标记为可重试的错误才会重试 */
export interface RetryableError extends Error {
  retryable?: boolean
  retryAfterMs?: number
}

/** 408 请求超时、429 限流、5xx 服务端错误是暂时性的；其余 4xx 重试多少次结果都一样 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** 支持 retry-after-ms（毫秒）和 Retry-After（秒数或 HTTP 日期） */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = Number(headers.get('retry-after-ms'))
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms

  const value = headers.get('retry-after')
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

export function retryDelay(attempt: number, error: RetryableError, policy: RetryPolicy): number {
  const { retryAfterMs } = error
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxRetryAfterMs) return retryAfterMs
  const backoff = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  // 抖动：多个请求同时失败时，不会在同一时刻一起重试
  return Math.round(backoff * (1 - policy.random() * 0.25))
}

export interface WithRetryOptions {
  policy: RetryPolicy
  /** 调用方的取消信号。触发后立即停止，不再重试 */
  signal?: AbortSignal
  onRetry?: (info: RetryInfo) => void
}

export async function withRetry<T>(fn: () => Promise<T>, options: WithRetryOptions): Promise<T> {
  const { policy, signal } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (signal?.aborted) throw error
      const err = error as RetryableError
      if (!err.retryable || attempt > policy.maxRetries) {
        if (attempt > 1 && err instanceof Error) err.message += `（已重试 ${attempt - 1} 次）`
        throw error
      }
      const delayMs = retryDelay(attempt, err, policy)
      options.onRetry?.({ attempt, delayMs, error: err })
      await sleep(delayMs, undefined, { signal })
    }
  }
}
