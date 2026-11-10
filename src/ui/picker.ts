import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 原生文件选择框。`ugc-lens ui` 只监听 127.0.0.1，服务和浏览器在同一台机器上，
 * 由服务弹出系统对话框就能拿到文件的真实路径（浏览器的文件选择只给内容不给路径）。
 * 没有图形环境（如 SSH 转发端口）时不可用，界面改为在浏览器里选择文件后上传内容。
 */

export type PickKind = 'data' | 'report'

export interface PickerCommand { command: string; args: string[] }

const PROMPT: Record<PickKind, string> = { data: '选择要分析的数据文件', report: '选择 Markdown 报告' }
const PATTERNS: Record<PickKind, string[]> = {
  data: ['*.json', '*.jsonl', '*.ndjson', '*.csv', '*.tsv', '*.txt', '*.md', '*.markdown', '*.log'],
  report: ['*.md', '*.markdown'],
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try { accessSync(join(dir, name), constants.X_OK); return true } catch { /* 下一个目录 */ }
  }
  return false
}

export function pickerCommand(platform: NodeJS.Platform | string, env: NodeJS.ProcessEnv, kind: PickKind, has: (name: string) => boolean = (name) => onPath(name, env)): PickerCommand | undefined {
  if (platform === 'darwin') {
    // 先激活 osascript 自身（不需要额外授权），否则对话框可能躲在浏览器后面；取消时退出码为 1
    return { command: 'osascript', args: ['-e', 'activate', '-e', `POSIX path of (choose file with prompt "${PROMPT[kind]}")`] }
  }
  if (platform === 'win32') {
    const filter = kind === 'data' ? `数据文件|${PATTERNS.data.join(';')}|所有文件|*.*` : `Markdown|${PATTERNS.report.join(';')}`
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      `$dialog.Title = '${PROMPT[kind]}'`,
      `$dialog.Filter = '${filter}'`,
      "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.FileName } else { exit 1 }",
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script] }
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined
  if (has('zenity')) return { command: 'zenity', args: ['--file-selection', `--title=${PROMPT[kind]}`, `--file-filter=${PATTERNS[kind].join(' ')}`, '--file-filter=* '] }
  if (has('kdialog')) return { command: 'kdialog', args: ['--title', PROMPT[kind], '--getopenfilename', env.HOME ?? '.', PATTERNS[kind].join(' ')] }
  return undefined
}

type Runner = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>

const runCommand: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', windowsHide: false, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error && typeof error.code !== 'number') return reject(error)
    resolve({ code: error ? Number(error.code) : 0, stdout })
  })
})

export interface NativePicker {
  available: boolean
  /** 选中返回路径；用户取消返回 null；无法弹出对话框返回 undefined */
  pick(kind: PickKind): Promise<string | null | undefined>
}

export function createNativePicker(deps: { platform?: NodeJS.Platform | string; env?: NodeJS.ProcessEnv; run?: Runner } = {}): NativePicker {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const run = deps.run ?? runCommand
  const probe = pickerCommand(platform, env, 'data')
  let busy: Promise<string | null | undefined> | undefined
  return {
    available: probe !== undefined,
    pick(kind) {
      const command = pickerCommand(platform, env, kind)
      if (!command) return Promise.resolve(undefined)
      // 同一时间只弹一个对话框，重复点击等待同一个结果
      busy ??= run(command.command, command.args)
        .then(({ code, stdout }) => {
          const path = stdout.trim()
          return code === 0 && path ? path : null
        })
        .catch(() => undefined)
        .finally(() => { busy = undefined })
      return busy
    },
  }
}
