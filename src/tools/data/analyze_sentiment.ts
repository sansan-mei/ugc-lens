import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import type { AgentModel } from '../../agent/model.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import { FEEDBACK_KINDS } from '../../dataset/types.ts'
import { analyzeSentiment } from '../../sentiment/index.ts'
import { defineTool } from '../define.ts'
import { datasetIdParam, resolveDataset } from './shared.ts'

export function createAnalyzeSentimentTool(store: DatasetStore, model: AgentModel) {
  return defineTool({
    name: 'analyze_sentiment',
    description: '分批调用 AI 对原文逐条评分（-1～1），代码精确汇总情感数量、比例、均值、覆盖率和类型分布。情感分析或情感比例问题优先使用；不要靠少数检索结果估计比例。返回汇总、引用示例和完整逐条 JSON 路径；最后据此解读，说明未评估部分。会使用模型 token，默认预算 30000。',
    parameters: z.object({
      dataset_id: datasetIdParam,
      target: z.string().trim().min(1).max(200).optional().describe('评价对象，例如某产品；不填评估文本整体情绪。情感不等于支持/反对立场'),
      kinds: z.array(z.enum(FEEDBACK_KINDS)).min(1).optional(),
      content_id: z.string().min(1).optional(),
      token_budget: z.number().int().min(1).max(200_000).default(30_000),
    }),
    async execute({ dataset_id, target, kinds, content_id, token_budget }, ctx) {
      const result = await analyzeSentiment({ dataset: resolveDataset(store, dataset_id), model, target, kinds, contentId: content_id, tokenBudget: token_budget, signal: ctx.signal })
      ctx.signal.throwIfAborted()
      const dir = join(ctx.cwd, '.ugc-lens', 'sentiment')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${randomUUID()}.json`)
      await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600 })
      const { records, ...overview } = result
      const examples = ['positive', 'neutral', 'negative', 'mixed', 'uncertain'].flatMap((label) => records.filter((row) => label === 'uncertain' ? row.status === 'uncertain' : row.status === 'scored' && (row.mixed ? 'mixed' : row.score! > 0.2 ? 'positive' : row.score! < -0.2 ? 'negative' : 'neutral') === label).slice(0, 2))
      const issues = records.filter((row) => row.status === 'failed' || row.status === 'skipped').slice(0, 2)
      return JSON.stringify({ ...overview, path, examples, issues })
    },
  })
}
