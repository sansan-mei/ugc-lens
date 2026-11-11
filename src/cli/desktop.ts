import { join } from 'node:path'

/**
 * 桌面单文件包的启动参数：双击启动时没有任何参数，直接进入界面。
 * 工作目录用 ~/ugc-lens 而不是用户目录本身：用户目录下的 .ugc-lens 是全局配置目录，
 * 把它当项目目录会让项目配置和全局配置成为同一个文件。
 * 旧版 macOS 从访达启动时会带一个 -psn_ 开头的进程序列号参数，按没有参数处理。
 */
export function desktopArgs(args: readonly string[], home: string): { args: string[]; workdir?: string } {
  if (args.some((arg) => !arg.startsWith('-psn_'))) return { args: [...args] }
  const workdir = join(home, 'ugc-lens')
  return { args: ['ui', '--cwd', workdir], workdir }
}
