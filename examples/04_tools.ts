/**
 * 第 4 步：真实模型 + 基础工具（read_file、write_file、run_command）。
 * 运行：node examples/04_tools.ts "问题"
 * 只读命令直接执行；其他命令和覆盖文件会在命令行里询问 y/N。
 * 不在终端里运行（例如被管道调用）时，一律拒绝需要确认的操作。
 */
import { createLlmModel } from '../src/agent/llm_model.ts'
import { runAgent } from '../src/agent/loop.ts'
import { createConsoleApprover } from '../src/cli/approve.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'
import type { ChatMessage } from '../src/llm/types.ts'
import { denyAll } from '../src/tools/approval.ts'
import { createBuiltinTools } from '../src/tools/builtin/index.ts'

const question = process.argv.slice(2).join(' ') || '现在几点？离今年结束还有几天？'
const cwd = process.cwd()

const config = loadLlmConfig()
const model = createLlmModel(createChatClient(config), { temperature: 0.2 })
const approve = process.stdin.isTTY ? createConsoleApprover() : denyAll
if (!process.stdin.isTTY) console.log('（不在终端中运行：需要确认的操作会被自动拒绝）')

const messages: ChatMessage[] = [
  {
    role: 'system',
    content:
      '你是一个在用户电脑上工作的助手，可以读写文件、执行 shell 命令。' +
      `工作目录：${cwd}。操作系统：${process.platform}。` +
      '需要事实信息（时间、文件内容等）时先用工具查，不要猜。回答使用中文，简洁。',
  },
  { role: 'user', content: question },
]

console.log(`[${config.provider} / ${config.model}] ${question}\n`)
const result = await runAgent({
  model,
  messages,
  tools: createBuiltinTools(),
  cwd,
  approve,
  onEvent: (event) => console.log(formatEvent(event)),
})

console.log(`\n回答：${result.answer}`)
console.log('\n运行记录：')
for (const step of result.steps) {
  console.log(`  第 ${step.step} 步${step.final ? '（收尾）' : ''}：${step.content ? `说：${step.content.slice(0, 80)}` : ''}`)
  for (const call of step.tool_calls) {
    console.log(`    ${call.ok ? '✓' : '✗'} ${call.name}(${JSON.stringify(call.args)}) → ${call.result.slice(0, 120).replace(/\n/g, ' ⏎ ')}`)
  }
}
