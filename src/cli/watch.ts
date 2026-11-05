import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import type { AnalyzeProgress } from '../pipeline/analyze.ts'
import { parsePatterns } from '../watch/pattern.ts'
import type { WatchEvent } from '../watch/index.ts'

export const WATCH_USAGE = `用法：ugc-lens watch <目录> [选项]

  --pattern <规则>     触发分析的文件名，多个用逗号分开，支持 * 和 ?，默认 *_all.json
  --existing           启动时目录里已有的文件也分析（默认只分析之后新出现的）
  --retry-failed       重试之前失败的任务
  --interval <秒>      定时扫描间隔，默认 30
  --settle <秒>        文件多久不变才算写完，默认 2
  --chars <字数>       每个文件交给模型的评论总字数，默认 80000
  --focus <方向>       只分析这些方向，逗号分开，例如 价格,售后`

export interface WatchArgs {
  dir: string
  patterns: string[]
  existing: boolean
  retryFailed: boolean
  scanIntervalMs: number
  settleMs: number
  maxTotalChars?: number
  directions?: string[]
}

function positiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} 需要正数，收到 ${value}`)
  return n
}

/** 参数不对时抛出 Error，消息可以直接给用户看 */
export function parseWatchArgs(argv: readonly string[]): WatchArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      pattern: { type: 'string' },
      existing: { type: 'boolean', default: false },
      'retry-failed': { type: 'boolean', default: false },
      interval: { type: 'string' },
      settle: { type: 'string' },
      chars: { type: 'string' },
      focus: { type: 'string' },
    },
  })
  if (positionals.length !== 1) throw new Error('需要一个要监听的目录')
  const directions = values.focus?.split(/[,，]/).map((d) => d.trim()).filter(Boolean)
  return {
    dir: positionals[0]!,
    patterns: parsePatterns(values.pattern),
    existing: values.existing,
    retryFailed: values['retry-failed'],
    scanIntervalMs: (positiveNumber('interval', values.interval) ?? 30) * 1000,
    settleMs: (positiveNumber('settle', values.settle) ?? 2) * 1000,
    maxTotalChars: positiveNumber('chars', values.chars),
    directions: directions?.length ? directions : undefined,
  }
}

const REASONS = { new: '新文件', existing: '已有文件', resume: '上次没做完', retry: '重试' } as const

/** 每个事件一行；路径相对监听目录显示，太长的文件夹名不好读 */
export function formatWatchEvent(event: WatchEvent, dir: string): string {
  const show = (file: string) => relative(dir, file) || file
  switch (event.type) {
    case 'watching': {
      const notes = [
        event.resumed > 0 ? `继续上次的 ${event.resumed} 个任务` : '',
        event.ignored > 0 ? `已有的 ${event.ignored} 个文件不分析（加 --existing 才分析）` : '',
      ].filter(Boolean)
      return `开始监听 ${event.dir}，文件名 ${event.patterns.join('、')}${notes.length > 0 ? `；${notes.join('；')}` : ''}`
    }
    case 'queued':
      return `+ 排队（${REASONS[event.reason]}）：${show(event.file)}`
    case 'started':
      return `▶ 开始分析：${show(event.file)}${event.waiting > 0 ? `（后面还有 ${event.waiting} 个）` : ''}`
    case 'done': {
      const { usage, calls, report } = event.task
      const cost = usage ? `，调用 ${calls} 次，输入 ${usage.input_tokens}、输出 ${usage.output_tokens} token` : ''
      return `✓ 完成：${show(event.file)}${cost}${report ? `\n  报告：${report}` : ''}`
    }
    case 'failed':
      return `✗ 失败：${show(event.file)}：${event.error}`
    case 'error':
      return `! ${event.message}`
    case 'stopped':
      return `已停止监听。${event.interrupted ? `${show(event.interrupted)} 没有分析完，下次启动时继续。` : ''}`
  }
}

export function formatAnalyzeProgress(event: AnalyzeProgress): string {
  if (event.type === 'planned') return `  分成 ${event.chunks} 块，预计输入约 ${event.estimate.input_tokens} token`
  if (event.type === 'chunk') return `  块 ${event.summary.chunk + 1}：${event.summary.status === 'ok' ? `${event.summary.findings.length} 条观点` : event.summary.status}`
  return `  合并成 ${event.themes} 个主题`
}
