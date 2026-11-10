import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunEvent } from '../agent/events.ts'
import type { AgentModel } from '../agent/model.ts'
import { createSession, type ChatSession } from '../chat/session.ts'
import type { Dataset } from '../dataset/types.ts'
import type { ChatMessage } from '../llm/types.ts'
import { HttpError } from './http.ts'

/**
 * 界面里的对话（roadmap 第 19 步第二阶段）。每个会话就是命令行对话的 ChatSession，
 * 一轮回答以 NDJSON 流式返回：正文片段、工具进度，最后一行是 done 或 error。
 * 浏览器断开即取消本轮。文件访问与命令行对话相同，不限于启动目录。
 * 每轮结束后保存到 <homeDir>/.ugc-lens/ui/chats/：<id>.json 是界面显示用的记录，
 * <id>.messages.json 是模型历史，服务重启或会话被回收后据此恢复，继续追问。
 */

export interface ChatModels { ask: AgentModel; analysis: AgentModel; name?: string }

export type ChatStreamEvent =
  | { type: 'step'; step: number }
  | { type: 'delta'; step: number; text: string }
  | { type: 'tool'; step: number; call_id: string; name: string; args: string }
  | { type: 'tool_end'; call_id: string; name: string; ok: boolean }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'warning'; message: string }
  | { type: 'done'; answer: string; stop_reason: string; citations: { valid: string[]; invalid: string[] }; known_tokens: number; unknown_calls: number }
  | { type: 'error'; message: string }

export interface StoredAssistantTurn {
  role: 'assistant'
  text: string
  status: 'done' | 'error' | 'stopped'
  tools: Array<{ call_id: string; name: string; args: string; ok?: boolean }>
  warnings: string[]
  citations?: { valid: string[]; invalid: string[] }
  stop_reason?: string
  tokens?: number
  error?: string
}
export type StoredTurn = { role: 'user'; text: string } | StoredAssistantTurn

export interface StoredChat { id: string; title: string; cwd: string; created_at: string; updated_at: string; turns: StoredTurn[] }
export interface ChatSummary { id: string; title: string; cwd: string; updated_at: string; turns: number }

export interface ChatHubOptions {
  cwd: string
  homeDir: string
  models: () => ChatModels
  maxSessions?: number
}

interface Entry { session: ChatSession; busy: boolean; record?: StoredChat; listener?: (event: ChatStreamEvent) => void }

export interface ChatHub {
  create(): string
  /** display 是界面上显示的原话（如斜杠命令），text 是发给模型的内容 */
  send(id: string, body: { text?: unknown; display?: unknown; dataset?: Dataset }, req: IncomingMessage, res: ServerResponse): Promise<void>
  list(): Promise<ChatSummary[]>
  get(id: string): Promise<StoredChat>
  /** 关闭会话并删除保存的历史 */
  remove(id: string): Promise<void>
  close(): Promise<void>
}

const ID = /^[A-Za-z0-9_-]{8,32}$/
const MAX_LISTED = 200

function toStreamEvent(event: RunEvent): ChatStreamEvent | undefined {
  switch (event.type) {
    case 'model_start': return { type: 'step', step: event.step }
    case 'model_delta': return { type: 'delta', step: event.step, text: event.text }
    case 'tool_start': return { type: 'tool', step: event.step, call_id: event.call_id, name: event.name, args: JSON.stringify(event.args ?? {}).slice(0, 300) }
    case 'tool_end': return { type: 'tool_end', call_id: event.call_id, name: event.name, ok: event.ok }
    case 'model_retry': return { type: 'retry', attempt: event.attempt, reason: event.reason }
    default: return undefined
  }
}

