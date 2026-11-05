import { spawn } from 'node:child_process'
import * as z from 'zod'
import { ApprovalDeniedError } from '../approval.ts'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'
import { isReadOnlyCommand } from './command_policy.ts'

export interface RunCommandOptions {
  timeoutMs?: number
  /** 返回给模型的最大字符数，超出时保留开头和结尾 */
  maxOutputChars?: number
}

/** 收集输出时只保留开头和结尾，命令输出很大时也不会占满内存 */
class OutputBuffer {
  private head = ''
  private tail = ''
  private total = 0
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  push(text: string): void {
    this.total += text.length
    if (this.head.length < this.max) {
      const take = this.max - this.head.length
      this.head += text.slice(0, take)
      text = text.slice(take)
    }
    if (text) this.tail = (this.tail + text).slice(-this.max)
  }

  toString(): string {
    const all = this.head + this.tail
    if (this.total <= this.max) return all
    const half = Math.floor(this.max / 2)
    const first = all.slice(0, half)
    const last = all.slice(-half)
    return `${first}\n…（输出过长，中间省略 ${this.total - first.length - last.length} 个字符）…\n${last}`
  }
}

/** 不把模型提供商的 key 传给子进程，避免命令把它打印出来 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.endsWith('_API_KEY')) delete env[name]
  }
  return env
}

export function createRunCommandTool(options: RunCommandOptions = {}): AgentTool {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxOutputChars = options.maxOutputChars ?? 10_000

  return defineTool({
    name: 'run_command',
    description:
      `在工作目录下用 shell 执行一条命令，返回退出码和输出（stdout 与 stderr 合并）。超过 ${timeoutMs / 1000} 秒会被终止，` +
      `输出超过 ${maxOutputChars} 个字符时只保留开头和结尾。` +
      'ls、cat、rg、git status 等只读命令直接执行，其他命令需要用户确认；用户拒绝时会返回错误。' +
      '命令不能交互输入。',
    parameters: z.object({
      command: z.string().regex(/\S/, '命令不能为空').describe('要执行的 shell 命令'),
    }),

    async execute({ command }, ctx) {

      if (!isReadOnlyCommand(command)) {
        const approved = await ctx.approve({ kind: 'run_command', command, cwd: ctx.cwd })
        if (!approved) throw new ApprovalDeniedError(`用户拒绝执行命令：${command}`)
      }
      ctx.signal.throwIfAborted()

      const useGroup = process.platform !== 'win32'
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // 单独的进程组，超时时能连同子进程一起结束
        detached: useGroup,
      })

      const output = new OutputBuffer(maxOutputChars)
      child.stdout.setEncoding('utf8').on('data', (text: string) => output.push(text))
      child.stderr.setEncoding('utf8').on('data', (text: string) => output.push(text))

      let stopped: 'timeout' | 'aborted' | undefined
      const kill = (reason: 'timeout' | 'aborted') => {
        stopped ??= reason
        try {
          if (useGroup && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          // 进程已经退出
        }
      }
      const timer = setTimeout(() => kill('timeout'), timeoutMs)
      const onAbort = () => kill('aborted')
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (exitCode) => resolve(exitCode))
        })
        const text = output.toString() || '（无输出）'
        if (stopped === 'timeout') throw new Error(`命令超过 ${timeoutMs / 1000} 秒，已终止。已有输出：\n${text}`)
        if (stopped === 'aborted') throw new Error('运行已取消，命令已终止')
        return `退出码：${code ?? '无'}\n${text}`
      } finally {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}
