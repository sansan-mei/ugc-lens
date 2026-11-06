import type { TaskUsage } from '../agent/usage.ts'
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Usage } from '../llm/types.ts'
import type { Task, TaskStore } from '../store/tasks.ts'
import { compilePatterns, DEFAULT_PATTERNS, scanFiles } from './pattern.ts'

export interface AnalyzeOutcome {
  task_usage?: TaskUsage
  report?: string
  calls: number
  usage: Required<Usage>
}

export type QueueReason = 'new' | 'existing' | 'resume' | 'retry'

export type WatchEvent =
  | { type: 'watching'; dir: string; patterns: string[]; ignored: number; resumed: number }
  | { type: 'queued'; file: string; reason: QueueReason }
  | { type: 'started'; file: string; waiting: number }
  | { type: 'done'; file: string; task: Task }
  | { type: 'failed'; file: string; error: string }
  /** 监听或扫描本身出错，不影响已经排队的任务 */
  | { type: 'error'; message: string }
  /** interrupted：被取消的那个任务，下次启动时继续 */
  | { type: 'stopped'; interrupted?: string }

export interface WatchOptions {
  dir: string
  store: TaskStore
  analyze: (file: string, signal: AbortSignal) => Promise<AnalyzeOutcome>
  signal: AbortSignal
  /** 默认 *_all.json */
  patterns?: readonly string[]
  /** 启动时目录里已有的文件也分析 */
  existing?: boolean
  /** 启动时重试失败的任务 */
  retryFailed?: boolean
  /** 文件大小和修改时间连续不变多久才算写完，默认 2000 */
  settleMs?: number
  /** 定时扫描间隔，补上 fs.watch 漏掉的事件，默认 30000 */
  scanIntervalMs?: number
  /** fs.watch 收到变化后等多久再扫描，合并一连串的事件，默认 300 */
  debounceMs?: number
  onEvent?: (event: WatchEvent) => void
}

const now = () => new Date().toISOString()

async function fileState(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file)
    return info.isFile() ? `${info.size}:${info.mtimeMs}` : undefined
  } catch {
    return undefined
  }
}

/** 等到文件连续 settleMs 没有变化；文件消失时返回 false */
async function waitStable(file: string, settleMs: number, signal: AbortSignal): Promise<boolean> {
  let previous = await fileState(file)
  while (previous !== undefined) {
    await sleep(settleMs, undefined, { signal })
    const current = await fileState(file)
    if (current === previous) return true
    previous = current
  }
  return false
}

/**
 * 监听目录，新出现的匹配文件写完后排队分析，一次一个。
 * signal 取消后停止监听并取消正在进行的分析，返回的 Promise 在一切停下后完成。
 */
export async function watchDirectory(options: WatchOptions): Promise<void> {
  const { store, signal } = options
  const dir = resolve(options.dir)
  const patterns = [...(options.patterns?.length ? options.patterns : DEFAULT_PATTERNS)]
  const match = compilePatterns(patterns)
  const settleMs = options.settleMs ?? 2_000
  const emit = (event: WatchEvent) => options.onEvent?.(event)

  const queue: string[] = []
  /** 启动时已有、按设置不分析的文件，只在本次运行里记住 */
  const ignored = new Set<string>()
  const settling = new Set<string>()
  let wake: (() => void) | undefined

  const enqueue = (file: string, reason: QueueReason) => {
    queue.push(file)
    emit({ type: 'queued', file, reason })
    wake?.()
  }
  const add = async (file: string, reason: QueueReason) => {
    await store.put({ file, status: 'pending', added_at: now() })
    enqueue(file, reason)
  }

  let resumed = 0
  for (const task of store.list()) {
    const retry = task.status === 'failed' && options.retryFailed
    if (task.status === 'pending' || task.status === 'running' || retry) {
      await store.put({ file: task.file, status: 'pending', added_at: task.added_at })
      enqueue(task.file, retry ? 'retry' : 'resume')
      resumed++
    }
  }
  for (const file of await scanFiles(dir, match)) {
    if (store.get(file)) continue
    if (options.existing) await add(file, 'existing')
    else ignored.add(file)
  }
  emit({ type: 'watching', dir, patterns, ignored: ignored.size, resumed })

  const settle = async (file: string) => {
    settling.add(file)
    try {
      if (await waitStable(file, settleMs, signal)) await add(file, 'new')
    } catch (error) {
      if (!signal.aborted) emit({ type: 'error', message: `${file}：${(error as Error).message}` })
    } finally {
      settling.delete(file)
    }
  }

  let scanning: Promise<void> | undefined
  let rescan = false
  const scan = (): Promise<void> => {
    if (scanning) {
      rescan = true
      return scanning
    }
    scanning = (async () => {
      do {
        rescan = false
        try {
          for (const file of await scanFiles(dir, match)) {
            if (!store.get(file) && !ignored.has(file) && !settling.has(file)) void settle(file)
          }
        } catch (error) {
          emit({ type: 'error', message: `扫描 ${dir} 失败：${(error as Error).message}` })
        }
      } while (rescan && !signal.aborted)
    })().finally(() => {
      scanning = undefined
    })
    return scanning
  }

  let debounce: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(dir, { recursive: true }, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void scan(), options.debounceMs ?? 300)
    })
    watcher.on('error', (error) => emit({ type: 'error', message: `监听出错，改为只靠定时扫描：${error.message}` }))
  } catch (error) {
    emit({ type: 'error', message: `无法监听目录，改为只靠定时扫描：${(error as Error).message}` })
  }
  const interval = setInterval(() => void scan(), options.scanIntervalMs ?? 30_000)

  let interrupted: string | undefined
  const work = async () => {
    while (!signal.aborted) {
      const file = queue.shift()
      if (!file) {
        await new Promise<void>((done) => {
          const onAbort = () => done()
          signal.addEventListener('abort', onAbort, { once: true })
          wake = () => {
            signal.removeEventListener('abort', onAbort)
            done()
          }
        })
        wake = undefined
        continue
      }
      const task = store.get(file)
      if (!task || task.status !== 'pending') continue
      const running: Task = { ...task, status: 'running', started_at: now() }
      await store.put(running)
      emit({ type: 'started', file, waiting: queue.length })
      try {
        const outcome = await options.analyze(file, signal)
        const done: Task = { ...running, status: 'done', finished_at: now(), report: outcome.report, calls: outcome.calls, usage: outcome.usage, task_usage: outcome.task_usage }
        await store.put(done)
        emit({ type: 'done', file, task: done })
      } catch (error) {
        const task_usage = (error as { task_usage?: TaskUsage }).task_usage
        if (task_usage) await store.put({ ...running, task_usage })
        // 被取消的任务保持 running，下次启动时接着做
        if (signal.aborted) {
          interrupted = file
          break
        }
        const message = (error as Error).message
        await store.put({ ...running, status: 'failed', finished_at: now(), error: message, task_usage })
        emit({ type: 'failed', file, error: message })
      }
    }
  }

  try {
    await work()
  } finally {
    clearInterval(interval)
    clearTimeout(debounce)
    watcher?.close()
    await scanning
    emit({ type: 'stopped', interrupted })
  }
}
