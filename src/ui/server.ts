import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
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
import { createChatHub, type ChatModels } from './chat.ts'
import { HttpError } from './http.ts'
import { createNativePicker, type NativePicker, type PickKind } from './picker.ts'

/**
 * 本地图形界面（roadmap 第 19 步）。只监听 127.0.0.1；接口要求启动时生成的令牌，并检查 Host，
 * 防止其他网页借浏览器调用本地接口。只读取启动目录内的文件和用户在选择框里选中（或上传）的文件。
 * 设计见 docs/architecture.md 第 2.1 节。
 */

const STATIC_DIR = new URL('../../ui/', import.meta.url)
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const DATA_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.txt', '.md', '.markdown', '.log'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.ugc-lens'])
const MAX_LIST = 300
const MAX_REPORT_BYTES = 2 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const MAX_RECENT = 20

export interface UiServerOptions {
  cwd: string
  staticDir?: string
  token?: string
  /** 测试注入；默认按需读取 ugc-lens 的模型配置，只在缓存和内置规则都不适用时识别结构 */
  model?: AgentModel
  /** 原生文件选择框；测试注入 */
  picker?: NativePicker
  /** 最近打开记录和浏览器上传的文件保存在 <homeDir>/.ugc-lens/ui/，默认用户主目录 */
  homeDir?: string
  /** 对话使用的模型；测试注入，默认新建对话时读取 ugc-lens 的模型配置 */
  chatModels?: () => ChatModels
}

interface RecentFile { path: string; kind: PickKind; opened_at: string }

export interface UiServer {
  server: Server
  token: string
  url: (port: number) => string
  /** 关闭所有对话会话（取消进行中的回答和后台监听），不关闭 HTTP 服务 */
  close: () => Promise<void>
}


function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

/**
 * 解析为真实路径：启动目录内的文件可以直接读；目录外只允许用户在选择框里选中过的文件
 * （按真实路径记录，符号链接指向目录外同样拒绝）
 */
async function allowedPath(cwd: string, path: string, picked: Set<string>): Promise<string> {
  const root = await realpath(cwd)
  let target: string
  try { target = await realpath(isAbsolute(path) ? path : join(root, path)) } catch { throw new HttpError(404, `文件不存在：${path}`) }
  if (picked.has(target)) return target
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(403, '只能访问启动目录内的文件，其他位置的文件请用“选择文件”打开')
  return target
}

