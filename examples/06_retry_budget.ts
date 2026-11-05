/**
 * 第 6 步：重试与 token 预算。
 *   node examples/06_retry_budget.ts retry    本地模拟一个不稳定的服务（503、429），观察重试，不消耗 token
 *   node examples/06_retry_budget.ts budget   用真实模型，把 token 预算设得很小，观察 token_budget 收尾
 *   node examples/06_retry_budget.ts          两个都跑
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { runAgent } from '../src/agent/loop.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'
import { createBuiltinTools } from '../src/tools/builtin/index.ts'

const which = process.argv[2]

async function demoRetry(): Promise<void> {
  console.log('\n========== 重试：服务先返回 503，再返回 429，第 3 次才成功 ==========')
  let count = 0
  const server = createServer((req, res) => {
    req.resume()
    count++
    console.log(`  （模拟服务）收到第 ${count} 次请求`)
    if (count === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{"error":"server busy"}')
    } else if (count === 2) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
      res.end('{"error":"rate limited"}')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'flaky',
          choices: [{ message: { role: 'assistant', content: '第 3 次终于成功了。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        }),
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    const client = createChatClient({ provider: 'custom', model: 'flaky', baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 5_000 })
    const result = await runAgent({
      model: createLlmModel(client),
      messages: [{ role: 'user', content: '你好' }],
      onEvent: (event) => console.log(formatEvent(event)),
    })
    console.log(`\n回答：${result.answer}`)
  } finally {
    server.close()
  }
}

async function demoBudget(): Promise<void> {
  const tokenBudget = 3_000
  console.log(`\n========== token 预算：只给 ${tokenBudget} token，任务需要读多个文件 ==========`)
  const config = loadLlmConfig()
  const result = await runAgent({
    model: createLlmModel(createChatClient(config), { temperature: 0.2 }),
    messages: [
      {
        role: 'system',
        content: `你是一个代码助手，工作目录：${process.cwd()}。需要看文件内容时用 read_file，不要猜。回答使用中文。`,
      },
      { role: 'user', content: '依次读取 src/llm 目录下的 client.ts、retry.ts、conversation.ts、providers.ts，分别用一句话总结作用。' },
    ],
    tools: createBuiltinTools(),
    limits: { tokenBudget },
    onEvent: (event) => console.log(formatEvent(event)),
  })
  console.log(`\n停止原因：${result.stop_reason}`)
  console.log(`收尾调用：${result.steps.at(-1)?.final ? '有' : '无'}`)
  console.log(`\n回答：${result.answer}`)
}

if (which !== 'budget') await demoRetry()
if (which !== 'retry') await demoBudget()
