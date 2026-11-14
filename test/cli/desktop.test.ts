import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { desktopUiArgs, isDoubleClick, launchDesktop } from '../../src/cli/desktop.ts'
import { writeInstance } from '../../src/ui/instance.ts'
import { createUiServer } from '../../src/ui/server.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-desktop-'))
after(() => rmSync(root, { recursive: true, force: true }))

test('没有参数，或只有 macOS 旧版本附带的进程序列号参数，视为双击启动', () => {
  assert.equal(isDoubleClick([]), true)
  assert.equal(isDoubleClick(['-psn_0_12345']), true)
  for (const args of [['--version'], ['ui', '--no-open'], ['analyze', 'a.json', '-psn_x']]) assert.equal(isDoubleClick(args), false)
})

test('桌面界面目录放在用户目录下，不与全局配置目录重叠，并以桌面模式启动', () => {
  const home = join('/home', 'someone')
  const { args, workdir } = desktopUiArgs(home)
  assert.equal(workdir, join(home, 'ugc-lens'))
  assert.notEqual(workdir, join(home, '.ugc-lens'))
  assert.deepEqual(args, ['ui', '--cwd', workdir, '--desktop'])
})

function recorder() {
  const opened: string[] = []
  const spawned: Array<{ command: string; args: readonly string[]; options: { detached?: boolean } }> = []
  return {
    opened, spawned,
    open: (url: string) => { opened.push(url) },
    spawn: (command: string, args: readonly string[], options: { detached?: boolean }) => { spawned.push({ command, args, options }); return { unref: () => {} } },
  }
}

test('双击时已有界面在运行：直接打开已有页面，不再启动服务', async () => {
  const home = join(root, 'running')
  const { workdir } = desktopUiArgs(home)
  const ui = createUiServer({ cwd: workdir, homeDir: home })
  await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done))
  const port = (ui.server.address() as AddressInfo).port
  try {
    await writeInstance(home, { pid: process.pid, port, token: ui.token, cwd: workdir })
    const r = recorder()
    assert.equal(await launchDesktop({ home, execPath: '/app/ugc-lens', open: r.open, spawn: r.spawn }), 'reused')
    assert.deepEqual(r.opened, [ui.url(port)])
    assert.equal(r.spawned.length, 0)
  } finally {
    ui.server.closeAllConnections()
    await new Promise((done) => ui.server.close(done))
  }
})

test('双击时没有界面在运行：建好目录，后台启动自身进入桌面模式，启动器本身不打开浏览器', async () => {
  const home = join(root, 'fresh')
  const r = recorder()
  assert.equal(await launchDesktop({ home, execPath: '/app/ugc-lens', open: r.open, spawn: r.spawn }), 'started')
  const { args, workdir } = desktopUiArgs(home)
  assert.ok(existsSync(workdir))
  assert.equal(r.spawned.length, 1)
  assert.equal(r.spawned[0]?.command, '/app/ugc-lens')
  assert.deepEqual(r.spawned[0]?.args, args)
  assert.equal(r.spawned[0]?.options.detached, true)
  assert.deepEqual(r.opened, [])
  assert.ok(existsSync(join(home, '.ugc-lens', 'ui', 'desktop.log')))
})
