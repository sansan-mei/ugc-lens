import { currentTask, withTask } from '../agent/usage.ts'
import { parseArgs } from 'node:util'
import type { AgentRunResult } from '../agent/loop.ts'
import { askDataset } from '../ask/index.ts'
import { loadLlmConfig } from '../config.ts'
import { loadDataset } from '../ingest/index.ts'
import { mappingSource, abortOnInterrupt, askModel, formatWebCitations, UsageError, webSessionFor } from './common.ts'
import { formatEvent } from './format_event.ts'

export const ASK_USAGE = `用法：ugc-lens ask <文件> <问题> [追问...]

用数据工具查询数据后回答，回答里用 [ID] 标出依据。多个问题依次提出，后面的接着前面的对话。

  --verbose    显示每一步的模型调用和工具结果
  --web        开启联网搜索与网页读取（需配置 web，默认关闭）`

export interface AskArgs {
  file: string
  questions: string[]
  verbose: boolean
  web: boolean
}

export function parseAskArgs(argv: readonly string[]): AskArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { verbose: { type: 'boolean', default: false }, web: { type: 'boolean', default: false } },
  })
  const [file, ...questions] = positionals
  if (!file) throw new UsageError('需要一个数据文件')
  const asked = questions.map((q) => q.trim()).filter(Boolean)
  if (asked.length === 0) throw new UsageError('需要至少一个问题')
  return { file, questions: asked, verbose: values.verbose, web: values.web }
}

export async function runAsk(argv: readonly string[]): Promise<void> {
  if (!currentTask()) return withTask(() => runAsk(argv))
  const args = parseAskArgs(argv)
  const config = loadLlmConfig()
  const model = askModel(config)
  const web = webSessionFor(args.web)
  const { signal } = abortOnInterrupt('正在取消')

  const dataset = await loadDataset(args.file, { model, signal })
  console.error(`已导入 ${dataset.items.length} 条（文件结构${mappingSource(dataset.mapping)}）`)

  let history: AgentRunResult['messages'] | undefined
  for (const [i, question] of args.questions.entries()) {
    if (args.questions.length > 1) process.stdout.write(`${i > 0 ? '\n' : ''}## ${question}\n\n`)
    const result = await askDataset({
      memory: { cwd: process.cwd(), onWarning: (message) => console.error(message) },
      model,
      datasets: [dataset],
      question,
      history,
      web,
      signal,
      onEvent: (event) => {
        if (args.verbose || event.type === 'tool_start' || event.type === 'model_retry') console.error(formatEvent(event))
      },
    })
    console.error(`（本任务内部已知 token ${result.task_usage.known_tokens}，用量未知 ${result.task_usage.unknown_calls} 次）`)
    history = result.run.messages
    if (result.profile_learning?.warning) console.error(result.profile_learning.warning)
    if (result.profile_learning?.usage) console.error(`（画像学习 token ${result.profile_learning.usage.input_tokens}+${result.profile_learning.usage.output_tokens}）`)
    process.stdout.write(`${result.answer.trim()}\n`)
    const webCheck = formatWebCitations(result.web_citations)
    if (webCheck) console.error(webCheck)
    const { valid, invalid } = result.citations
    console.error(
      `（${result.run.steps.length} 步，token ${result.run.usage.input_tokens}+${result.run.usage.output_tokens}；` +
        `引用 ${valid.length} 个存在${invalid.length > 0 ? `，${invalid.length} 个不存在：${invalid.join(', ')}` : ''}）`,
    )
  }
}
