import { lineSplitter, type ChatEvent } from './chat.ts'
// 令牌只在启动网址的 # 片段里出现，读取后存入本标签页并从地址栏移除，截图和分享时不会带出。
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token')
if (hashToken) {
  sessionStorage.setItem('ugc-lens-token', hashToken)
  history.replaceState(null, '', location.pathname)
}
export const token = sessionStorage.getItem('ugc-lens-token') ?? ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, { ...options, headers: { 'x-ugc-lens-token': token, 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await res.json().catch(() => ({})) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `请求失败（${res.status}）`)
  return body as T
}

/** 浏览器选择的文件只有内容没有路径：上传到本机服务，保存到用户目录后按路径打开 */
export async function upload(file: File): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'x-ugc-lens-token': token, 'content-type': 'application/octet-stream' } })
  const body = await res.json().catch(() => ({})) as { error?: string; path?: string }
  if (!res.ok || !body.path) throw new ApiError(res.status, body.error ?? `上传失败（${res.status}）`)
  return body.path
}

/** 发送一轮对话：逐行读取 NDJSON 事件。HTTP 错误（未配置模型、会话失效等）抛 ApiError */
export async function streamChat(sessionId: string, text: string, datasetId: string | undefined, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', signal, body: JSON.stringify({ text, dataset_id: datasetId }), headers: { 'x-ugc-lens-token': token, 'content-type': 'application/json' } })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new ApiError(res.status, body.error ?? `请求失败（${res.status}）`)
  }
  const split = lineSplitter()
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    const lines = done ? [...split.push(decoder.decode()), ...split.flush()] : split.push(decoder.decode(value, { stream: true }))
    for (const line of lines) {
      try { onEvent(JSON.parse(line) as ChatEvent) } catch { /* 忽略无法解析的行 */ }
    }
    if (done) return
  }
}
