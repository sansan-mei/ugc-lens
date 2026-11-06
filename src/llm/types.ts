/** OpenAI 兼容 Chat Completions 接口的类型（只保留目前用到的字段） */
import type { RetryInfo } from './retry.ts'

export interface ToolCall {
  id: string
  type: 'function'
  /** arguments 是 JSON 字符串，需要自己解析；模型可能给出不合法的 JSON */
  function: { name: string; arguments: string }
}

export interface SystemMessage {
  role: 'system'
  content: string
}

export interface UserMessage {
  role: 'user'
  content: string
}

export interface AssistantMessage {
  role: 'assistant'
  /** 只请求工具、不说话时为 null */
  content: string | null
  tool_calls?: ToolCall[]
}

export interface ToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export type ChatRole = ChatMessage['role']

/** 请求里 tools 字段的单个元素 */
export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** auto：模型自己决定是否调用工具；none：只能用文字回答；指定 function：必须调用这个工具 */
export type ToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } }

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 为空时请求里不带 tools 和 tool_choice */
  tools?: readonly ToolDefinition[]
  toolChoice?: ToolChoice
  /**
   * 关闭思考模式（提供商预设里有 thinkingOff 时才生效）。思考内容按输出 token 计费，
   * 而且部分提供商在思考模式下不接受指定工具的 tool_choice。
   */
  disableThinking?: boolean
  /** 每次重试前调用，用于显示进度 */
  onRetry?: (info: RetryInfo) => void
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  /** input_tokens 中命中提供商提示词缓存的部分，提供商不返回时没有这个字段；汇总时为已返回调用之和 */
  cached_input_tokens?: number
  /** 仅汇总用量：其中未返回缓存字段的调用次数。全部未返回时没有 cached_input_tokens，表示未知而不是 0 */
  cached_unreported_calls?: number
}

export interface ChatResult {
  /** false 表示接口没有返回完整用量，账本不能将缺失值当成零。 */
  usageReported?: boolean
  message: AssistantMessage
  /** stop：正常结束；length：达到 max_tokens 被截断；tool_calls：请求调用工具 */
  finishReason: string
  usage: Usage
  model: string
}

/** 接口原始返回的工具调用。部分提供商缺 id、type，或者 arguments 直接是对象 */
export interface RawToolCall {
  id?: string
  type?: string
  function: { name: string; arguments?: unknown }
}

/** 接口原始返回结构 */
export interface RawChatCompletion {
  model: string
  choices: Array<{
    message: { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] | null }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** DeepSeek */
    prompt_cache_hit_tokens?: number
    /** OpenAI 及多数兼容接口 */
    prompt_tokens_details?: { cached_tokens?: number } | null
  }
}
