import { parseArgs } from 'node:util'
import type { AgentRunResult } from '../agent/loop.ts'
import { askDataset } from '../ask/index.ts'
import { loadLlmConfig } from '../config.ts'
import { loadDataset } from '../ingest/index.ts'
import { abortOnInterrupt, askModel, UsageError } from './common.ts'
import { formatEvent } from './format_event.ts'

export const ASK_USAGE = `用法：ugc-lens ask <文件> <问题> [追问...]

用数据工具查询数据后回答，回答里用 [ID] 标出依据。多个问题依次提出，后面的接着前面的对话。

  --verbose    显示每一步的模型调用和工具结果`

export interface AskArgs {
  file: string
  questions: string[]
  verbose: boolean
}

export function parseAskArgs(argv: readonly string[]): AskArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { verbose: { type: 'boolean', default: false } },
  })
  const [file, ...questions] = positionals
  if (!file) throw new UsageError('需要一个数据文件')
  const asked = questions.map((q) => q.trim()).filter(Boolean)
  if (asked.length === 0) throw new UsageError('需要至少一个问题')
  return { file, questions: asked, verbose: values.verbose }
}

export async function runAsk(argv: readonly string[]): Promise<void> {
  const args = parseAskArgs(argv)
  const config = loadLlmConfig()
  const model = askModel(config)
  const { signal } = abortOnInterrupt('正在取消')

  const dataset = await loadDataset(args.file, { model, signal })
  console.error(`已导入 ${dataset.items.length} 条（文件结构${dataset.mapping.from_cache ? '规则来自缓存' : '由模型识别'}）`)

  let history: AgentRunResult['messages'] | undefined
  for (const [i, question] of args.questions.entries()) {
    if (args.questions.length > 1) process.stdout.write(`${i > 0 ? '\n' : ''}## ${question}\n\n`)
    const result = await askDataset({
      model,
      datasets: [dataset],
      question,
      history,
      signal,
      onEvent: (event) => {
        if (args.verbose || event.type === 'tool_start' || event.type === 'model_retry') console.error(formatEvent(event))
      },
    })
    history = result.run.messages
    process.stdout.write(`${result.answer.trim()}\n`)
    const { valid, invalid } = result.citations
    console.error(
      `（${result.run.steps.length} 步，token ${result.run.usage.input_tokens}+${result.run.usage.output_tokens}；` +
        `引用 ${valid.length} 个存在${invalid.length > 0 ? `，${invalid.length} 个不存在：${invalid.join(', ')}` : ''}）`,
    )
  }
}
