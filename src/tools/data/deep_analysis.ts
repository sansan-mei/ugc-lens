import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import type { AgentModel } from '../../agent/model.ts'
import { analysisCoverage } from '../../analysis/coverage.ts'
import { contentTimeline } from '../../analysis/content_timeline.ts'
import { classifyTopics, topicSchema } from '../../analysis/topics.ts'
import { analyzeBusiness } from '../../analysis/business.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import { FEEDBACK_KINDS } from '../../dataset/types.ts'
import { visibleProfile } from '../../memory/profile.ts'
import { loadPlaybook, type MemoryOptions } from '../../memory/playbook.ts'
import { analyzeDataset } from '../../pipeline/analyze.ts'
import { defineTool } from '../define.ts'
import { datasetIdParam, resolveDataset } from './shared.ts'

async function persist(cwd: string, category: string, value: unknown) {
  const dir = join(cwd, '.ugc-lens', category)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}.json`)
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  return path
}
export function createDeepAnalysisTools(store: DatasetStore, model?: AgentModel, memory?: MemoryOptions) {
  const query = [
    defineTool({ name: 'get_analysis_coverage', description: '导入阶段各集合数量、跳过和重复正文信号。未运行模型时不宣称已分析；重复不等于水军。', parameters: z.object({ dataset_id: datasetIdParam }), async execute({ dataset_id }) { return JSON.stringify(analysisCoverage(resolveDataset(store, dataset_id))) } }),
    defineTool({ name: 'get_content_timeline', description: '按单个内容对齐弹幕窗口和字幕原文，标记高峰及引用 ID。无字幕时不猜内容，不推断因果。支持分页，推荐用中文表格展示。', parameters: z.object({ dataset_id: datasetIdParam, content_id: z.string().optional(), bin_sec: z.number().int().min(1).max(300).default(30), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }), async execute({ dataset_id, content_id, bin_sec, offset, limit }) { return JSON.stringify(contentTimeline(resolveDataset(store, dataset_id), { contentId: content_id, binSec: bin_sec, offset, limit })) } }),
  ]
  if (!model) return query
  const selection = { dataset_id: datasetIdParam, kinds: z.array(z.enum(FEEDBACK_KINDS)).min(1).optional(), content_id: z.string().optional(), token_budget: z.number().int().min(1).max(200_000).default(30_000) }
  return [...query,
    defineTool({ name: 'analyze_topics', description: '先发现主题和纳入标准（或提供 topics），再分批逐条多标签归类，由代码计算准确样本内占比。返回分母、覆盖率和完整逐条结果路径；发现阶段用量单独返回。用表格展示，不用模型估计主题比例。', parameters: z.object({ ...selection, topics: z.array(topicSchema).min(1).max(20).optional() }), async execute({ dataset_id, topics, kinds, content_id, token_budget }, ctx) {
      const dataset = resolveDataset(store, dataset_id)
      let definitions = topics
      let discovery: { calls: number; usage: unknown; coverage: unknown } | undefined
      if (!definitions) {
        const scoped = { ...dataset, items: dataset.items.filter((i) => (!kinds || kinds.includes(i.kind)) && (!content_id || i.content_id === content_id)) }
        const found = await analyzeDataset({ dataset: scoped, model, playbook: loadPlaybook(memory), outDir: false, minSupport: 1, tokenBudget: Math.min(token_budget, 15_000), signal: ctx.signal })
        definitions = found.themes.slice(0, 20).map((t, i) => ({ id: `T${i + 1}`, title: t.title.slice(0, 100), criteria: [...new Set(t.sources.map((s) => found.summary.findings[s]?.criteria).filter(Boolean))].join('；').slice(0, 300) || t.title.slice(0, 300) }))
        discovery = { calls: found.calls, usage: found.usage, coverage: found.coverage }
        if (!definitions.length) return JSON.stringify({ dataset_id: dataset.id, discovery, topics: [], note: '发现阶段没有得到可核验的主题，未执行逐条归类；可显式提供 topics。' })
      }
      const result = await classifyTopics({ dataset, model, topics: definitions, kinds, contentId: content_id, tokenBudget: token_budget, signal: ctx.signal })
      ctx.signal.throwIfAborted()
      const path = await persist(ctx.cwd, 'topics', { ...result, discovery })
      const { records, ...summary } = result
      return JSON.stringify({ ...summary, discovery, path, issues: records.filter((r) => r.status !== 'processed').slice(0, 3) })
    } }),
    defineTool({ name: 'analyze_business', description: '可选商业分析：从实际原文识别痛点、购买意愿、价格、竞品和转化阻力，附摘句、假设、最小验证动作、投入及优先级。不凑数，不编 ROI。可参考已开启的本地画像；优先用表格呈现。', parameters: z.object({ ...selection, goal: z.string().max(300).optional() }), async execute({ dataset_id, kinds, content_id, token_budget, goal }, ctx) {
      const background = memory ? visibleProfile(memory) : undefined
      const result = await analyzeBusiness({ dataset: resolveDataset(store, dataset_id), model, goal, background, kinds, contentId: content_id, tokenBudget: token_budget, signal: ctx.signal })
      ctx.signal.throwIfAborted()
      const path = await persist(ctx.cwd, 'business', result)
      const { records, opportunities, ...summary } = result
      return JSON.stringify({ ...summary, path, opportunities: opportunities.slice(0, 15), opportunities_total: opportunities.length, omitted: Math.max(0, opportunities.length - 15), issues: records.filter((r) => r.status !== 'processed').slice(0, 3) })
    } }),
  ]
}
