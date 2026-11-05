import type { RunEventListener } from '../agent/events.ts'
import { runAgent, type AgentLimits, type AgentRunResult } from '../agent/loop.ts'
import type { AgentModel } from '../agent/model.ts'
import { findCitations } from '../dataset/query.ts'
import { createDatasetStore } from '../dataset/store.ts'
import type { Dataset } from '../dataset/types.ts'
import { createDataTools, type DataToolOptions } from '../tools/data/index.ts'

export const ASK_SYSTEM_PROMPT = `你是用户互动内容（评论、回复、弹幕、回答）的分析助手。用户已经导入了数据集，你通过工具查询数据来回答问题。

做法：
1. 先用 get_dataset_stats 了解数据集概况。只有一个数据集时不用填 dataset_id，也不用先调用 list_datasets。
2. 用 search_feedback 按关键词、类型、点赞数等筛选，必要时翻页或换关键词多查几次；用 get_feedback 看全文和回复链。
3. 证据够了再回答，不要查个没完。

回答要求：
- 每个结论后面用 [ID] 标出依据，ID 必须是工具结果里出现过的，如“很多人觉得标题夸张 [1003] [1006]”。不要编造 ID。
- 说清楚结论有多少条内容支持（如“搜索到 23 条相关评论”），区分“多数人”和“个别人”。
- 数据只是搜集到的样本：回复往往不完整，弹幕没有发布时间。数据不足以回答时直接说明，不要猜。
- 引用原文时保持原样，不要改写成别的意思。
- 使用中文，结构清楚、简洁。`

export interface AskOptions {
  model: AgentModel
  datasets: readonly Dataset[]
  question: string
  /** 之前的对话，用于连续追问 */
  history?: AgentRunResult['messages']
  limits?: Partial<AgentLimits>
  tools?: DataToolOptions
  signal?: AbortSignal
  onEvent?: RunEventListener
}

export interface AskResult {
  answer: string
  /** 回答里引用的 ID：存在于数据集的，以及不存在的（模型编造或写错） */
  citations: { valid: string[]; invalid: string[] }
  run: AgentRunResult
}

export const ASK_LIMITS: Partial<AgentLimits> = { maxSteps: 12 }

/** 追问的核心函数，命令行、代码调用、MCP 都通过它 */
export async function askDataset(options: AskOptions): Promise<AskResult> {
  const store = createDatasetStore(options.datasets)
  const history = options.history?.length ? options.history : [{ role: 'system' as const, content: ASK_SYSTEM_PROMPT }]
  const run = await runAgent({
    model: options.model,
    messages: [...history, { role: 'user', content: options.question }],
    tools: createDataTools(store, options.tools),
    limits: { ...ASK_LIMITS, ...options.limits },
    signal: options.signal,
    onEvent: options.onEvent,
  })
  return { answer: run.answer, citations: findCitations(run.answer, options.datasets), run }
}
