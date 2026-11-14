import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError } from './common.ts'

export const UI_USAGE = `用法：ugc-lens ui [--cwd <目录>] [--port <端口>] [--no-open] [--desktop]

在本机启动图形界面，浏览器查看数据概况、图表、原文和报告，并可与数据对话（需要模型配置）。
  --cwd <目录>   可打开的数据和报告所在目录，默认当前目录；只能访问这个目录内的文件
  --port <端口>  监听端口，默认随机空闲端口；只监听 127.0.0.1
  --no-open      不自动打开浏览器，只打印网址
  --desktop      桌面版使用：记录运行中的实例供再次双击时复用，页面关闭 10 分钟后自动退出

网址里带有本次启动生成的令牌，不要分享给他人。按 Ctrl+C 或界面“设置”里的“退出 ugc-lens”停止。`

export function parseUiArgs(argv: readonly string[]): { cwd: string; port: number; open: boolean; desktop: boolean } {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { cwd: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean', default: false }, desktop: { type: 'boolean', default: false } } })
  if (positionals.length) throw new UsageError('ui 不接受位置参数，请用 --cwd 指定目录')
  const port = values.port === undefined ? 0 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port 需要 0～65535 的整数，收到 ${values.port}`)
  return { cwd: resolve(values.cwd ?? process.cwd()), port, open: !values['no-open'], desktop: values.desktop }
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* 没有图形环境时只打印网址 */ }
}

export interface UiDeps {
  homeDir?: string
  open?: (url: string) => void
  log?: (line: string) => void
  /** 桌面模式的空闲退出时间与检查间隔；测试注入 */
  idleMs?: number
  checkMs?: number
}

export interface RunningUi {
  url: string
  /** 停止服务（关闭对话会话和所有连接） */
  stop: () => void
  /** 服务完全停止、实例记录清理后完成 */
  done: Promise<void>
}

export async function startUi(argv: readonly string[], deps: UiDeps = {}): Promise<RunningUi> {
  const args = parseUiArgs(argv)
  try {
    if (!(await stat(args.cwd)).isDirectory()) throw new Error('不是目录')
  } catch { throw new UsageError(`目录不存在：${args.cwd}`) }
  const home = deps.homeDir ?? homedir()
  const log = deps.log ?? ((line: string) => console.log(line))
  const { createUiServer } = await import('../ui/server.ts')
  const { DESKTOP_IDLE_MS, idleExpired, removeInstance, writeInstance } = await import('../ui/instance.ts')

  let stopping: Promise<void> | undefined
  let finish: () => void = () => {}
  const done = new Promise<void>((resolveDone) => { finish = resolveDone })
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    stopping ??= (async () => {
      if (timer) clearInterval(timer)
      await ui.close().catch(() => {})
      await new Promise<void>((closed) => { ui.server.close(() => closed()); ui.server.closeAllConnections() })
      if (args.desktop) await removeInstance(home, process.pid).catch(() => {})
      finish()
    })()
  }
  const ui = createUiServer({ cwd: args.cwd, homeDir: home, onQuit: stop })
  await new Promise<void>((resolveListen, reject) => {
    ui.server.once('error', reject)
    ui.server.listen(args.port, '127.0.0.1', () => resolveListen())
  })
  const address = ui.server.address()
  const port = typeof address === 'object' && address ? address.port : args.port
  const url = ui.url(port)
  if (args.desktop) {
    await writeInstance(home, { pid: process.pid, port, token: ui.token, cwd: args.cwd })
    const idleMs = deps.idleMs ?? DESKTOP_IDLE_MS
    timer = setInterval(() => {
      if (idleExpired(ui.activity(), Date.now(), idleMs)) { log('页面已关闭一段时间，自动退出。'); stop() }
    }, deps.checkMs ?? 30_000)
    timer.unref()
  }
  log(`ugc-lens 界面已启动：${url}\n目录：${args.cwd}\n按 Ctrl+C 或界面“设置”里的“退出 ugc-lens”停止。`)
  if (args.open) (deps.open ?? openBrowser)(url)
  return { url, stop, done }
}

export async function runUi(argv: readonly string[]): Promise<void> {
  const running = await startUi(argv)
  process.once('SIGINT', running.stop)
  process.once('SIGTERM', running.stop)
  await running.done
  process.off('SIGINT', running.stop)
  process.off('SIGTERM', running.stop)
}
