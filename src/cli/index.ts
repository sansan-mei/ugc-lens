/**
 * 命令行入口。目前只有 watch：
 *   node src/cli/index.ts watch <目录> [选项]
 */
import { createLlmModel } from '../agent/llm_model.ts'
import { loadLlmConfig } from '../config.ts'
import { loadDataset } from '../ingest/index.ts'
import { createChatClient } from '../llm/client.ts'
import { analyzeDataset } from '../pipeline/analyze.ts'
import { openTaskStore } from '../store/tasks.ts'
import { watchDirectory } from '../watch/index.ts'
import { formatAnalyzeProgress, formatWatchEvent, parseWatchArgs, WATCH_USAGE } from './watch.ts'

async function runWatch(argv: string[]): Promise<void> {
  let args
  try {
    args = parseWatchArgs(argv)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${WATCH_USAGE}`)
    process.exitCode = 2
    return
  }
  const config = loadLlmConfig()
  const model = createLlmModel(createChatClient(config), { temperature: 0, maxTokens: 4_000, disableThinking: true })
  const store = await openTaskStore()

  const controller = new AbortController()
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130)
    console.error('\n正在停止……再按一次 Ctrl+C 直接退出')
    controller.abort()
  })

  await watchDirectory({
    dir: args.dir,
    store,
    signal: controller.signal,
    patterns: args.patterns,
    existing: args.existing,
    retryFailed: args.retryFailed,
    scanIntervalMs: args.scanIntervalMs,
    settleMs: args.settleMs,
    onEvent: (event) => console.log(formatWatchEvent(event, args.dir)),
    analyze: async (file, signal) => {
      const dataset = await loadDataset(file, { model, signal })
      const result = await analyzeDataset({
        model,
        dataset,
        signal,
        modelName: config.model,
        directions: args.directions,
        maxTotalChars: args.maxTotalChars,
        onProgress: (event) => console.log(formatAnalyzeProgress(event)),
      })
      return { report: result.path, calls: result.calls, usage: result.usage }
    },
  })
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'watch') {
  try {
    await runWatch(rest)
  } catch (error) {
    console.error(`启动失败：${(error as Error).message}`)
    process.exitCode = 1
  }
} else {
  console.error(`未知命令：${command ?? '（空）'}\n\n${WATCH_USAGE}`)
  process.exitCode = 2
}
