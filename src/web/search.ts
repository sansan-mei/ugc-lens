import type { WebConfig } from './config.ts'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** 结果来自哪个搜索引擎或服务 */
  engine: string
}

export interface SearchBackend {
  name: string
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]>
}

export class WebError extends Error {
  override name = 'WebError'
}

const SNIPPET_CHARS = 500
const TITLE_CHARS = 200

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function normalize(raw: unknown, engine: (item: Record<string, unknown>) => string, limit: number): SearchHit[] {
  const results = (raw as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) throw new WebError('搜索服务返回的格式不正确：缺少 results')
  const hits: SearchHit[] = []
  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : ''
    if (!/^https?:\/\//i.test(url)) continue
    hits.push({ title: clip(record.title, TITLE_CHARS), url, snippet: clip(record.content, SNIPPET_CHARS), engine: engine(record) })
    if (hits.length >= limit) break
  }
  return hits
}

/** 搜索端点来自可信配置（可以是自建的内网 SearXNG），因此直接用 fetch，不套网页读取的地址限制 */
async function request(url: string, init: RequestInit, config: WebConfig, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, timeout]) })
  } catch (error) {
    if (signal.aborted) throw error
    if (timeout.aborted) throw new WebError(`搜索服务超时（${config.timeoutMs} 毫秒）`)
    throw new WebError(`无法连接搜索服务：${(error as Error).message}`)
  }
  if (response.status === 429) throw new WebError('搜索服务限流（429），请稍后再试')
  if (!response.ok) throw new WebError(`搜索服务返回 ${response.status}`)
  try {
    return await response.json()
  } catch {
    if (timeout.aborted) throw new WebError(`搜索服务超时（${config.timeoutMs} 毫秒）`)
    throw new WebError('搜索服务返回的格式不正确：不是 JSON')
  }
}

export function createSearchBackend(config: WebConfig): SearchBackend {
  if (config.provider === 'tavily') {
    return {
      name: 'tavily',
      async search(query, limit, signal) {
        const raw = await request(`${config.baseUrl}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey ?? ''}` },
          body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false }),
        }, config, signal)
        return normalize(raw, () => 'tavily', limit)
      },
    }
  }
  return {
    name: 'searxng',
    async search(query, limit, signal) {
      const url = new URL(`${config.baseUrl}/search`)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
      const raw = await request(url.href, { method: 'GET', headers }, config, signal)
      return normalize(raw, (item) => typeof item.engine === 'string' ? item.engine : 'searxng', limit)
    },
  }
}
