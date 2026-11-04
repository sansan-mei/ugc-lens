import type { ChatClient } from './client.ts'
import type { ChatMessage, ChatOptions, ChatResult, Usage } from './types.ts'

export interface Conversation {
  readonly messages: readonly ChatMessage[]
  readonly usage: Readonly<Usage>
  /** 发送一条用户消息，连同完整历史一起交给模型 */
  send(text: string, options?: ChatOptions): Promise<ChatResult>
  /** 清空历史，只保留 system prompt */
  reset(): void
}

export function createConversation(client: Pick<ChatClient, 'chat'>, systemPrompt: string): Conversation {
  const system: ChatMessage = { role: 'system', content: systemPrompt }
  let messages: ChatMessage[] = [system]
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }

  return {
    get messages() {
      return messages
    },
    get usage() {
      return usage
    },

    async send(text, options) {
      messages.push({ role: 'user', content: text })
      let result: ChatResult
      try {
        result = await client.chat([...messages], options)
      } catch (error) {
        // 撤回这条提问，否则历史里会留下一条没有回答的 user 消息
        messages.pop()
        throw error
      }
      messages.push(result.message)
      usage.input_tokens += result.usage.input_tokens
      usage.output_tokens += result.usage.output_tokens
      return result
    },

    reset() {
      messages = [system]
    },
  }
}
