import type { AgentModel } from '../agent/model.ts'
import { classifyTopics, type TopicDefinition } from '../analysis/topics.ts'
import type { Dataset, FeedbackKind } from '../dataset/types.ts'
import type { PlaybookSnapshot } from '../memory/playbook.ts'
import { analyzeDataset } from './analyze.ts'

export interface TopicRunOptions {
  dataset: Dataset
  model: AgentModel
  playbook: PlaybookSnapshot
  /** 不提供时先从原文发现主题和纳入标准 */
  topics?: readonly TopicDefinition[]
  kinds?: readonly FeedbackKind[]
  contentId?: string
  tokenBudget: number
  signal?: AbortSignal
}

export type TopicRun =
  | { result: Awaited<ReturnType<typeof classifyTopics>>; discovery?: { calls: number; usage: unknown; coverage: unknown } }
  | { result?: undefined; discovery?: { calls: number; usage: unknown; coverage: unknown }; note: string }

/**
 * 主题统计：没有给出主题时先用分析流水线发现主题（最多 20 个，预算不超过 15000），再逐条多标签归类。
 * analyze_topics 工具和界面的自动分析共用。
 */
export async function discoverAndClassifyTopics(options: TopicRunOptions): Promise<TopicRun> {
  const { dataset, model, kinds, contentId: content_id, tokenBudget, signal } = options
  let definitions = options.topics
  let discovery: { calls: number; usage: unknown; coverage: unknown } | undefined
  if (!definitions) {
    const scoped = { ...dataset, items: dataset.items.filter((i) => (!kinds || kinds.includes(i.kind)) && (!content_id || i.content_id === content_id)) }
    const found = await analyzeDataset({ dataset: scoped, model, playbook: options.playbook, outDir: false, minSupport: 1, tokenBudget: Math.min(tokenBudget, 15_000), signal })
    definitions = found.themes.slice(0, 20).map((t, i) => ({ id: `T${i + 1}`, title: t.title.slice(0, 100), criteria: [...new Set(t.sources.map((s) => found.summary.findings[s]?.criteria).filter(Boolean))].join('；').slice(0, 300) || t.title.slice(0, 300) }))
    discovery = { calls: found.calls, usage: found.usage, coverage: found.coverage }
    if (!definitions.length) return { discovery, note: '发现阶段没有得到可核验的主题，未执行逐条归类；可显式提供 topics。' }
  }
  const result = await classifyTopics({ dataset, model, topics: definitions, kinds, contentId: content_id, tokenBudget, signal })
  return { result, discovery }
}
