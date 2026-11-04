import { createInterface } from 'node:readline/promises'
import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'
import { createConversation } from '../src/llm/conversation.ts'

const config = loadLlmConfig()
// 模型本身不记得任何东西：每一轮都把完整历史重新发过去，这就是“记忆”
const conversation = createConversation(createChatClient(config), '你是一个简洁的助手，回答使用中文。')

console.log(`[${config.provider} / ${config.model}] 多轮对话。命令：/history 查看历史，/reset 清空，/exit 退出\n`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.setPrompt('你> ')
// 管道输入（如 printf ... | node）读完后 readline 会提前关闭，此时再调用 prompt 会抛错
let closed = false
rl.on('close', () => {
  closed = true
})
const prompt = (): void => {
  if (!closed) rl.prompt()
}
prompt()

for await (const raw of rl) {
  const line = raw.trim()

  if (line === '/exit') break
  if (line === '/reset') {
    conversation.reset()
    console.log('（历史已清空）\n')
    prompt()
    continue
  }
  if (line === '/history') {
    for (const [i, m] of conversation.messages.entries()) console.log(`  ${i}. [${m.role}] ${m.content}`)
    console.log()
    prompt()
    continue
  }
  if (!line) {
    prompt()
    continue
  }

  try {
    const result = await conversation.send(line, { temperature: 0.3 })
    const total = conversation.usage
    console.log(`\n助手> ${result.message.content}`)
    console.log(
      `      （本轮 input=${result.usage.input_tokens} output=${result.usage.output_tokens}；` +
        `累计 input=${total.input_tokens} output=${total.output_tokens}；历史 ${conversation.messages.length} 条）\n`,
    )
  } catch (error) {
    console.error(`\n出错：${(error as Error).message}\n`)
  }
  prompt()
}

rl.close()
