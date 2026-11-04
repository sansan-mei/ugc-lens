import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'

const config = loadLlmConfig()
const client = createChatClient(config)

console.log(`提供商：${config.provider}  地址：${config.baseUrl}`)
const models = await client.listModels()
console.log(`可选模型（${models.length} 个）：`)
for (const id of models) console.log(`  - ${id}`)
