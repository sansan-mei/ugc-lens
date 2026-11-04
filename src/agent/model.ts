import type { ChatMessage, ChatResult, ToolChoice, ToolDefinition } from '../llm/types.ts'

export interface AgentModelRequest {
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  toolChoice: ToolChoice
  signal: AbortSignal
}

/** Agent 循环只依赖这个接口，假模型和真实模型都实现它 */
export interface AgentModel {
  complete(request: AgentModelRequest): Promise<ChatResult>
}
