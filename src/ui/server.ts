import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { contentTimeline } from '../analysis/content_timeline.ts'
import { createLlmModel } from '../agent/llm_model.ts'
import type { AgentModel } from '../agent/model.ts'
import { ConfigError, loadLlmConfig } from '../config.ts'
import { getEvidence } from '../dataset/evidence.ts'
import { getFeedback, getReplies, searchFeedback, type FeedbackSort } from '../dataset/query.ts'
import { FEEDBACK_KINDS, type Dataset, type FeedbackKind } from '../dataset/types.ts'
import { ImportError, loadDataset } from '../ingest/index.ts'
import { createChatClient } from '../llm/client.ts'
import { buildOverview, itemView } from './overview.ts'

/**
 * 本地图形界面（roadmap 第 19 步）。只监听 127.0.0.1；接口要求启动时生成的令牌，并检查 Host，
 * 防止其他网页借浏览器调用本地接口。只读取 cwd 内的文件。设计见 docs/architecture.md 第 2.1 节。
 */

const STATIC_DIR = new URL('../../ui/', import.meta.url)
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/charts.js': 'charts.js', '/markdown.js': 'markdown.js',
}
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const DATA_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.txt', '.md', '.markdown', '.log'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.ugc-lens'])
const MAX_LIST = 300
const MAX_REPORT_BYTES = 2 * 1024 * 1024

export interface UiServerOptions {
  cwd: string
  token?: string
  /** 测试注入；默认按需读取 ugc-lens 的模型配置，只在缓存和内置规则都不适用时识别结构 */
  model?: AgentModel
}

export interface UiServer { server: Server; token: string; url: (port: number) => string }

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  })
  res.end(body)
}

const json = (res: ServerResponse, value: unknown, status = 200) => send(res, status, JSON.stringify(value))

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new HttpError(413, '请求过大')
    chunks.push(chunk as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new HttpError(400, '请求体不是 JSON') }
}

/** 解析为 cwd 内的真实路径；符号链接指向 cwd 外同样拒绝 */
async function insideCwd(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd)
  let target: string
  try { target = await realpath(isAbsolute(path) ? path : join(root, path)) } catch { throw new HttpError(404, `文件不存在：${path}`) }
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(403, '只能访问启动目录内的文件')
  return target
}

async function listFiles(cwd: string, accept: (name: string) => boolean, maxDepth: number): Promise<Array<{ path: string; size: number; mtime: string }>> {
  const root = await realpath(cwd)
  const out: Array<{ path: string; size: number; mtime: string }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_LIST) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= MAX_LIST) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full, depth + 1)
      } else if (entry.isFile() && accept(entry.name)) {
        const info = await stat(full)
        out.push({ path: relative(root, full).split(sep).join('/'), size: info.size, mtime: info.mtime.toISOString() })
      }
    }
  }
  await walk(root, 0)
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

