import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSearchBackend } from '../../src/web/search.ts'
import type { WebConfig } from '../../src/web/config.ts'
import { sendJson, startMockServer } from '../helpers/mock_server.ts'

function config(partial: Partial<WebConfig>): WebConfig {
  return { provider: 'searxng', baseUrl: 'http://127.0.0.1:1', maxCalls: 8, timeoutMs: 2_000, maxBytes: 1_000_000, maxChars: 8_000, cacheTtlMs: 3_600_000, ...partial }
}
const signal = () => new AbortController().signal

describe('SearXNG', () => {
  test('GET /search?format=json，统一结果字段并限制条数，没有 key 时不带认证头', async () => {
    const server = await startMockServer((_req, res) => sendJson(res, 200, {
      results: [
        { url: 'https://a.example/1', title: '标题一', content: '摘要'.repeat(400), engine: 'bing' },
        { url: 'https://a.example/2', title: '标题二', content: '摘要二' },
        { url: 'https://a.example/3', title: '标题三', content: '摘要三' },
      ],
    }))
    try {
      const base = new URL(server.baseUrl).origin
      const hits = await createSearchBackend(config({ baseUrl: base })).search('价格 调整', 2, signal())
      assert.equal(hits.length, 2)
      assert.deepEqual(Object.keys(hits[0]!).sort(), ['engine', 'snippet', 'title', 'url'])
      assert.ok(hits[0]!.snippet.length <= 500)
      const url = new URL(server.requests[0]!.url, base)
      assert.equal(server.requests[0]!.method, 'GET')
      assert.equal(url.pathname, '/search')
      assert.equal(url.searchParams.get('q'), '价格 调整')
      assert.equal(url.searchParams.get('format'), 'json')
      assert.equal(server.requests[0]!.headers.authorization, undefined)
    } finally { await server.close() }
  })
})

describe('Tavily', () => {
  test('POST /search 带 Bearer key，请求体包含查询和条数', async () => {
    const server = await startMockServer((_req, res) => sendJson(res, 200, { results: [{ url: 'https://b.example', title: 'B', content: '内容', score: 0.9 }] }))
    try {
      const base = new URL(server.baseUrl).origin
      const hits = await createSearchBackend(config({ provider: 'tavily', baseUrl: base, apiKey: 'tvly-key' })).search('梗 出处', 5, signal())
      assert.deepEqual(hits, [{ title: 'B', url: 'https://b.example', snippet: '内容', engine: 'tavily' }])
      const request = server.requests[0]!
      assert.equal(request.method, 'POST')
      assert.equal(new URL(request.url, base).pathname, '/search')
      assert.equal(request.headers.authorization, 'Bearer tvly-key')
      assert.deepEqual({ query: (request.body as { query: string }).query, max: (request.body as { max_results: number }).max_results }, { query: '梗 出处', max: 5 })
    } finally { await server.close() }
  })

  test('错误状态、限流、非法响应和超时都报错，错误信息不含 key', async () => {
    let mode = 'auth'
    const server = await startMockServer((_req, res) => {
      if (mode === 'auth') sendJson(res, 401, { detail: 'bad key' })
      else if (mode === 'limit') sendJson(res, 429, { detail: 'slow down' })
      else if (mode === 'bad') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json') }
    })
    try {
      const backend = createSearchBackend(config({ provider: 'tavily', baseUrl: new URL(server.baseUrl).origin, apiKey: 'tvly-secret', timeoutMs: 200 }))
      await assert.rejects(backend.search('q', 3, signal()), (error: Error) => /401/.test(error.message) && !error.message.includes('tvly-secret'))
      mode = 'limit'
      await assert.rejects(backend.search('q', 3, signal()), /限流/)
      mode = 'bad'
      await assert.rejects(backend.search('q', 3, signal()), /格式/)
      mode = 'hang'
      await assert.rejects(backend.search('q', 3, signal()), /超时/)
    } finally { await server.close() }
  })
})
