import type { LlmConfig } from '../config.ts'
import { PROVIDERS, type ProviderPreset } from './providers.ts'
import { DEFAULT_RETRY_POLICY, isRetryableStatus, parseRetryAfter, withRetry, type RetryInfo, type RetryPolicy } from './retry.ts'
import type { ChatMessage, ChatOptions, ChatResult, RawChatChunk, RawChatCompletion, RawToolCall, ToolCall } from './types.ts'

export class LlmError extends Error {
  override name = 'LlmError'
  readonly status?: number
  /** 网络错误、请求超时、408/429/5xx 为 true */
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(message: string, options: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.status = options.status
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs
  }
}

export interface ChatClient {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  listModels(): Promise<string[]>
}

export interface ChatClientOptions {
  retry?: Partial<RetryPolicy>
}

/** 各家返回的 tool_calls 细节不完全一致（缺 id、arguments 是对象），统一成标准格式 */
function normalizeToolCalls(raw: RawToolCall[] | null | undefined): ToolCall[] {
  return (raw ?? []).map((call, index) => ({
    id: call.id || `call_${index + 1}`,
    type: 'function',
    function: {
      name: call.function.name,
      arguments:
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {}),
    },
  }))
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** 数据里可能本来就有半个代理对（来源文件损坏或被截断），JSON.stringify 会写成 \\udXXX，部分提供商拒绝解析 */
function wellFormed(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content !== 'string') return message
    const content = message.content.replace(LONE_SURROGATE, '\ufffd')
    return content === message.content ? message : { ...message, content }
  })
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  return cause?.code ?? cause?.message ?? (error as Error).message
}

/** 把 Chat Completions 的 SSE 事件拼回非流式的返回结构，正文片段逐段交给 onDelta */
async function collectStream(provider: string, body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<RawChatCompletion> {
  const decoder = new TextDecoder()
  let buffer = ''
  let model = ''
  let content: string | null = null
  let finish = ''
  let usage: RawChatCompletion['usage']
  const calls: Array<{ id?: string; type?: string; name: string; arguments: string }> = []
  const handle = (data: string) => {
    if (!data || data === '[DONE]') return
    let chunk: RawChatChunk
    try { chunk = JSON.parse(data) as RawChatChunk } catch { throw new LlmError(`${provider} 返回的流式事件不是 JSON: ${data.slice(0, 200)}`) }
    if (chunk.error) throw new LlmError(`${provider} 流式响应出错：${typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error)}`.slice(0, 500))
    if (chunk.model) model = chunk.model
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finish = choice.finish_reason
      const text = choice.delta?.content
      if (text) { content = (content ?? '') + text; onDelta(text) }
      for (const part of choice.delta?.tool_calls ?? []) {
        const index = part.index ?? calls.length
        const call = calls[index] ??= { name: '', arguments: '' }
        if (part.id) call.id = part.id
        if (part.type) call.type = part.type
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
      }
    }
  }
  const flush = (block: string) => handle(block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n?/g, '\n')
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) { flush(buffer.slice(0, end)); buffer = buffer.slice(end + 2) }
  }
  flush(buffer + decoder.decode())
  return {
    model,
    choices: [{ message: { role: 'assistant', content, tool_calls: calls.filter(Boolean).map((call) => ({ id: call.id, type: call.type, function: { name: call.name, arguments: call.arguments } })) }, finish_reason: finish || 'stop' }],
    usage,
  }
}

export function createChatClient(config: LlmConfig, options: ChatClientOptions = {}): ChatClient {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    ...options.retry,
  }

  async function requestOnce<T>(path: string, init: RequestInit, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<T> {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    let response: Response
    let text = ''
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (onDelta && response.ok && response.body && /event-stream/i.test(response.headers.get('content-type') ?? '')) {
        return await collectStream(config.provider, response.body, onDelta) as T
      }
      text = await response.text()
    } catch (error) {
      if (error instanceof LlmError) throw error
      // 调用方取消或运行总超时：原样抛出，由循环判断停止原因
      if (signal?.aborted) throw error
      if (timeout.aborted) {
        throw new LlmError(`${config.provider} 请求超过 ${config.timeoutMs}ms 未完成`, { retryable: true, cause: error })
      }
      throw new LlmError(`${config.provider} 网络错误：${describeNetworkError(error)}`, { retryable: true, cause: error })
    }

    if (!response.ok) {
      throw new LlmError(`${config.provider} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
        retryAfterMs: parseRetryAfter(response.headers),
      })
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new LlmError(`${config.provider} 返回的不是 JSON: ${text.slice(0, 200)}`)
    }
  }

  function request<T>(path: string, init: RequestInit, signal?: AbortSignal, onRetry?: (info: RetryInfo) => void, onDelta?: (text: string) => void): Promise<T> {
    return withRetry(() => requestOnce<T>(path, init, signal, onDelta), { policy, signal, onRetry })
  }

  return {
    async chat(messages, options = {}) {
      if (!config.model) {
        throw new LlmError('未设置模型：设置 UGC_LENS_MODEL，可先运行 npm run models 查看可选模型')
      }
      const hasTools = (options.tools?.length ?? 0) > 0
      const body = {
        model: config.model,
        messages: wellFormed(messages),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        // 没有工具时不发这两个字段：部分提供商遇到空的 tools 数组会报错
        tools: hasTools ? options.tools : undefined,
        tool_choice: hasTools ? (options.toolChoice ?? 'auto') : undefined,
        ...(options.disableThinking && config.provider !== 'custom' ? (PROVIDERS[config.provider] as ProviderPreset).thinkingOff : undefined),
        ...(options.onDelta ? { stream: true, stream_options: { include_usage: true } } : undefined),
      }
      const raw = await request<RawChatCompletion>(
        '/chat/completions',
        { method: 'POST', body: JSON.stringify(body) },
        options.signal,
        options.onRetry,
        options.onDelta,
      )
      const choice = raw.choices[0]
      if (!choice) throw new LlmError(`${config.provider} 返回的 choices 为空`)

      const toolCalls = normalizeToolCalls(choice.message.tool_calls)
      const message: ChatResult['message'] = {
        role: 'assistant',
        content: choice.message.content ?? (toolCalls.length > 0 ? null : ''),
      }
      if (toolCalls.length > 0) message.tool_calls = toolCalls

      const usage: ChatResult['usage'] = {
        input_tokens: raw.usage?.prompt_tokens ?? 0,
        output_tokens: raw.usage?.completion_tokens ?? 0,
      }
      const cached = raw.usage?.prompt_cache_hit_tokens ?? raw.usage?.prompt_tokens_details?.cached_tokens
      if (cached !== undefined) usage.cached_input_tokens = cached
      return { message, finishReason: choice.finish_reason, usage, model: raw.model, usageReported: raw.usage?.prompt_tokens !== undefined && raw.usage?.completion_tokens !== undefined }
    },

    async listModels() {
      const raw = await request<{ data?: Array<{ id: string }> }>('/models', { method: 'GET' })
      return (raw.data ?? []).map((item) => item.id).sort()
    },
  }
}
