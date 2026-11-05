import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentModel } from '../agent/model.ts'
import { summarizeDanmaku, type DanmakuSummary } from '../analysis/danmaku.ts'
import { countTerms, createTokenizerFor, topTerms } from '../analysis/keywords.ts'
import { computeStats, type DatasetStats } from '../dataset/stats.ts'
import type { Dataset } from '../dataset/types.ts'
import type { Usage } from '../llm/types.ts'
import { loadPlaybook, playbookInfo, type MemoryOptions, type PlaybookInfo, type PlaybookSnapshot } from '../memory/playbook.ts'
import { recordOutcome } from '../memory/learnings.ts'
import { planChunks, type ChunkPlan } from './chunk.ts'
import { analysisCoverage } from '../analysis/coverage.ts'
import { mergeFindings, type MergeResult, type Theme } from './merge.ts'
import { renderReport } from './report.ts'
import {
  defaultDirections,
  estimateSummarize,
  summarizeChunks,
  type ChunkSummary,
  type SummarizeResult,
  type TokenEstimate,
} from './summarize.ts'

export type AnalyzeProgress =
  | { type: 'planned'; chunks: number; estimate: TokenEstimate }
  | { type: 'chunk'; summary: ChunkSummary }
  | { type: 'merged'; themes: number; called: boolean }

export interface AnalyzeOptions {
  memory?: MemoryOptions
  playbook?: PlaybookSnapshot
  model: AgentModel
  dataset: Dataset
  /** 分析方向，默认四个；传入关注点时只分析这些方向 */
  directions?: readonly string[]
  /** 交给模型的评论总字数，默认 80000 */
  maxTotalChars?: number
  concurrency?: number
  tokenBudget?: number
  minSupport?: number
  /** 写进报告的模型名 */
  modelName?: string
  /** 报告保存目录，默认 <cwd>/.ugc-lens/reports；false 时不保存 */
  outDir?: string | false
  cwd?: string
  signal?: AbortSignal
  onProgress?: (event: AnalyzeProgress) => void
  /** 测试时固定时间 */
  now?: () => Date
}

export interface AnalyzeResult {
  coverage: ReturnType<typeof analysisCoverage>
  playbook: PlaybookInfo
  memory_warning?: string
  markdown: string
  /** 保存的报告路径，outDir 为 false 时没有 */
  path?: string
  themes: Theme[]
  stats: DatasetStats
  plan: ChunkPlan
  danmaku?: DanmakuSummary
  summary: SummarizeResult
  merge: MergeResult
  calls: number
  usage: Required<Usage>
  duration_ms: number
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 固定流水线：代码统计 → 分块 → 分块总结 → 合并 → 写报告。模型只参与总结和合并 */
export async function analyzeDataset(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const playbook = options.playbook ?? loadPlaybook(options.memory)
  const started = performance.now()
  const now = options.now ?? (() => new Date())
  const { dataset } = options
  const directions = options.directions?.length ? options.directions : defaultDirections(dataset)

  const stats = computeStats(dataset)
  const { tokenizer } = createTokenizerFor(dataset.items.map((item) => item.text))
  const comments = dataset.items.filter((item) => item.kind !== 'danmaku')
  const keywords = topTerms(countTerms(comments, tokenizer), 20)
  const danmaku = stats.items.danmaku > 0 ? summarizeDanmaku(dataset.items, tokenizer) : undefined
  const plan = planChunks(dataset, { danmaku, maxTotalChars: options.maxTotalChars })
  options.onProgress?.({ type: 'planned', chunks: plan.chunks.length, estimate: estimateSummarize({ dataset, plan, directions, playbook }) })

  const summary = await summarizeChunks({
    model: options.model,
    playbook,
    dataset,
    plan,
    directions,
    concurrency: options.concurrency,
    tokenBudget: options.tokenBudget,
    signal: options.signal,
    onChunk: (s) => options.onProgress?.({ type: 'chunk', summary: s }),
  })
  const merge = await mergeFindings({
    model: options.model,
    playbook,
    findings: summary.findings,
    directions,
    minSupport: options.minSupport,
    signal: options.signal,
  })
  options.onProgress?.({ type: 'merged', themes: merge.themes.length, called: merge.called })

  const usage: Required<Usage> = {
    input_tokens: summary.usage.input_tokens + (merge.usage?.input_tokens ?? 0),
    output_tokens: summary.usage.output_tokens + (merge.usage?.output_tokens ?? 0),
    cached_input_tokens: summary.usage.cached_input_tokens + (merge.usage?.cached_input_tokens ?? 0),
  }
  const calls = summary.calls + (merge.called ? 1 : 0)
  const generatedAt = now()
  const duration_ms = Math.round(performance.now() - started)
  const coverage = analysisCoverage(dataset, plan, summary.chunks)
  const markdown = renderReport({
    dataset,
    stats,
    coverage: plan.coverage,
    keywords,
    danmaku,
    themes: merge.themes,
    directions,
    ledger: coverage,
    run: {
      playbook: playbookInfo(playbook),
      generated_at: generatedAt,
      duration_ms,
      calls,
      usage,
      model: options.modelName,
      total_chunks: plan.chunks.length,
      incomplete_chunks: summary.chunks.filter((c) => c.status !== 'ok').length,
    },
  })

  let path: string | undefined
  if (options.outDir !== false) {
    const dir = options.outDir ?? join(options.cwd ?? process.cwd(), '.ugc-lens', 'reports')
    await mkdir(dir, { recursive: true })
    path = join(dir, `${dataset.id}-${stamp(generatedAt)}.md`)
    await writeFile(path, markdown)
  }

  const memory_warning = options.signal?.aborted ? undefined : await recordOutcome(options.memory, [dataset], {
    kind: 'analysis', playbook: playbookInfo(playbook),
    observations: {
      chunks: plan.chunks.length,
      failed_chunks: summary.chunks.filter((c) => c.status === 'failed').length,
      skipped_chunks: summary.chunks.filter((c) => c.status === 'skipped').length,
      unknown_refs: summary.chunks.reduce((n, c) => n + c.dropped.unknown_ref, 0),
      bad_quotes: summary.chunks.reduce((n, c) => n + c.dropped.bad_quote, 0),
      merge_invalid_refs: merge.invalid_refs, merge_fallback: Boolean(merge.error), themes: merge.themes.length, calls,
    },
  })
  return { coverage, playbook: playbookInfo(playbook), memory_warning, markdown, path, themes: merge.themes, stats, plan, danmaku, summary, merge, calls, usage, duration_ms }
}
