import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, test } from 'node:test'
import { openTaskStore, type TaskStore } from '../../src/store/tasks.ts'
import { watchDirectory, type AnalyzeOutcome, type WatchEvent, type WatchOptions } from '../../src/watch/index.ts'

const OUTCOME: AnalyzeOutcome = { report: '/report.md', calls: 2, usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } }

let root: string
let data: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ugc-watch-'))
  data = join(root, 'data')
  await mkdir(data)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, text = '{}') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** 启动监听，返回事件列表和等待/停止的辅助函数 */
async function start(store: TaskStore, partial: Partial<WatchOptions> = {}) {
  const controller = new AbortController()
  const events: WatchEvent[] = []
  const analyzed: string[] = []
  const done = watchDirectory({
    dir: data,
    store,
    signal: controller.signal,
    settleMs: 30,
    scanIntervalMs: 50,
    debounceMs: 10,
    analyze: async (file) => {
      analyzed.push(file)
      return OUTCOME
    },
    onEvent: (event) => events.push(event),
    ...partial,
  })
  const waitFor = async (predicate: (e: WatchEvent) => boolean, count = 1, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (events.filter(predicate).length < count) {
      if (Date.now() > deadline) throw new Error(`等待事件超时：${JSON.stringify(events)}`)
      await sleep(10)
    }
  }
  await waitFor((e) => e.type === 'watching')
  const stop = async () => {
    controller.abort()
    await done
  }
  return { events, analyzed, waitFor, stop, controller, done }
}

test('已有文件默认不分析；新出现的匹配文件分析一次，覆盖后也不重复；不匹配的不管', async () => {
  const old = join(data, 'old', 'bilibili_all.json')
  await put(old)
  const store = await openTaskStore(join(root, 'tasks.json'))
  const w = await start(store)
  assert.deepEqual(w.events[0], { type: 'watching', dir: data, patterns: ['*_all.json'], ignored: 1, resumed: 0 })

  const fresh = join(data, 'v1', 'bilibili_all.json')
  await put(join(data, 'v1', 'bilibili_comment.json'))
  await put(fresh)
  await w.waitFor((e) => e.type === 'done')
  assert.deepEqual(w.analyzed, [fresh])
  const task = store.get(fresh)
  assert.equal(task?.status, 'done')
  assert.equal(task?.report, OUTCOME.report)
  assert.deepEqual(task?.usage, OUTCOME.usage)
  assert.ok(task?.started_at && task.finished_at)

  await put(fresh, '{"changed": true}')
  await put(old, '{"changed": true}')
  await sleep(200)
  await w.stop()
  assert.deepEqual(w.analyzed, [fresh])
  assert.deepEqual(w.events.at(-1), { type: 'stopped', interrupted: undefined })
})

test('--existing：启动时已有的文件也分析，已经在任务列表里的跳过', async () => {
  const a = join(data, 'a_all.json')
  const b = join(data, 'b_all.json')
  await put(a)
  await put(b)
  const store = await openTaskStore(join(root, 'tasks.json'))
  await store.put({ file: b, status: 'done', added_at: new Date().toISOString() })
  const w = await start(store, { existing: true })
  await w.waitFor((e) => e.type === 'done')
  await w.stop()
  assert.deepEqual(w.analyzed, [a])
  assert.ok(w.events.some((e) => e.type === 'queued' && e.reason === 'existing'))
})

test('重启续跑：pending 和 running 的任务重新排队；失败的只在 retryFailed 时重试', async () => {
  const path = join(root, 'tasks.json')
  const store = await openTaskStore(path)
  const added_at = new Date().toISOString()
  await store.put({ file: '/x/pending_all.json', status: 'pending', added_at })
  await store.put({ file: '/x/running_all.json', status: 'running', added_at, started_at: added_at })
  await store.put({ file: '/x/failed_all.json', status: 'failed', added_at, error: '旧错误' })

  const w = await start(await openTaskStore(path))
  await w.waitFor((e) => e.type === 'done', 2)
  await w.stop()
  assert.deepEqual(w.analyzed, ['/x/pending_all.json', '/x/running_all.json'])

  const r = await start(await openTaskStore(path), { retryFailed: true })
  await r.waitFor((e) => e.type === 'done')
  await r.stop()
  assert.deepEqual(r.analyzed, ['/x/failed_all.json'])
  const retried = (await openTaskStore(path)).get('/x/failed_all.json')
  assert.equal(retried?.status, 'done')
  assert.equal(retried?.error, undefined)
})

