import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError } from './common.ts'

export const UI_USAGE = `用法：ugc-lens ui [--cwd <目录>] [--port <端口>] [--no-open]

在本机启动图形界面，浏览器查看数据概况、图表、原文和报告，并可与数据对话（需要模型配置）。
  --cwd <目录>   可打开的数据和报告所在目录，默认当前目录；只能访问这个目录内的文件
  --port <端口>  监听端口，默认随机空闲端口；只监听 127.0.0.1
  --no-open      不自动打开浏览器，只打印网址

网址里带有本次启动生成的令牌，不要分享给他人。按 Ctrl+C 停止。`

export function parseUiArgs(argv: readonly string[]): { cwd: string; port: number; open: boolean } {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { cwd: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean', default: false } } })
  if (positionals.length) throw new UsageError('ui 不接受位置参数，请用 --cwd 指定目录')
  const port = values.port === undefined ? 0 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port 需要 0～65535 的整数，收到 ${values.port}`)
  return { cwd: resolve(values.cwd ?? process.cwd()), port, open: !values['no-open'] }
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* 没有图形环境时只打印网址 */ }
}

export async function runUi(argv: readonly string[]): Promise<void> {
  const args = parseUiArgs(argv)
  try {
    if (!(await stat(args.cwd)).isDirectory()) throw new Error('不是目录')
  } catch { throw new UsageError(`目录不存在：${args.cwd}`) }
  const { createUiServer } = await import('../ui/server.ts')
  const ui = createUiServer({ cwd: args.cwd })
  await new Promise<void>((resolveListen, reject) => {
    ui.server.once('error', reject)
    ui.server.listen(args.port, '127.0.0.1', () => resolveListen())
  })
  const address = ui.server.address()
  const port = typeof address === 'object' && address ? address.port : args.port
  const url = ui.url(port)
  console.log(`ugc-lens 界面已启动：${url}\n目录：${args.cwd}\n按 Ctrl+C 停止。`)
  if (args.open) openBrowser(url)
  await new Promise<void>((done) => {
    const stop = () => { void ui.close().finally(() => { ui.server.close(() => done()); ui.server.closeAllConnections() }) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
