/**
 * 第 5 步实验：故意把工具描述写得含糊，观察模型收到参数错误后能否自己修正。
 * 运行：node examples/05_param_errors.ts
 *
 * days_between 的日期必须写成 YYYY/MM/DD（斜杠），但描述里没说，
 * 这条规则用 refine 写，不会出现在发给模型的 JSON Schema 里。
 * 模型通常会先按习惯传 2026-11-05，收到错误后再改。
 */
import * as z from 'zod'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { runAgent } from '../src/agent/loop.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import { loadLlmConfig } from '../src/config.ts'
import { createChatClient } from '../src/llm/client.ts'
import { defineTool } from '../src/tools/define.ts'

const SLASH_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/

const slashDate = z
  .string()
  .refine((value) => SLASH_DATE.test(value), '日期格式必须是 YYYY/MM/DD，例如 2026/01/31')

const daysBetween = defineTool({
  name: 'days_between',
  description: '计算两个日期的间隔',
  parameters: z.object({ from: slashDate, to: slashDate }),
  async execute({ from, to }) {
    const toTime = (value: string) => {
      const [, y, m, d] = SLASH_DATE.exec(value) ?? []
      return Date.UTC(Number(y), Number(m) - 1, Number(d))
    }
    return `${(toTime(to) - toTime(from)) / 86_400_000} 天`
  },
})

const config = loadLlmConfig()
const question = process.argv.slice(2).join(' ') || '今天是 2026 年 11 月 5 日。离今年圣诞节还有几天？离 2027 年 2 月 6 日春节呢？'

console.log(`[${config.provider} / ${config.model}] ${question}\n`)
console.log(`发给模型的参数格式：${JSON.stringify(daysBetween.parameters)}\n`)

const result = await runAgent({
  model: createLlmModel(createChatClient(config), { temperature: 0.2 }),
  messages: [
    { role: 'system', content: '你是一个助手。涉及日期计算时必须使用工具，不要自己算。回答使用中文。' },
    { role: 'user', content: question },
  ],
  tools: [daysBetween],
  onEvent: (event) => console.log(formatEvent(event)),
})

console.log(`\n回答：${result.answer}`)
console.log('\n每次工具调用：')
for (const call of result.steps.flatMap((s) => s.tool_calls)) {
  console.log(`  ${call.ok ? '✓' : '✗'} ${JSON.stringify(call.args)} → ${call.result.split('\n').slice(0, 3).join(' ⏎ ')}`)
}
