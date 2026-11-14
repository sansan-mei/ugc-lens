import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { findRunning } from '../ui/instance.ts'

/**
 * 桌面单文件包的双击启动（docs/architecture.md 第 2.1 节“退出与桌面单实例”）。
 * 双击时不直接起服务：macOS 对已在运行的应用再次双击只会激活它，不会再启动进程，
 * 单文件 Node 程序又收不到“重新打开”事件。所以这里是一个很快退出的启动器：
 * 有界面在运行就打开它的页面，没有就在后台启动自身进入桌面模式，然后退出。
 */

/** 没有参数时是双击启动；旧版 macOS 从访达启动时会带一个 -psn_ 开头的进程序列号参数，按没有参数处理 */
export function isDoubleClick(args: readonly string[]): boolean {
  return args.every((arg) => arg.startsWith('-psn_'))
}

/**
 * 工作目录用 ~/ugc-lens 而不是用户目录本身：用户目录下的 .ugc-lens 是全局配置目录，
 * 把它当项目目录会让项目配置和全局配置成为同一个文件。
 */
export function desktopUiArgs(home: string): { args: string[]; workdir: string } {
  const workdir = join(home, 'ugc-lens')
  return { args: ['ui', '--cwd', workdir, '--desktop'], workdir }
}

export interface LaunchDeps {
  home: string
  /** 单文件包自身的路径（process.execPath） */
  execPath: string
  open: (url: string) => void
  spawn: (command: string, args: readonly string[], options: { detached: boolean; stdio: ['ignore', number, number]; windowsHide: boolean }) => { unref: () => void }
}

export async function launchDesktop(deps: LaunchDeps): Promise<'reused' | 'started'> {
  const { args, workdir } = desktopUiArgs(deps.home)
  const running = await findRunning(deps.home, workdir)
  if (running) {
    deps.open(running)
    return 'reused'
  }
  mkdirSync(workdir, { recursive: true })
  const uiDir = join(deps.home, '.ugc-lens', 'ui')
  mkdirSync(uiDir, { recursive: true, mode: 0o700 })
  // 后台进程没有终端，启动失败等输出写进日志，排查时有据可查
  const log = openSync(join(uiDir, 'desktop.log'), 'a', 0o600)
  try {
    deps.spawn(deps.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  } finally { closeSync(log) }
  return 'started'
}
