import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_RETRY_POLICY,
  isRetryableStatus,
  parseRetryAfter,
  retryDelay,
  withRetry,
  type RetryInfo,
  type RetryPolicy,
  type RetryableError,
} from '../../src/llm/retry.ts'

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0 }
const fast: RetryPolicy = { ...policy, baseDelayMs: 1, maxDelayMs: 2 }

function failure(retryable: boolean, message = 'boom'): RetryableError {
  return Object.assign(new Error(message), { retryable })
}

describe('isRetryableStatus', () => {
  test('408、429、5xx 重试，其他 4xx 不重试', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true, String(status))
    for (const status of [400, 401, 402, 403, 404, 422]) assert.equal(isRetryableStatus(status), false, String(status))
  })
})

describe('parseRetryAfter', () => {
  test('retry-after-ms 优先，其次 Retry-After 秒数或 HTTP 日期', () => {
    assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' })), 250)
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': '3' })), 3_000)
    const now = Date.parse('2026-11-05T00:00:00Z')
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': 'Thu, 05 Nov 2026 00:00:10 GMT' }), now), 10_000)
  })

  test('缺失或无法解析时返回 undefined', () => {
    assert.equal(parseRetryAfter(new Headers()), undefined)
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': 'soon' })), undefined)
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': '-1' })), undefined)
  })
})

describe('retryDelay', () => {
  test('指数退避，不超过上限', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelay(n, failure(true), policy)), [100, 200, 400, 800, 1_000])
  })

  test('抖动最多减少 25%', () => {
    const low = retryDelay(1, failure(true), { ...policy, random: () => 0.999 })
    assert.ok(low >= 75 && low <= 100)
  })

  test('Retry-After 在允许范围内时照办，太长时改用退避时间', () => {
    assert.equal(retryDelay(1, { ...failure(true), retryAfterMs: 5_000 }, policy), 5_000)
    assert.equal(retryDelay(1, { ...failure(true), retryAfterMs: 3_600_000 }, policy), 100)
  })
})

describe('withRetry', () => {
  test('暂时性错误重试后成功，每次重试前通知', async () => {
    let calls = 0
    const retries: RetryInfo[] = []
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw failure(true)
        return 'ok'
      },
      { policy: fast, onRetry: (info) => retries.push(info) },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
    assert.deepEqual(retries.map((r) => r.attempt), [1, 2])
  })

  test('超过最大次数后抛出最后一次的错误，并注明重试次数', async () => {
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls++
        throw failure(true, 'HTTP 503')
      }, { policy: { ...fast, maxRetries: 2 } }),
      /HTTP 503（已重试 2 次）/,
    )
    assert.equal(calls, 3)
  })

  test('不可重试的错误立即抛出', async () => {
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls++
        throw failure(false, 'HTTP 401')
      }, { policy: fast }),
      (error: Error) => error.message === 'HTTP 401',
    )
    assert.equal(calls, 1)
  })

  test('等待期间被取消时立即停止，不再重试', async () => {
    const controller = new AbortController()
    let calls = 0
    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(
      withRetry(async () => {
        calls++
        throw failure(true)
      }, { policy: { ...policy, baseDelayMs: 5_000, maxDelayMs: 5_000 }, signal: controller.signal }),
      { name: 'AbortError' },
    )
    assert.equal(calls, 1)
    assert.ok(Date.now() - startedAt < 1_000)
  })

  test('调用本身因取消失败时不重试', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls++
        throw failure(true)
      }, { policy: fast, signal: controller.signal }),
    )
    assert.equal(calls, 1)
  })
})