export function createChatHub(options: ChatHubOptions): ChatHub {
  const sessions = new Map<string, Entry>()
  const max = options.maxSessions ?? 8
  const dir = join(options.homeDir, '.ugc-lens', 'ui', 'chats')
  const recordFile = (id: string) => join(dir, `${id}.json`)
  const messagesFile = (id: string) => join(dir, `${id}.messages.json`)

  const writeAtomic = async (file: string, value: unknown) => {
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, file)
  }
  const readRecord = async (id: string): Promise<StoredChat | undefined> => {
    if (!ID.test(id)) return undefined
    try { return JSON.parse(await readFile(recordFile(id), 'utf8')) as StoredChat } catch { return undefined }
  }

  const open = (id: string, history?: ChatMessage[], record?: StoredChat): Entry => {
    const models = options.models()
    const entry: Entry = { session: undefined as unknown as ChatSession, busy: false, record }
    entry.session = createSession({
      model: models.ask, analysisModel: models.analysis, modelName: models.name, cwd: options.cwd, stream: true, history,
      memory: { cwd: options.cwd, homeDir: options.homeDir, onWarning: (message) => entry.listener?.({ type: 'warning', message }) },
      onEvent: (event) => { const mapped = toStreamEvent(event); if (mapped) entry.listener?.(mapped) },
    })
    sessions.set(id, entry)
    // 超出上限时关闭最早的空闲会话；历史已保存，再发消息时从磁盘恢复
    for (const [oldId, old] of sessions) {
      if (sessions.size <= max) break
      if (!old.busy && oldId !== id) { sessions.delete(oldId); void old.session.close() }
    }
    return entry
  }

  const resume = async (id: string): Promise<Entry> => {
    const live = sessions.get(id)
    if (live) return live
    const record = await readRecord(id)
    if (!record) throw new HttpError(404, '对话不存在或已删除，请新建对话')
    let history: ChatMessage[] = []
    try { history = JSON.parse(await readFile(messagesFile(id), 'utf8')) as ChatMessage[] } catch { /* 只有显示记录时从空历史继续 */ }
    return sessions.get(id) ?? open(id, history, record)
  }

  const save = async (id: string, entry: Entry, display: string, turn: StoredAssistantTurn, messages?: ChatMessage[]) => {
    // 对话在本轮进行中被删除时不再写回
    if (sessions.get(id) !== entry) return
    const now = new Date().toISOString()
    const record = entry.record ??= { id, title: display.replace(/\s+/g, ' ').slice(0, 40), cwd: options.cwd, created_at: now, updated_at: now, turns: [] }
    record.turns.push({ role: 'user', text: display }, turn)
    record.updated_at = now
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (messages) await writeAtomic(messagesFile(id), messages)
    await writeAtomic(recordFile(id), record)
  }

  return {
    create() {
      const id = randomBytes(9).toString('base64url')
      open(id)
      return id
    },

    async send(id, body, req, res) {
      if (!ID.test(id)) throw new HttpError(404, '对话不存在')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) throw new HttpError(400, '消息不能为空')
      if (text.length > 8000) throw new HttpError(413, '消息超过 8000 字')
      const display = typeof body.display === 'string' && body.display.trim() ? body.display.trim().slice(0, 8000) : text
      const entry = await resume(id)
      if (entry.busy) throw new HttpError(409, '请等待上一轮回答完成')
      entry.busy = true
      if (body.dataset) entry.session.attach(body.dataset)
      const controller = new AbortController()
      let finished = false
      const onClose = () => { if (!finished) controller.abort() }
      res.on('close', onClose)
      req.on('aborted', onClose)
      const turn: StoredAssistantTurn = { role: 'assistant', text: '', status: 'stopped', tools: [], warnings: [] }
      const write = (event: ChatStreamEvent) => {
        if (event.type === 'tool') turn.tools.push({ call_id: event.call_id, name: event.name, args: event.args })
        if (event.type === 'tool_end') { const t = turn.tools.find((x) => x.call_id === event.call_id); if (t) t.ok = event.ok }
        if (event.type === 'warning') turn.warnings.push(event.message)
        if (event.type === 'step' || event.type === 'retry') turn.text = ''
        if (event.type === 'delta') turn.text += event.text
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`)
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      })
      entry.listener = write
      let messages: ChatMessage[] | undefined
      try {
        const result = await entry.session.ask(text, controller.signal)
        messages = result.messages.filter((m) => m.role !== 'system')
        if (result.profile_learning?.warning) write({ type: 'warning', message: result.profile_learning.warning })
        if (result.memory_warning) write({ type: 'warning', message: result.memory_warning })
        if (result.stop_reason !== 'aborted') Object.assign(turn, { text: result.answer, status: 'done', citations: result.citations, stop_reason: result.stop_reason, tokens: result.task_usage.known_tokens })
        write({ type: 'done', answer: result.answer, stop_reason: result.stop_reason, citations: result.citations, known_tokens: result.task_usage.known_tokens, unknown_calls: result.task_usage.unknown_calls })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        Object.assign(turn, { status: controller.signal.aborted ? 'stopped' : 'error', error: message })
        write({ type: 'error', message })
      } finally {
        finished = true
        entry.listener = undefined
        // 先保存再结束响应，浏览器收到结束后立即追问或刷新历史都能看到本轮
        await save(id, entry, display, turn, messages).catch(() => { /* 保存失败不影响本轮回答 */ })
        entry.busy = false
        res.off('close', onClose)
        res.end()
      }
    },

    async list() {
      const names = await readdir(dir).catch(() => [] as string[])
      const ids = names.filter((n) => n.endsWith('.json') && !n.endsWith('.messages.json')).map((n) => n.slice(0, -5))
      const records = await Promise.all(ids.map(readRecord))
      return records.filter((r): r is StoredChat => !!r)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, MAX_LISTED)
        .map((r) => ({ id: r.id, title: r.title, cwd: r.cwd, updated_at: r.updated_at, turns: r.turns.length }))
    },

    async get(id) {
      const record = sessions.get(id)?.record ?? await readRecord(id)
      if (!record) throw new HttpError(404, '对话不存在或已删除')
      return record
    },

    async remove(id) {
      if (!ID.test(id)) throw new HttpError(404, '对话不存在')
      const entry = sessions.get(id)
      sessions.delete(id)
      await entry?.session.close()
      await rm(recordFile(id), { force: true })
      await rm(messagesFile(id), { force: true })
    },

    async close() {
      const all = [...sessions.values()]
      sessions.clear()
      await Promise.all(all.map((entry) => entry.session.close()))
    },
  }
}
