#!/usr/bin/env node
/**
 * 命令行入口：ugc-lens <analyze|ask|watch> ...
 * 开发时：node src/cli/index.ts <命令> ...
 */
import { readFileSync } from 'node:fs'
import { ConfigError } from '../config.ts'
import { ImportError } from '../ingest/index.ts'
import { ANALYZE_USAGE, runAnalyze } from './analyze.ts'
import { ASK_USAGE, runAsk } from './ask.ts'
import { UsageError } from './common.ts'
import { runWatch, WATCH_USAGE } from './watch.ts'

const COMMANDS = {
  analyze: { run: runAnalyze, usage: ANALYZE_USAGE },
  ask: { run: runAsk, usage: ASK_USAGE },
  watch: { run: runWatch, usage: WATCH_USAGE },
} as const

const MAIN_USAGE = `ugc-lens：分析评论、弹幕等用户互动内容

用法：
  ugc-lens analyze <文件>               生成 Markdown 分析报告
  ugc-lens ask <文件> <问题> [追问...]   追问，回答带 [ID] 引用
  ugc-lens watch <目录>                 监听目录，新的 *_all.json 写完后自动分析
  ugc-lens <命令> --help                查看命令的选项
  ugc-lens --version

模型和 API key 从当前目录的 .env、.ugc-lens/config.json 或环境变量读取，例如：
  UGC_LENS_PROVIDER=deepseek
  DEEPSEEK_API_KEY=你的 key`

/** dist/cli/index.js 和 src/cli/index.ts 到 package.json 的相对位置相同 */
function version(): string {
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
}

function isParseArgsError(error: unknown): boolean {
  return String((error as { code?: unknown })?.code ?? '').startsWith('ERR_PARSE_ARGS')
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  console.log(MAIN_USAGE)
} else if (command === '--version' || command === '-v') {
  console.log(version())
} else if (!Object.hasOwn(COMMANDS, command)) {
  console.error(`未知命令：${command}\n\n${MAIN_USAGE}`)
  process.exitCode = 2
} else {
  const { run, usage } = COMMANDS[command as keyof typeof COMMANDS]
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(usage)
  } else {
    try {
      await run(rest)
    } catch (error) {
      if (error instanceof UsageError || isParseArgsError(error)) {
        console.error(`${(error as Error).message}\n\n${usage}`)
        process.exitCode = 2
      } else if (error instanceof ConfigError || error instanceof ImportError) {
        console.error(`错误：${error.message}`)
        process.exitCode = 1
      } else if ((error as Error).name === 'AbortError') {
        console.error('已取消')
        process.exitCode = 130
      } else {
        console.error(`错误：${(error as Error).stack ?? String(error)}`)
        process.exitCode = 1
      }
    }
  }
}
