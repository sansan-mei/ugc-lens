import type { LlmConfig } from '../config.ts'
import type { ChatMessage, ChatOptions, ChatResult, RawChatCompletion, RawToolCall, ToolCall } from './types.ts'

export class LlmError extends Error {
  override name = 'LlmError'
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export interface ChatClient {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  listModels(): Promise<string[]>
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

export function createChatClient(config: LlmConfig): ChatClient {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new LlmError(`${config.provider} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`, response.status)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new LlmError(`${config.provider} 返回的不是 JSON: ${text.slice(0, 200)}`)
    }
  }

  return {
    async chat(messages, options = {}) {
      if (!config.model) {
        throw new LlmError('未设置模型：设置 UGC_LENS_MODEL，可先运行 npm run models 查看可选模型')
      }
      const hasTools = (options.tools?.length ?? 0) > 0
      const body = {
        model: config.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        // 没有工具时不发这两个字段：部分提供商遇到空的 tools 数组会报错
        tools: hasTools ? options.tools : undefined,
        tool_choice: hasTools ? (options.toolChoice ?? 'auto') : undefined,
      }
      const raw = await request<RawChatCompletion>(
        '/chat/completions',
        { method: 'POST', body: JSON.stringify(body) },
        options.signal,
      )
      const choice = raw.choices[0]
      if (!choice) throw new LlmError(`${config.provider} 返回的 choices 为空`)

      const toolCalls = normalizeToolCalls(choice.message.tool_calls)
      const message: ChatResult['message'] = {
        role: 'assistant',
        content: choice.message.content ?? (toolCalls.length > 0 ? null : ''),
      }
      if (toolCalls.length > 0) message.tool_calls = toolCalls

      return {
        message,
        finishReason: choice.finish_reason,
        usage: {
          input_tokens: raw.usage?.prompt_tokens ?? 0,
          output_tokens: raw.usage?.completion_tokens ?? 0,
        },
        model: raw.model,
      }
    },

    async listModels() {
      const raw = await request<{ data?: Array<{ id: string }> }>('/models', { method: 'GET' })
      return (raw.data ?? []).map((item) => item.id).sort()
    },
  }
}
