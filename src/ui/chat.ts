import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { RunEvent } from '../agent/events.ts'
import type { AgentModel } from '../agent/model.ts'
import { createSession, type ChatSession } from '../chat/session.ts'
import type { Dataset } from '../dataset/types.ts'
import { HttpError } from './http.ts'

/**
 * 界面里的对话（roadmap 第 19 步第二阶段）。每个会话就是命令行对话的 ChatSession，
 * 一轮回答以 NDJSON 流式返回：正文片段、工具进度，最后一行是 done 或 error。
 * 浏览器断开即取消本轮。文件访问与命令行对话相同，不限于启动目录。
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

export interface ChatHubOptions {
  cwd: string
  homeDir?: string
  models: () => ChatModels
  maxSessions?: number
}

interface Entry { session: ChatSession; busy: boolean; listener?: (event: ChatStreamEvent) => void }

export interface ChatHub {
  create(): string
  send(id: string, body: { text?: unknown; dataset?: Dataset }, req: IncomingMessage, res: ServerResponse): Promise<void>
  remove(id: string): Promise<void>
  close(): Promise<void>
}

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

  const remove = async (id: string) => {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    await entry.session.close()
  }

  return {
    create() {
      const models = options.models()
      const id = randomBytes(9).toString('base64url')
      const entry: Entry = { session: undefined as unknown as ChatSession, busy: false }
      entry.session = createSession({
        model: models.ask, analysisModel: models.analysis, modelName: models.name, cwd: options.cwd, stream: true,
        memory: { cwd: options.cwd, homeDir: options.homeDir, onWarning: (message) => entry.listener?.({ type: 'warning', message }) },
        onEvent: (event) => { const mapped = toStreamEvent(event); if (mapped) entry.listener?.(mapped) },
      })
      sessions.set(id, entry)
      // 超出上限时关闭最早且空闲的会话
      for (const [oldId, old] of sessions) {
        if (sessions.size <= max) break
        if (!old.busy && oldId !== id) void remove(oldId)
      }
      return id
    },

    async send(id, body, req, res) {
      const entry = sessions.get(id)
      if (!entry) throw new HttpError(404, '对话不存在或服务已重启，请新建对话')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) throw new HttpError(400, '消息不能为空')
      if (text.length > 8000) throw new HttpError(413, '消息超过 8000 字')
      if (entry.busy) throw new HttpError(409, '请等待上一轮回答完成')
      entry.busy = true
      if (body.dataset) entry.session.attach(body.dataset)
      const controller = new AbortController()
      let finished = false
      const onClose = () => { if (!finished) controller.abort() }
      res.on('close', onClose)
      req.on('aborted', onClose)
      const write = (event: ChatStreamEvent) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`) }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      })
      entry.listener = write
      try {
        const result = await entry.session.ask(text, controller.signal)
        if (result.profile_learning?.warning) write({ type: 'warning', message: result.profile_learning.warning })
        if (result.memory_warning) write({ type: 'warning', message: result.memory_warning })
        write({ type: 'done', answer: result.answer, stop_reason: result.stop_reason, citations: result.citations, known_tokens: result.task_usage.known_tokens, unknown_calls: result.task_usage.unknown_calls })
      } catch (error) {
        write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        finished = true
        entry.listener = undefined
        entry.busy = false
        res.off('close', onClose)
        res.end()
      }
    },

    remove,

    async close() {
      await Promise.all([...sessions.keys()].map(remove))
    },
  }
}
