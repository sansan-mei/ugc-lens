import type { RetryInfo } from '../llm/retry.ts'
import type { ChatMessage, ChatResult, ToolChoice, ToolDefinition } from '../llm/types.ts'

export interface AgentModelRequest {
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  toolChoice: ToolChoice
  signal: AbortSignal
  /** 模型接口重试前调用，循环用它发出 model_retry 事件 */
  onRetry?: (info: RetryInfo) => void
}

/** Agent 循环只依赖这个接口，假模型和真实模型都实现它 */
export interface AgentModel {
  complete(request: AgentModelRequest): Promise<ChatResult>
}
