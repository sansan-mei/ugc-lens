import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativePicker, pickerCommand } from '../../src/ui/picker.ts'

function windowsScript(args: string[]): string {
  const i = args.indexOf('-EncodedCommand')
  assert.ok(i >= 0, '脚本用 -EncodedCommand 传入，避免命令行引号转义')
  return Buffer.from(args[i + 1]!, 'base64').toString('utf16le')
}

test('picker：按系统选择原生文件对话框命令，不经过 shell', () => {
  const mac = pickerCommand('darwin', {}, 'data')!
  assert.equal(mac.command, 'osascript')
  assert.match(mac.args.join(' '), /choose file/)

  const win = pickerCommand('win32', {}, 'report')!
  assert.equal(win.command, 'powershell.exe')
  assert.ok(win.args.includes('-STA'))
  const script = windowsScript(win.args)
  assert.match(script, /OpenFileDialog/)
  assert.match(script, /\*\.md/)

  const linux = pickerCommand('linux', { DISPLAY: ':0' }, 'data', (name) => name === 'zenity')!
  assert.equal(linux.command, 'zenity')
  assert.ok(linux.args.includes('--file-selection'))
  assert.equal(pickerCommand('linux', { DISPLAY: ':0' }, 'data', (name) => name === 'kdialog')!.command, 'kdialog')
})

test('picker：没有图形环境或对话框程序时返回 undefined，界面改用浏览器选择文件', () => {
  assert.equal(pickerCommand('linux', {}, 'data', () => true), undefined)
  assert.equal(pickerCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'data', () => false), undefined)
  assert.equal(pickerCommand('freebsd', { DISPLAY: ':0' }, 'data', () => false), undefined)
})

test('picker：选中返回路径，取消返回 null，命令无法运行时返回 undefined', async () => {
  const picked = createNativePicker({ platform: 'darwin', env: {}, run: async () => ({ code: 0, stdout: '/Users/a/数据 1.json\n' }) })
  assert.equal(picked.available, true)
  assert.equal(await picked.pick('data'), '/Users/a/数据 1.json')

  const cancelled = createNativePicker({ platform: 'darwin', env: {}, run: async () => ({ code: 1, stdout: '' }) })
  assert.equal(await cancelled.pick('data'), null)

  const broken = createNativePicker({ platform: 'darwin', env: {}, run: async () => { throw Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' }) } })
  assert.equal(await broken.pick('data'), undefined)

  const none = createNativePicker({ platform: 'linux', env: {}, run: async () => ({ code: 0, stdout: '/x' }) })
  assert.equal(none.available, false)
  assert.equal(await none.pick('data'), undefined)
})

test('picker：Windows 对话框由后台进程弹出时要显示在浏览器前面', () => {
  const script = windowsScript(pickerCommand('win32', {}, 'data')!.args)
  assert.match(script, /选择要分析的数据文件/)
  const at = (pattern: RegExp) => {
    const m = pattern.exec(script)
    assert.ok(m, `脚本缺少 ${pattern}`)
    return m.index
  }
  const dialog = at(/\.ShowDialog\(\$owner\)/)
  // 隐藏的置顶窗口不足以压过前台浏览器：先把可见的置顶宿主窗口显示出来，
  // 再借用前台窗口线程的输入状态取得前台权限
  assert.ok(at(/TopMost\s*=\s*\$true/) < dialog)
  assert.ok(at(/\$owner\.Show\(\)/) < dialog)
  assert.ok(at(/AttachThreadInput/) < dialog)
  assert.ok(at(/SetForegroundWindow\(\$owner\.Handle\)/) < dialog)
  // 编译 Win32 声明可能被系统策略拦截，失败时仍要弹出对话框
  assert.ok(at(/try\s*\{[^]*Add-Type -Namespace/) < at(/catch/))
  assert.ok(at(/catch/) < dialog)
  assert.ok(at(/\$owner\.Close\(\)/) > dialog)
})
