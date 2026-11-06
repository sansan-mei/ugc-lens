#!/usr/bin/env node
import type { TaskUsage } from '../agent/usage.ts'
/**
 * 命令行入口：ugc-lens 默认进入持续对话，子命令用于单次操作
 * 开发时：node src/cli/index.ts <命令> ...
 */
import { readFileSync } from 'node:fs'
import { ConfigError } from '../config.ts'
import { ImportError } from '../ingest/index.ts'
import { ANALYZE_USAGE, runAnalyze } from './analyze.ts'
import { ASK_USAGE, runAsk } from './ask.ts'
import { UsageError } from './common.ts'
import { runChat } from './chat.ts'
import { INIT_USAGE, runInit } from './init.ts'
import { runWatch, WATCH_USAGE } from './watch.ts'
import { MCP_USAGE, runMcp } from './mcp.ts'

import { PLAYBOOK_USAGE, runPlaybook } from './playbook.ts'
import { PROFILE_USAGE, runProfile } from './profile.ts'

const COMMANDS = {
  profile: { run: runProfile, usage: PROFILE_USAGE },
  playbook: { run: runPlaybook, usage: PLAYBOOK_USAGE },
  init: { run: runInit, usage: INIT_USAGE },
  mcp: { run: runMcp, usage: MCP_USAGE },
  analyze: { run: runAnalyze, usage: ANALYZE_USAGE },
  ask: { run: runAsk, usage: ASK_USAGE },
  watch: { run: runWatch, usage: WATCH_USAGE },
} as const

const MAIN_USAGE = `ugc-lens：分析文本记录、评论、弹幕等内容

用法：
  ugc-lens                             持续对话，自动选择导入、查询、分析和监听工具
  ugc-lens --web                       持续对话并开启联网搜索（需配置 web，默认关闭）
  ugc-lens playbook                     查看分析手册和待审修改
  ugc-lens profile                     查看、开启或修正本地用户画像
  ugc-lens init                         初始化：选择提供商和模型，写入全局配置
  ugc-lens analyze <文件>               生成 Markdown 分析报告
  ugc-lens ask <文件> <问题> [追问...]   追问，回答带 [ID] 引用
  ugc-lens watch <目录>                 监听目录，新的 *_all.json 写完后自动分析
  ugc-lens mcp [--cwd <目录>]           通过 stdio 向宿主提供 MCP 工具
  ugc-lens <命令> --help                查看命令的选项
  ugc-lens --version

模型和 API key 从环境变量、当前目录的 .env / .ugc-lens/config.json 或全局 ~/.ugc-lens/config.json 读取，例如：
  UGC_LENS_PROVIDER=deepseek
  DEEPSEEK_API_KEY=你的 key

联网搜索默认关闭，开启方式见 README 的“联网搜索”一节。`

/** dist/cli/index.js 和 src/cli/index.ts 到 package.json 的相对位置相同 */
function version(): string {
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
}

function isParseArgsError(error: unknown): boolean {
  return String((error as { code?: unknown })?.code ?? '').startsWith('ERR_PARSE_ARGS')
}

const [command, ...rest] = process.argv.slice(2)
if ((command === undefined && !process.stdin.isTTY) || command === '--help' || command === '-h' || command === 'help') {
  console.log(MAIN_USAGE)
} else if (command === '--version' || command === '-v') {
  console.log(version())
} else if (command !== undefined && !command.startsWith('-') && !Object.hasOwn(COMMANDS, command)) {
  console.error(`未知命令：${command}\n\n${MAIN_USAGE}`)
  process.exitCode = 2
} else {
  // 以选项开头时（如 ugc-lens --web）进入对话，选项交给对话解析
  const chat = command === undefined || command.startsWith('-')
  const { run, usage } = chat ? { run: runChat, usage: MAIN_USAGE } : COMMANDS[command as keyof typeof COMMANDS]
  const args = chat && command !== undefined ? [command, ...rest] : rest
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage)
  } else {
    try {
      await run(args)
    } catch (error) {
      const taskUsage = (error as { task_usage?: TaskUsage }).task_usage
      if (taskUsage?.calls.length) console.error(`本任务已知 token ${taskUsage.known_tokens}，用量未知 ${taskUsage.unknown_calls} 次`)
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
