/**
 * 第 3 步：用假模型跑通 Agent 循环。
 * 运行全部场景：node examples/03_agent_loop.ts
 * 只运行某个场景：node examples/03_agent_loop.ts 2
 */
import { createFakeModel, type FakeScript } from '../src/agent/fake_model.ts'
import { runAgent, type AgentLimits } from '../src/agent/loop.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import type { ChatMessage } from '../src/llm/types.ts'
import type { AgentTool } from '../src/tools/types.ts'

const tools: AgentTool[] = [
  {
    name: 'get_time',
    description: '获取当前时间',
    parameters: { type: 'object', properties: {} },
    execute: async () => '2026-11-04 10:00（固定值，便于观察）',
  },
  {
    name: 'add',
    description: '计算两个数的和',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    execute: async (args) => String(Number(args.a) + Number(args.b)),
  },
]

interface Scenario {
  title: string
  question: string
  script: FakeScript
  limits?: Partial<AgentLimits>
}

const scenarios: Scenario[] = [
  {
    title: '直接回答（0 次工具调用）',
    question: '你好',
    script: [{ content: '你好！这个问题不需要工具，直接回答。' }],
  },
  {
    title: '调用 2 次工具后回答',
    question: '现在几点？顺便算一下 1+2',
    script: [
      { tool_calls: [{ name: 'get_time' }] },
      { tool_calls: [{ name: 'add', args: { a: 1, b: 2 } }] },
      { content: '现在是 2026-11-04 10:00，1+2=3。' },
    ],
  },
  {
    title: '一直请求工具，被 max_steps 停止',
    question: '一直查时间',
    limits: { maxSteps: 3 },
    script: (request) => {
      if (request.toolChoice === 'none') return { content: '已达到步数上限。目前查到的时间是 2026-11-04 10:00。' }
      return { tool_calls: [{ name: 'get_time' }] }
    },
  },
  {
    title: '连续调用不存在的工具，被 tool_errors 停止',
    question: '帮我搜一下网页',
    script: (request) => {
      if (request.toolChoice === 'none') return { content: '没有可用的网页搜索工具，无法完成搜索。' }
      return { tool_calls: [{ name: 'search_web', args: { q: 'ugc' } }] }
    },
  },
]

const only = Number(process.argv[2])
const selected = Number.isInteger(only) && only > 0 ? [[only, scenarios[only - 1]] as const] : scenarios.map((s, i) => [i + 1, s] as const)

for (const [index, scenario] of selected) {
  if (!scenario) {
    console.error(`没有第 ${index} 个场景，可选 1~${scenarios.length}`)
    process.exitCode = 1
    break
  }
  console.log(`\n========== 场景 ${index}：${scenario.title} ==========`)
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是一个助手。' },
    { role: 'user', content: scenario.question },
  ]
  const result = await runAgent({
    model: createFakeModel(scenario.script),
    messages,
    tools,
    limits: scenario.limits,
    onEvent: (event) => console.log(formatEvent(event)),
  })

  console.log(`\n回答：${result.answer}`)
  console.log(`消息顺序：${result.messages.map((m) => m.role).join(' → ')}`)
}