function defaultChatModels(cwd: string): ChatModels {
  let config
  try { config = loadLlmConfig({}, cwd) } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${error.message}。对话需要模型，请先运行 ugc-lens init 配置模型`)
    throw error
  }
  const client = createChatClient(config)
  return {
    ask: createLlmModel(client, { temperature: 0.2 }),
    analysis: createLlmModel(client, { temperature: 0, maxTokens: 4_000, disableThinking: true }),
    name: config.model,
  }
}

/** 上传的文件名只保留最后一段，去掉控制字符和路径分隔符 */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'upload.json'
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
  const uiDir = join(options.homeDir ?? homedir(), '.ugc-lens', 'ui')
  const recentFile = join(uiDir, 'recent.json')
  const picker = options.picker ?? createNativePicker()
  const picked = new Set<string>()
  let recent: RecentFile[] | undefined
  const loadRecent = async (): Promise<RecentFile[]> => {
    if (recent) return recent
    try {
      const parsed = JSON.parse(await readFile(recentFile, 'utf8')) as unknown
      recent = Array.isArray(parsed) ? parsed.filter((r): r is RecentFile => typeof r?.path === 'string' && (r.kind === 'data' || r.kind === 'report')).slice(0, MAX_RECENT) : []
    } catch { recent = [] }
    for (const r of recent) picked.add(r.path)
    return recent
  }
  const remember = async (path: string, kind: PickKind): Promise<void> => {
    const list = await loadRecent()
    picked.add(path)
    recent = [{ path, kind, opened_at: new Date().toISOString() }, ...list.filter((r) => r.path !== path)].slice(0, MAX_RECENT)
    await mkdir(uiDir, { recursive: true, mode: 0o700 })
    await writeFile(recentFile, JSON.stringify(recent, null, 2), { mode: 0o600 })
  }
  const resolvePath = async (path: string) => { await loadRecent(); return allowedPath(cwd, path, picked) }
  const chat = createChatHub({
    cwd, homeDir: options.homeDir, models: options.chatModels ?? (() => defaultChatModels(cwd)),
  })
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
      const recentFiles = []
      for (const r of await loadRecent()) {
        const info = await stat(r.path).catch(() => undefined)
        if (info?.isFile()) recentFiles.push({ path: r.path, kind: r.kind, size: info.size, mtime: info.mtime.toISOString(), opened_at: r.opened_at })
      }
      return json(res, { cwd, picker: picker.available, recent: recentFiles, files: await listFiles(cwd, (name) => DATA_EXTENSIONS.has(extname(name).toLowerCase()) && !name.endsWith('.records.jsonl'), 4) })
    }
    if (req.method === 'POST' && parts[0] === 'pick') {
      const body = await readBody(req) as { kind?: unknown }
      const kind: PickKind = body.kind === 'report' ? 'report' : 'data'
      const chosen = await picker.pick(kind)
      if (chosen === undefined) throw new HttpError(501, '无法弹出系统文件选择框，请在浏览器里选择文件')
      if (chosen === null) return json(res, { cancelled: true })
      let path: string
      try { path = await realpath(chosen) } catch { throw new HttpError(404, `文件不存在：${chosen}`) }
      if (!(await stat(path)).isFile()) throw new HttpError(400, '请选择文件')
      await remember(path, kind)
      return json(res, { path })
    }
    if (req.method === 'POST' && parts[0] === 'upload') {
      // 浏览器选择的文件只有内容没有路径：保存到用户目录下按内容哈希区分的位置，再像普通文件一样打开
      const name = safeName(q.get('name') ?? '')
      if (!DATA_EXTENSIONS.has(extname(name).toLowerCase())) throw new HttpError(400, `不支持的文件类型：${name}`)
      const declared = Number(req.headers['content-length'])
      if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, '文件超过 512 MB')
      await mkdir(uiDir, { recursive: true, mode: 0o700 })
      const temp = join(uiDir, `.upload-${randomBytes(6).toString('hex')}`)
      const hash = createHash('sha256')
      let size = 0
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length
          if (size > MAX_UPLOAD_BYTES) return done(new HttpError(413, '文件超过 512 MB'))
          hash.update(chunk)
          done(null, chunk)
        },
      })
      try {
        await pipeline(req, meter, createWriteStream(temp, { mode: 0o600 }))
        const dir = join(uiDir, 'uploads', hash.digest('hex').slice(0, 16))
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const target = join(dir, name)
        await rename(temp, target)
        const path = await realpath(target)
        await remember(path, 'data')
        return json(res, { path })
      } finally { await rm(temp, { force: true }) }
    }
    if (parts[0] === 'chat') {
      if (req.method === 'POST' && parts.length === 1) return json(res, { id: chat.create() })
      if (req.method === 'POST' && parts[1] && parts[2] === 'messages' && parts.length === 3) {
        const body = await readBody(req) as { text?: unknown; dataset_id?: unknown }
        const attached = typeof body.dataset_id === 'string' ? datasets.get(body.dataset_id) : undefined
        return chat.send(parts[1], { text: body.text, dataset: attached }, req, res)
      }
      if (req.method === 'DELETE' && parts[1] && parts.length === 2) { await chat.remove(parts[1]); return json(res, { ok: true }) }
    }
    if (req.method === 'GET' && parts[0] === 'datasets' && parts.length === 1) {
      return json(res, [...datasets.values()].map((d) => ({ id: d.id, file: d.file_path, title: d.contents[0]?.title, items: d.items.length })))
    }
    if (req.method === 'POST' && parts[0] === 'open') {
      const body = await readBody(req) as { path?: unknown }
      if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, '需要 path')
      const file = await resolvePath(body.path)
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
      const file = await resolvePath(path)
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
      const path = decodeURIComponent(url.pathname)
      const name = path === '/' ? 'index.html' : path.slice(1)
      if (req.method !== 'GET' || (!['index.html'].includes(name) && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|woff2)$/.test(name))) throw new HttpError(404, '未找到')
      let content: Buffer
      try { content = await readFile(options.staticDir ? join(options.staticDir, name) : new URL(name, STATIC_DIR)) } catch { throw new HttpError(404, '界面文件未构建，请先运行 npm run build') }
      return send(res, 200, content, TYPES[extname(name)])
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
  return { server, token, url: (p) => `http://127.0.0.1:${p}/#token=${token}`, close: () => chat.close() }
}
