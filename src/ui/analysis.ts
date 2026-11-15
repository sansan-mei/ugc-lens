import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentModel } from '../agent/model.ts'
import { readConfigSection, writeGlobalSection } from '../config.ts'
import type { Dataset } from '../dataset/types.ts'
import { loadPlaybook } from '../memory/playbook.ts'
import { discoverAndClassifyTopics } from '../pipeline/topics.ts'
import { analyzeSentiment } from '../sentiment/index.ts'
import { HttpError } from './http.ts'

/**
 * 界面的自动分析（docs/architecture.md 第 2.1 节“自动分析”）：打开数据后在后台跑情感分析和主题统计，
 * 结果按文件内容存放在 <主目录>/.ugc-lens/ui/analysis/<内容摘要>/<任务>.json：同样内容的文件不管放在哪、
 * 从哪个启动目录打开，都先用已有结果。概况页与宿主模式结果一起展示。
 * 默认开启（会消耗模型 token），可在设置页“分析”里关闭；概况页也可以手动开始或重新分析。
 */

export const ANALYSIS_TASKS = ['sentiment', 'topics'] as const
export type AnalysisTask = typeof ANALYSIS_TASKS[number]
export const isAnalysisTask = (value: string): value is AnalysisTask => (ANALYSIS_TASKS as readonly string[]).includes(value)

export const DEFAULT_ANALYSIS_BUDGET = 30_000
const MAX_ANALYSIS_BUDGET = 1_000_000

export interface AnalysisSettings { auto_sentiment: boolean; auto_topics: boolean; token_budget: number }
interface UiConfigFile { auto_sentiment?: boolean; auto_topics?: boolean; analysis_token_budget?: number }

export function describeAnalysisSettings(homeDir: string): AnalysisSettings {
  const ui = readConfigSection<UiConfigFile>(homeDir, 'ui')
  const budget = ui.analysis_token_budget
  return {
    // 默认开启（用户要求）；只有明确写了 false 才关闭
    auto_sentiment: ui.auto_sentiment !== false,
    auto_topics: ui.auto_topics !== false,
    token_budget: typeof budget === 'number' && Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_ANALYSIS_BUDGET,
  }
}

export function parseAnalysisSettings(body: unknown): Partial<AnalysisSettings> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: Partial<AnalysisSettings> = {}
  for (const field of ['auto_sentiment', 'auto_topics'] as const) {
    if (raw[field] === undefined) continue
    if (typeof raw[field] !== 'boolean') throw new HttpError(400, `${field} 必须是 true 或 false`)
    out[field] = raw[field]
  }
  if (raw.token_budget !== undefined) {
    const budget = raw.token_budget
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1000 || budget > MAX_ANALYSIS_BUDGET) throw new HttpError(400, `每项预算需要 1000～${MAX_ANALYSIS_BUDGET} 之间的整数`)
    out.token_budget = budget
  }
  return out
}

/** 写入全局配置 ui 字段，没有提供的项保持原值，ui 下的其他字段保留 */
export function saveAnalysisSettings(draft: Partial<AnalysisSettings>, homeDir: string): AnalysisSettings {
  const current = describeAnalysisSettings(homeDir)
  const next = { ...current, ...draft }
  const ui = readConfigSection<UiConfigFile & Record<string, unknown>>(homeDir, 'ui')
  writeGlobalSection('ui', { ...ui, auto_sentiment: next.auto_sentiment, auto_topics: next.auto_topics, analysis_token_budget: next.token_budget }, homeDir)
  return next
}

export interface JobStatus { state: 'idle' | 'running' | 'done' | 'error'; error?: string; started_at?: string; finished_at?: string }

/** 概况页用的结果摘要，形状与宿主模式的标注结果一致 */
export interface AnalysisResultSummary { task: AnalysisTask; source: 'model'; dir: string; summary: unknown; counts: unknown; coverage: number; created_at: string }

/** items：分析时的条数；同样内容按不同规则导入出的条数不同时，不复用 */
interface SavedResult extends Omit<AnalysisResultSummary, 'dir' | 'source'> { result: unknown; items?: number }

type TaskRun = (dataset: Dataset, model: AgentModel, budget: number, signal: AbortSignal) => Promise<Omit<SavedResult, 'task' | 'created_at'>>

export interface AnalysisRunnerOptions {
  cwd: string
  homeDir: string
  /** 分析用的模型；没有配置时抛出 ConfigError，任务状态记为错误 */
  model: () => AgentModel
}

