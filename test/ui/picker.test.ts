import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativePicker, pickerCommand } from '../../src/ui/picker.ts'

test('picker：按系统选择原生文件对话框命令，不经过 shell', () => {
  const mac = pickerCommand('darwin', {}, 'data')!
  assert.equal(mac.command, 'osascript')
  assert.match(mac.args.join(' '), /choose file/)

  const win = pickerCommand('win32', {}, 'report')!
  assert.equal(win.command, 'powershell.exe')
  assert.ok(win.args.includes('-STA'))
  assert.match(win.args.at(-1)!, /OpenFileDialog/)
  assert.match(win.args.at(-1)!, /\*\.md/)

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
