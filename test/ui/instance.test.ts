import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { findRunning, idleExpired, instancePath, readInstance, removeInstance, writeInstance } from '../../src/ui/instance.ts'
import { createUiServer } from '../../src/ui/server.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-instance-'))
const home = join(root, 'home')
const cwd = root
const ui = createUiServer({ cwd, token: 'live-token', homeDir: home })
let port = 0
before(async () => { await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done)); port = (ui.server.address() as AddressInfo).port })
after(async () => { ui.server.closeAllConnections(); await new Promise((done) => ui.server.close(done)); rmSync(root, { recursive: true, force: true }) })

test('实例记录：写入后可读回，权限 600，只删除自己写的那份', async () => {
  const info = { pid: 4242, port: 1, token: 't', cwd }
  await writeInstance(home, info)
  assert.deepEqual(await readInstance(home), info)
  if (process.platform !== 'win32') assert.equal(statSync(instancePath(home)).mode & 0o777, 0o600)
  await removeInstance(home, 9999)
  assert.deepEqual(await readInstance(home), info)
  await removeInstance(home, 4242)
  assert.equal(await readInstance(home), undefined)
})

test('查找运行中的界面：令牌与目录都对上才复用，返回带令牌的网址', async () => {
  assert.equal(await findRunning(home, cwd), undefined)
  await writeInstance(home, { pid: process.pid, port, token: 'live-token', cwd })
  assert.equal(await findRunning(home, cwd), ui.url(port))
  assert.equal(await findRunning(home, join(cwd, 'other')), undefined)
  await writeInstance(home, { pid: process.pid, port, token: 'stale-token', cwd })
  assert.equal(await findRunning(home, cwd), undefined)
})

test('查找运行中的界面：端口上没有服务时按没有实例处理', async () => {
  const free = createUiServer({ cwd, homeDir: home })
  await new Promise<void>((done) => free.server.listen(0, '127.0.0.1', done))
  const closedPort = (free.server.address() as AddressInfo).port
  await new Promise((done) => free.server.close(done))
  await writeInstance(home, { pid: process.pid, port: closedPort, token: free.token, cwd })
  assert.equal(await findRunning(home, cwd), undefined)
})

test('空闲判断：有进行中的请求时不退出，超过空闲时间才退出', () => {
  assert.equal(idleExpired({ inflight: 1, last: 0 }, 1_000_000, 10), false)
  assert.equal(idleExpired({ inflight: 0, last: 1000 }, 1005, 10), false)
  assert.equal(idleExpired({ inflight: 0, last: 1000 }, 1011, 10), true)
})
