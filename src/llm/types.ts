/** OpenAI 兼容 Chat Completions 接口的类型（只保留目前用到的字段） */

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

/** auto：模型自己决定是否调用工具；none：只能用文字回答 */
export type ToolChoice = 'auto' | 'none'

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 为空时请求里不带 tools 和 tool_choice */
  tools?: readonly ToolDefinition[]
  toolChoice?: ToolChoice
}

export interface Usage {
  input_tokens: number
  output_tokens: number
}

export interface ChatResult {
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
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}
