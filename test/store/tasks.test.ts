import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { openTaskStore, type Task } from '../../src/store/tasks.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ugc-tasks-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const task = (file: string, partial: Partial<Task> = {}): Task => ({ file, status: 'pending', added_at: '2026-11-05T00:00:00.000Z', ...partial })

test('文件不存在时从空列表开始；写入后重新打开能读到', async () => {
  const path = join(dir, 'sub', 'tasks.json')
  const store = await openTaskStore(path)
  assert.deepEqual(store.list(), [])
  await store.put(task('/a'))
  await store.put(task('/a', { status: 'done', report: '/r.md' }))
  const again = await openTaskStore(path)
  assert.deepEqual(again.list(), [task('/a', { status: 'done', report: '/r.md' })])
})

test('同时写入多次，最后磁盘上的内容包含全部任务', async () => {
  const path = join(dir, 'tasks.json')
  const store = await openTaskStore(path)
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(task(`/f${i}`))))
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.tasks.length, 20)
  assert.equal((await openTaskStore(path)).list().length, 20)
})

test('返回的是副本，改了不影响存储', async () => {
  const store = await openTaskStore(join(dir, 'tasks.json'))
  await store.put(task('/a'))
  store.get('/a')!.status = 'done'
  store.list()[0]!.status = 'failed'
  assert.equal(store.get('/a')?.status, 'pending')
})

test('内容损坏时报错，不清空', async () => {
  const path = join(dir, 'tasks.json')
  await writeFile(path, '{"version": 1, "tasks": [')
  await assert.rejects(openTaskStore(path), /任务文件格式不对/)
  await writeFile(path, JSON.stringify({ version: 1, tasks: [{ file: '/a', status: 'unknown' }] }))
  await assert.rejects(openTaskStore(path), /任务文件格式不对/)
  assert.match(await readFile(path, 'utf8'), /unknown/)
})
