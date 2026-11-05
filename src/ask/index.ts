import type { RunEventListener } from '../agent/events.ts'
import { runAgent, type AgentLimits, type AgentRunResult } from '../agent/loop.ts'
import type { AgentModel } from '../agent/model.ts'
import { findCitations } from '../dataset/query.ts'
import { createDatasetStore } from '../dataset/store.ts'
import type { Dataset } from '../dataset/types.ts'
import { DEFAULT_PLAYBOOK, loadPlaybook, playbookRules, promptPlaybookInfo, type MemoryOptions, type PlaybookInfo, type PlaybookSnapshot } from '../memory/playbook.ts'
import { createMemoryTools } from '../memory/tools.ts'
import { recordOutcome } from '../memory/learnings.ts'
import { createDataTools, type DataToolOptions } from '../tools/data/index.ts'

export function buildAskPrompt(playbook: PlaybookSnapshot): string {
  return `你是文本记录与用户互动内容（问卷、工单、访谈、评论、回复等）的分析助手。用户已经导入了数据集，你通过工具查询数据来回答问题。

${playbookRules(playbook, 'ask')}

引用 ID 必须出现在工具返回的数据中，不得编造。`
}
export const ASK_SYSTEM_PROMPT = buildAskPrompt(DEFAULT_PLAYBOOK)

export interface AskOptions {
  model: AgentModel
  memory?: MemoryOptions
  playbook?: PlaybookSnapshot
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
  playbook?: PlaybookInfo
  memory_warning?: string
  answer: string
  /** 回答里引用的 ID：存在于数据集的，以及不存在的（模型编造或写错） */
  citations: { valid: string[]; invalid: string[] }
  run: AgentRunResult
}

export const ASK_LIMITS: Partial<AgentLimits> = { maxSteps: 12 }

/** 追问的核心函数，命令行、代码调用、MCP 都通过它 */
export async function askDataset(options: AskOptions): Promise<AskResult> {
  const store = createDatasetStore(options.datasets)
  const history = options.history?.length ? options.history : [{ role: 'system' as const, content: buildAskPrompt(options.playbook ?? loadPlaybook(options.memory)) }]
  const playbook = promptPlaybookInfo(history.find((m) => m.role === 'system')?.content ?? '')
  const run = await runAgent({
    model: options.model,
    messages: [...history, { role: 'user', content: options.question }],
    tools: [...createDataTools(store, options.tools), ...(options.memory ? createMemoryTools(store, options.memory, playbook) : [])],
    limits: { ...ASK_LIMITS, ...options.limits },
    signal: options.signal,
    onEvent: options.onEvent,
  })
  const citations = findCitations(run.answer, options.datasets)
  const memory_warning = options.signal?.aborted || run.stop_reason === 'aborted' ? undefined : await recordOutcome(options.memory, options.datasets, {
    kind: 'ask', playbook,
    observations: { steps: run.steps.length, stop_reason: run.stop_reason, valid_citations: citations.valid.length, invalid_citations: citations.invalid.length },
  })
  return { answer: run.answer, citations, run, playbook, memory_warning }
}
