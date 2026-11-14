import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseUiArgs, startUi } from '../../src/cli/ui.ts'
import { readInstance } from '../../src/ui/instance.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-cli-ui-'))
const home = join(root, 'home')
after(() => rmSync(root, { recursive: true, force: true }))

const tokenOf = (url: string) => new URL(url).hash.replace('#token=', '')

test('ui 参数：--desktop 默认关闭', () => {
  assert.equal(parseUiArgs([]).desktop, false)
  assert.equal(parseUiArgs(['--desktop']).desktop, true)
})

test('ui：不带 --desktop 时不写实例记录，也不会因空闲退出', async () => {
  const opened: string[] = []
  const ui = await startUi(['--cwd', root, '--port', '0'], { homeDir: home, open: (url) => opened.push(url), log: () => {}, idleMs: 1, checkMs: 5 })
  try {
    assert.deepEqual(opened, [ui.url])
    assert.equal(await readInstance(home), undefined)
    const state = await Promise.race([ui.done.then(() => 'stopped'), new Promise((done) => setTimeout(() => done('running'), 50))])
    assert.equal(state, 'running')
  } finally { ui.stop(); await ui.done }
})

test('ui --desktop：写入实例记录，网页退出后服务停止并删除记录', async () => {
  const ui = await startUi(['--cwd', root, '--desktop', '--no-open'], { homeDir: home, open: () => assert.fail('不应打开浏览器'), log: () => {} })
  const info = await readInstance(home)
  assert.equal(info?.pid, process.pid)
  assert.equal(info?.cwd, root)
  assert.equal(info?.token, tokenOf(ui.url))
  const res = await fetch(new URL('/api/quit', ui.url), { method: 'POST', headers: { 'x-ugc-lens-token': tokenOf(ui.url) } })
  assert.equal(res.status, 200)
  await ui.done
  assert.equal(await readInstance(home), undefined)
})

test('ui --desktop：页面没有请求超过空闲时间后自动退出', async () => {
  const ui = await startUi(['--cwd', root, '--desktop', '--no-open'], { homeDir: home, log: () => {}, idleMs: 30, checkMs: 10 })
  await ui.done
  assert.equal(await readInstance(home), undefined)
})