export function createUiServer(options: UiServerOptions): UiServer {
  const cwd = resolve(options.cwd)
  const token = options.token ?? randomBytes(18).toString('base64url')
  const expected = Buffer.from(token)
  const datasets = new Map<string, Dataset>()
  let model: AgentModel | undefined = options.model
  const lazyModel: AgentModel = {
    complete: (request) => {
      if (!model) {
        const config = loadLlmConfig({}, cwd)
        model = createLlmModel(createChatClient(config), { temperature: 0, maxTokens: 4_000, disableThinking: true })
      }
      return model.complete(request)
    },
  }
  let port = 0

  const dataset = (id: string): Dataset => {
    const found = datasets.get(id)
    if (!found) throw new HttpError(404, '数据集未打开或服务已重启，请重新选择文件')
    return found
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
    const q = url.searchParams
    if (req.method === 'GET' && parts[0] === 'files') {
      return json(res, { cwd, files: await listFiles(cwd, (name) => DATA_EXTENSIONS.has(extname(name).toLowerCase()) && !name.endsWith('.records.jsonl'), 4) })
    }
    if (req.method === 'GET' && parts[0] === 'datasets' && parts.length === 1) {
      return json(res, [...datasets.values()].map((d) => ({ id: d.id, file: relative(cwd, d.file_path), title: d.contents[0]?.title, items: d.items.length })))
    }
    if (req.method === 'POST' && parts[0] === 'open') {
      const body = await readBody(req) as { path?: unknown }
      if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, '需要 path')
      const file = await insideCwd(cwd, body.path)
      const loaded = await loadDataset(file, { cacheDir: join(cwd, '.ugc-lens', 'mappings'), model: lazyModel })
      datasets.set(loaded.id, loaded)
      return json(res, await buildOverview(loaded, cwd))
    }
    if (req.method === 'POST' && parts[0] === 'datasets' && parts[1] && parts[2] === 'check-ids') {
      const d = dataset(parts[1])
      const body = await readBody(req) as { ids?: unknown }
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 2000) : []
      return json(res, { existing: ids.filter((id) => getEvidence(d, id)) })
    }
    if (parts[0] === 'datasets' && parts[1] && req.method === 'GET') {
      const d = dataset(parts[1])
      if (parts[2] === 'overview') return json(res, await buildOverview(d, cwd))
      if (parts[2] === 'items' && parts[3]) {
        const evidence = getEvidence(d, parts[3])
        if (!evidence) throw new HttpError(404, `没有 ID ${parts[3]}`)
        const item = getFeedback(d, parts[3])
        const parent = item?.parent_id ? getFeedback(d, item.parent_id) : undefined
        return json(res, { item: item ? itemView(item) : { ...evidence, author: undefined }, parent: parent && itemView(parent), replies: item ? getReplies(d, item.id).map(itemView) : [] })
      }
      if (parts[2] === 'items') {
        const kinds = q.get('kinds')?.split(',').filter((k): k is FeedbackKind => (FEEDBACK_KINDS as readonly string[]).includes(k))
        const sort = (['likes', 'replies', 'newest', 'oldest', 'video_time'] as const).find((s) => s === q.get('sort')) as FeedbackSort | undefined
        const limit = Math.min(Math.max(Number(q.get('limit')) || 30, 1), 100)
        const offset = Math.max(Number(q.get('offset')) || 0, 0)
        const page = searchFeedback(d, { query: q.get('query') ?? undefined, kinds: kinds?.length ? kinds : undefined, sort, limit, offset, location: q.get('location') ?? undefined })
        return json(res, { total: page.total, offset: page.offset, items: page.items.map(itemView) })
      }
      if (parts[2] === 'timeline') {
        const offset = Math.max(Number(q.get('offset')) || 0, 0)
        return json(res, contentTimeline(d, { limit: 100, offset }))
      }
    }
    if (req.method === 'GET' && parts[0] === 'reports' && parts.length === 1) {
      return json(res, { reports: await listFiles(cwd, (name) => /\.(md|markdown)$/i.test(name), 4).then(async (found) => {
        const generated = await listFiles(join(cwd, '.ugc-lens', 'reports'), (name) => name.endsWith('.md'), 0).catch(() => [])
        return [...generated.map((r) => ({ ...r, path: `.ugc-lens/reports/${r.path}` })), ...found]
      }) })
    }
    if (req.method === 'GET' && parts[0] === 'report') {
      const path = q.get('path')
      if (!path || !/\.(md|markdown)$/i.test(path)) throw new HttpError(400, '只能打开 Markdown 报告')
      const file = await insideCwd(cwd, path)
      if ((await stat(file)).size > MAX_REPORT_BYTES) throw new HttpError(413, '报告超过 2 MB')
      return json(res, { path, text: await readFile(file, 'utf8') })
    }
    throw new HttpError(404, '未知接口')
  }

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? ''
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'Host 不被允许')
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname.startsWith('/api/')) {
        const given = Buffer.from(String(req.headers['x-ugc-lens-token'] ?? ''))
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, '令牌无效，请使用启动时打印的完整网址')
        const origin = req.headers.origin
        if (origin && origin !== `http://${host}`) throw new HttpError(403, '来源不被允许')
        return await api(req, res, url)
      }
      const name = req.method === 'GET' ? STATIC_FILES[url.pathname] : undefined
      if (!name) throw new HttpError(404, '未找到')
      return send(res, 200, await readFile(new URL(name, STATIC_DIR)), TYPES[extname(name)])
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ImportError || error instanceof ConfigError ? 422 : 500
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) json(res, { error: status === 500 ? `服务内部错误：${message}` : message }, status)
      else res.end()
    }
  })
  server.on('listening', () => {
    const address = server.address()
    if (address && typeof address === 'object') port = address.port
  })
  return { server, token, url: (p) => `http://127.0.0.1:${p}/#token=${token}` }
}
