import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'
import type { ChatMessage } from '../src/llm/types.ts'

const question = process.argv.slice(2).join(' ') || '用一句话解释什么是 AI Agent。'

const config = loadLlmConfig()
const client = createChatClient(config)

const messages: ChatMessage[] = [
  { role: 'system', content: '你是一个简洁的助手，回答使用中文。' },
  { role: 'user', content: question },
]

const startedAt = Date.now()
const result = await client.chat(messages, { temperature: 0.3 })

console.log(`[${config.provider} / ${result.model}] ${question}\n`)
console.log(result.message.content)
console.log(
  `\nfinish_reason=${result.finishReason}  ` +
    `input_tokens=${result.usage.input_tokens}  output_tokens=${result.usage.output_tokens}  ` +
    `耗时=${Date.now() - startedAt}ms`,
)
