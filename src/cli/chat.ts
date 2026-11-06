import { createInterface } from 'node:readline'
import { createSession, type ChatSession } from '../chat/session.ts'
import { ConfigError, loadLlmConfig } from '../config.ts'
import { parseArgs } from 'node:util'
import { analysisModel, askModel, formatWebCitations, UsageError, webSessionFor } from './common.ts'
import { formatEvent } from './format_event.ts'
import { formatWatchEvent } from './watch.ts'

const CHAT_HELP = '直接描述要做的事，例如“看看 ./data 有哪些数据”“分析这个文件”“继续监听这个目录”。\n/exit 或 /quit 退出，Ctrl+D、Ctrl+C 也可以退出。'

export interface ChatIo {
  lines: AsyncIterable<string>
  print(text: string): void
  prompt(): void
}

/** 输入保持排队，模型忙碌时输入的下一行不会丢失。 */
export async function runChatFlow(session: ChatSession, io: ChatIo, signal?: AbortSignal): Promise<void> {
  io.print(`ugc-lens 对话模式\n${CHAT_HELP}`)
  io.prompt()
  try {
    for await (const line of io.lines) {
      if (signal?.aborted) break
      const question = line.trim()
      if (question === '/exit' || question === '/quit') break
      if (question === '/help') io.print(CHAT_HELP)
      else if (question) {
        try {
          const result = await session.ask(question, signal)
          if (signal?.aborted) break
          io.print(result.answer.trim() || '本轮未完成，可以继续描述你的需求。')
          const webCheck = formatWebCitations(result.web_citations)
          if (webCheck) io.print(webCheck)
          if (result.profile_learning?.warning) io.print(result.profile_learning.warning)
          io.print(`（本轮内部已知 token ${result.task_usage.known_tokens}，用量未知 ${result.task_usage.unknown_calls} 次）`)
          if (result.profile_learning?.usage) io.print(`（画像学习 token ${result.profile_learning.usage.input_tokens}+${result.profile_learning.usage.output_tokens}）`)
          if (result.stop_reason !== 'completed') io.print(`（本轮停止原因：${result.stop_reason}）`)
        } catch (error) {
          if (signal?.aborted) break
          io.print(`错误：${(error as Error).message}。可以继续输入。`)
        }
      }
      io.prompt()
    }
  } finally {
    await session.close()
  }
}

export function parseChatArgs(argv: readonly string[]): { web: boolean } {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { web: { type: 'boolean', default: false } } })
  if (positionals.length) throw new UsageError(`未知参数：${positionals.join(' ')}`)
  return { web: values.web }
}

export async function runChat(argv: readonly string[] = []): Promise<void> {
  const args = parseChatArgs(argv)
  if (!process.stdin.isTTY) throw new UsageError('对话模式需要在终端里交互运行')
  let config
  try { config = loadLlmConfig() } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${error.message}。请先运行 ugc-lens init 配置模型`)
    throw error
  }
  const web = webSessionFor(args.web)
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n你 > ' })
  // 在首个 await 前订阅行事件，支持一次粘贴多条消息以及等待模型时输入。
  const lines = rl[Symbol.asyncIterator]()
  const controller = new AbortController()
  const interrupt = () => { controller.abort(); rl.close() }
  process.on('SIGINT', interrupt)
  rl.on('SIGINT', interrupt)
  const session = createSession({
    memory: { cwd: process.cwd(), onWarning: (message) => console.error(message) },
    model: askModel(config), analysisModel: analysisModel(config), modelName: config.model, web,
    onEvent: (event) => {
      if (event.type === 'tool_start' || event.type === 'model_retry') console.error(formatEvent(event))
    },
    onWatchEvent: (event) => console.error(formatWatchEvent(event, process.cwd())),
  })
  try {
    await runChatFlow(session, {
      lines: { [Symbol.asyncIterator]: () => lines },
      print: (text) => console.log(text), prompt: () => rl.prompt(),
    }, controller.signal)
  } finally {
    controller.abort()
    rl.close()
    process.removeListener('SIGINT', interrupt)
    rl.removeListener('SIGINT', interrupt)
  }
}