export interface AnalysisRunner {
  /** onlyIfMissing：已有结果时不重跑（打开数据时自动分析用） */
  start(dataset: Dataset, task: AnalysisTask, options?: { onlyIfMissing?: boolean }): 'started' | 'running' | 'exists'
  status(dataset: Dataset): Record<AnalysisTask, JobStatus>
  results(dataset: Dataset): Promise<AnalysisResultSummary[]>
  /** 等待当前所有任务结束（测试与退出用） */
  idle(): Promise<void>
  /** 取消进行中的分析 */
  close(): Promise<void>
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/

const runSentiment: TaskRun = async (dataset, model, budget, signal) => {
  const result = await analyzeSentiment({ dataset, model, tokenBudget: budget, signal })
  const { records: _records, ...rest } = result
  return {
    summary: { target: result.target, summary: result.summary, note: result.note, scope_note: result.stop_reason === 'completed' ? undefined : `未全部完成（${result.stop_reason === 'token_budget' ? '达到预算' : '部分批次失败'}），比例只代表已评估部分。` },
    counts: { calls: result.calls, stop_reason: result.stop_reason },
    coverage: result.summary.coverage,
    result: { ...rest, records: result.records },
  }
}

function runTopics(cwd: string, homeDir: string): TaskRun {
  return async (dataset, model, budget, signal) => {
    const run = await discoverAndClassifyTopics({ dataset, model, playbook: loadPlaybook({ cwd, homeDir }), tokenBudget: budget, signal })
    if (!run.result) throw new Error(run.note)
    const records = run.result.records
    const processed = records.filter((r) => r.status === 'processed').length
    return {
      summary: { topics: run.result.topics, unclassified: run.result.unclassified, uncertain: run.result.uncertain, note: run.result.note },
      counts: { calls: run.result.calls, processed, total: records.length },
      coverage: records.length ? processed / records.length : 0,
      result: { ...run.result, discovery: run.discovery },
    }
  }
}

export function createAnalysisRunner(options: AnalysisRunnerOptions): AnalysisRunner {
  const base = join(options.homeDir, '.ugc-lens', 'ui', 'analysis')
  const keyOf = (dataset: Dataset) => {
    const key = dataset.content_digest ?? `id-${dataset.id}`
    if (!SAFE_ID.test(key)) throw new HttpError(400, '数据集标识不合法')
    return key
  }
  const fileOf = (dataset: Dataset, task: AnalysisTask) => join(base, keyOf(dataset), `${task}.json`)
  const readSaved = (file: string, dataset: Dataset): SavedResult | undefined => {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedResult
      return saved.items === undefined || saved.items === dataset.items.length ? saved : undefined
    } catch { return undefined }
  }
  const findSaved = (dataset: Dataset, task: AnalysisTask): { saved: SavedResult; dir: string } | undefined => {
    for (const file of [fileOf(dataset, task)]) {
      if (!file || !existsSync(file)) continue
      const saved = readSaved(file, dataset)
      if (saved) return { saved, dir: dirname(file) }
    }
    return undefined
  }
  const jobs = new Map<string, JobStatus & { promise?: Promise<void> }>()
  const lifetime = new AbortController()
  const runs: Record<AnalysisTask, TaskRun> = { sentiment: runSentiment, topics: runTopics(options.cwd, options.homeDir) }

  const execute = async (dataset: Dataset, task: AnalysisTask, job: JobStatus) => {
    try {
      const model = options.model()
      const { token_budget } = describeAnalysisSettings(options.homeDir)
      const out = await runs[task](dataset, model, token_budget, lifetime.signal)
      lifetime.signal.throwIfAborted()
      const saved: SavedResult = { task, created_at: new Date().toISOString(), items: dataset.items.length, ...out }
      const file = fileOf(dataset, task)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, JSON.stringify(saved), { mode: 0o600 })
      await rename(temp, file)
      Object.assign(job, { state: 'done', finished_at: new Date().toISOString() })
    } catch (error) {
      Object.assign(job, { state: 'error', error: lifetime.signal.aborted ? '服务退出，分析已取消' : (error as Error).message, finished_at: new Date().toISOString() })
    }
  }

  return {
    start(dataset, task, startOptions = {}) {
      // 按内容记任务：同样内容的两个文件不会同时各跑一份
      const key = `${keyOf(dataset)}:${task}`
      if (jobs.get(key)?.state === 'running') return 'running'
      if (startOptions.onlyIfMissing && findSaved(dataset, task)) return 'exists'
      const job: JobStatus & { promise?: Promise<void> } = { state: 'running', started_at: new Date().toISOString() }
      jobs.set(key, job)
      job.promise = execute(dataset, task, job)
      return 'started'
    },
    status(dataset) {
      const out = {} as Record<AnalysisTask, JobStatus>
      for (const task of ANALYSIS_TASKS) {
        const job = jobs.get(`${keyOf(dataset)}:${task}`)
        if (job) { const { promise: _p, ...status } = job as JobStatus & { promise?: unknown }; out[task] = status }
        else out[task] = { state: findSaved(dataset, task) ? 'done' : 'idle' }
      }
      return out
    },
    async results(dataset) {
      const out: AnalysisResultSummary[] = []
      for (const task of ANALYSIS_TASKS) {
        const found = findSaved(dataset, task)
        if (found) out.push({ task, source: 'model', dir: found.dir, summary: found.saved.summary, counts: found.saved.counts, coverage: found.saved.coverage, created_at: found.saved.created_at })
      }
      return out
    },
    async idle() {
      for (;;) {
        const pending = [...jobs.values()].filter((j) => j.state === 'running').map((j) => j.promise)
        if (!pending.length) return
        await Promise.all(pending)
      }
    },
    async close() {
      lifetime.abort()
      await this.idle()
    },
  }
}
