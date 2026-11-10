import type { ChatClient } from '../llm/client.ts'
import type { AgentModel } from './model.ts'

export interface LlmModelOptions {
  temperature?: number
  maxTokens?: number
  disableThinking?: boolean
}

/** 把模型客户端包装成 Agent 循环使用的 AgentModel */
export function createLlmModel(client: Pick<ChatClient, 'chat'>, options: LlmModelOptions = {}): AgentModel {
  return {
    complete: ({ messages, tools, toolChoice, signal, onRetry, onDelta }) =>
      client.chat(messages, { ...options, tools, toolChoice, signal, onRetry, onDelta }),
  }
}