test('分析失败记为 failed，继续做下一个；同一时间只分析一个', async () => {
  const store = await openTaskStore(join(root, 'tasks.json'))
  let active = 0
  let peak = 0
  const w = await start(store, {
    analyze: async (file) => {
      active++
      peak = Math.max(peak, active)
      await sleep(30)
      active--
      if (file.includes('bad')) throw new Error('导入失败')
      return OUTCOME
    },
  })
  await Promise.all(['bad_all.json', 'g1_all.json', 'g2_all.json'].map((name) => put(join(data, name))))
  await w.waitFor((e) => e.type === 'done' || e.type === 'failed', 3)
  await w.stop()
  assert.equal(peak, 1)
  const bad = store.get(join(data, 'bad_all.json'))
  assert.equal(bad?.status, 'failed')
  assert.equal(bad?.error, '导入失败')
  assert.equal(store.list().filter((t) => t.status === 'done').length, 2)
})

test('文件还在写的时候不开始，等大小不再变化', async () => {
  const store = await openTaskStore(join(root, 'tasks.json'))
  const contents: string[] = []
  const w = await start(store, {
    settleMs: 150,
    analyze: async (file) => {
      contents.push(await readFile(file, 'utf8'))
      return OUTCOME
    },
  })
  const file = join(data, 'slow_all.json')
  await put(file, '[1')
  for (let i = 0; i < 5; i++) {
    await sleep(60)
    await appendFile(file, ',1')
  }
  await appendFile(file, ']')
  await w.waitFor((e) => e.type === 'done')
  await w.stop()
  assert.deepEqual(contents, [`[1${',1'.repeat(5)}]`])
})

test('停止时取消正在进行的分析，任务保持 running，下次启动接着做', async () => {
  const path = join(root, 'tasks.json')
  const store = await openTaskStore(path)
  let cancelled = false
  const w = await start(store, {
    analyze: async (_file, signal) => {
      await sleep(10_000, undefined, { signal }).catch((error) => {
        cancelled = true
        throw error
      })
      return OUTCOME
    },
  })
  const file = join(data, 'long_all.json')
  await put(file)
  await w.waitFor((e) => e.type === 'started')
  await w.stop()
  assert.ok(cancelled)
  assert.equal((await openTaskStore(path)).get(file)?.status, 'running')
  assert.ok(!w.events.some((e) => e.type === 'failed'))
  assert.deepEqual(w.events.at(-1), { type: 'stopped', interrupted: file })
})

test('显式 pattern 可监听 TXT、JSONL 和 CSV，并通过共用导入器读取', async () => {
  const { loadDataset } = await import('../../src/ingest/index.ts')
  const { createFakeModel } = await import('../../src/agent/fake_model.ts')
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_mapping', args: { platform: 'unknown', collections: [{ kind: 'record', path: '$.rows', fields: { text: 'column_1', id: 'source_id' } }] } }] }, { content: '完成' }])
  const store = await openTaskStore(join(root, 'tasks.json'))
  const imported: string[] = []
  const w = await start(store, { patterns: ['*.txt', '*.jsonl', '*.csv'], analyze: async (file, signal) => {
    const dataset = await loadDataset(file, { signal, model, cacheDir: join(root, 'mappings') })
    assert.ok(dataset.items.every((item) => item.kind === 'record'))
    imported.push(dataset.items[0]!.text)
    return OUTCOME
  } })
  try {
    await put(join(data, 'a.txt'), '服务体验不错')
    await put(join(data, 'b.jsonl'), '"售后需要改进"')
    await put(join(data, 'c.csv'), '回答\n价格有点高')
    await w.waitFor((event) => event.type === 'done', 3)
    assert.deepEqual(new Set(imported), new Set(['服务体验不错', '售后需要改进', '价格有点高']))
  } finally { await w.stop() }
})
