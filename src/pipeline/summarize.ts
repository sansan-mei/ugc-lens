import { DEFAULT_PLAYBOOK, playbookRules, type PlaybookSnapshot } from '../memory/playbook.ts'
import * as z from 'zod'
import type { AgentModel } from '../agent/model.ts'
import { getFeedback } from '../dataset/query.ts'
import type { Dataset } from '../dataset/types.ts'
import { approxTokens } from '../llm/tokens.ts'
import type { ChatMessage, ToolDefinition, Usage } from '../llm/types.ts'
import { toParametersSchema } from '../tools/define.ts'
import type { Chunk, ChunkPlan } from './chunk.ts'
import { contentLabels } from './chunk.ts'

export const DEFAULT_DIRECTIONS = ['主要观点', '吐槽点', '正面评价', '争议'] as const

/** 原文超过这么多字时，模型才需要附上摘句；短内容报告里直接显示原文 */
export const LONG_TEXT_CHARS = 80

export interface FindingRef {
  id: string
  /** 只有原文较长时才有，已校验是原文的子串 */
  quote?: string
}

export interface Finding {
  chunk: number
  direction: string
  title: string
  /** 纳入标准：什么样的内容算这条观点 */
  criteria: string
  /** 模型估计这一块里有多少条支持 */
  support: number
  refs: FindingRef[]
}

/** 代码校验时丢掉的东西，按原因计数 */
export interface Dropped {
  /** 观点缺字段、类型不对或方向编号不存在 */
  invalid_finding: number
  /** 编号不在这一块里 */
  unknown_ref: number
  /** 摘句不是原文的子串，或者对应的编号不在 refs 里 */
  bad_quote: number
  /** 引用全部不合格，整条观点去掉 */
  no_valid_refs: number
  /** 超过观点数或每条引用数上限 */
  over_limit: number
}

export interface ChunkSummary {
  chunk: number
  status: 'ok' | 'failed' | 'skipped'
  findings: Finding[]
  dropped: Dropped
  usage?: Usage
  error?: string
}

export interface TokenEstimate {
  calls: number
  input_tokens: number
  output_tokens: number
}

export interface SummarizeOptions {
  playbook?: PlaybookSnapshot
  model: AgentModel
  dataset: Dataset
  plan: ChunkPlan
  /** 分析方向，默认 DEFAULT_DIRECTIONS；传入关注点时只分析这些方向 */
  directions?: readonly string[]
  /** 同时调用模型的块数，默认 4 */
  concurrency?: number
  /** 每块最多几条观点，默认 8 */
  maxFindings?: number
  /** 已用 token 达到这个数后不再开始新的块（软上限：进行中的块不受限） */
  tokenBudget?: number
  signal?: AbortSignal
  /** 每块结束（含失败、跳过）时调用，用来显示进度 */
  onChunk?: (summary: ChunkSummary) => void
}

export interface SummarizeResult {
  chunks: ChunkSummary[]
  findings: Finding[]
  calls: number
  usage: Required<Usage>
  estimate: TokenEstimate
  duration_ms: number
}

const TOOL_NAME = 'submit_findings'
const MAX_REFS = 5
/** 每条观点输出大约多少 token，只用于估算 */
const TOKENS_PER_FINDING = 70
/** 每次请求里消息格式本身占的 token，只用于估算 */
const TOKENS_PER_CALL = 100

function toolSchema(directions: number) {
  const finding = z.object({
    direction: z.number().int().min(1).max(directions).describe('分析方向的编号'),
    title: z.string().describe('一句话结论，不超过 30 字'),
    criteria: z.string().describe('纳入标准：什么样的内容算这条观点，不超过 30 字'),
    refs: z.array(z.number().int()).describe('2～5 个最能支持它的内容编号'),
    quotes: z
      .array(z.object({ ref: z.number().int(), text: z.string() }))
      .optional()
      .describe(`只给超过 ${LONG_TEXT_CHARS} 字的被引用内容写：照抄其中最能支持结论的一句，不超过 40 字`),
    support: z.number().int().min(0).describe('这一块里大约有多少条内容支持（“同样 +N”和“×N”算进去）'),
  })
  return z.object({ findings: z.array(finding).describe('这一块里的观点，没有值得写的就提交空数组') })
}

/** 校验时比模型看到的格式宽松：编号可以是 "3" 或 "[3]" */
const looseRef = z.union([z.number(), z.string()]).transform((value) => {
  const n = typeof value === 'number' ? value : Number(value.match(/\d+/)?.[0])
  return Number.isInteger(n) ? n : undefined
})
const looseFinding = z.object({
  direction: looseRef,
  title: z.string().trim().min(1),
  criteria: z.string().trim().min(1),
  refs: z.array(looseRef),
  quotes: z.array(z.object({ ref: looseRef, text: z.string() })).nullish(),
  support: looseRef.optional(),
})

function describeDataset(dataset: Dataset): string {
  const labels = contentLabels(dataset)
  const contents = dataset.contents.slice(0, 20).map((content) => {
    const title = content.title ?? '（无标题）'
    return labels ? `${labels.get(content.id)} ${title}` : title
  })
  const more = dataset.contents.length > 20 ? `\n……共 ${dataset.contents.length} 个` : ''
  return contents.length > 0 ? `数据来自 ${dataset.platform}，被评论的内容：\n${contents.join('\n')}${more}` : `数据来自 ${dataset.platform}。`
}

/** 各块的 system prompt 完全相同，请求开头一致，能命中提供商的提示词缓存 */
export function buildSystemPrompt(dataset: Dataset, plan: ChunkPlan, directions: readonly string[], maxFindings: number, playbook: PlaybookSnapshot = DEFAULT_PLAYBOOK): string {
  const hasDanmaku = plan.chunks.some((chunk) => chunk.kind === 'danmaku')
  const formats = [
    '- [编号] 赞数 回复数 日期 IP 属地 用户名：正文。以 ↳ 开头的是上一条的回复。“（同样 +N）”表示另有 N 条内容相同。',
  ]
  if (hasDanmaku) formats.push('- 弹幕块：[编号] ×重复次数 首次出现的时间 正文。')
  return `你在分析一批用户写的内容（评论、回复等）。内容分成若干块，每次给你一块，每行一条：
${formats.join('\n')}
没有的字段不显示。

任务：找出这一块里的观点，调用 ${TOOL_NAME} 一次性提交。
分析方向（direction 填编号）：
${directions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

要求：
${playbookRules(playbook, 'summarize')}
- 每条观点写一句结论（title）和纳入标准（criteria），都不超过 30 字。
- refs 填 2～5 个最能支持它的编号。
- 被引用的内容超过 ${LONG_TEXT_CHARS} 字时，在 quotes 里照抄其中最能支持结论的一句；短内容不要写 quotes。
- support 是这一块里大约有多少条支持，“同样 +N”和“×N”要算进去。
- 最多 ${maxFindings} 条。

${describeDataset(dataset)}`
}

function chunkMessage(chunk: Chunk, total: number): string {
  const kind = chunk.kind === 'danmaku' ? '弹幕' : '评论和回复'
  return `第 ${chunk.index + 1}/${total} 块（${kind}）：\n${chunk.lines.join('\n')}`
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, '')
}

function emptyDropped(): Dropped {
  return { invalid_finding: 0, unknown_ref: 0, bad_quote: 0, no_valid_refs: 0, over_limit: 0 }
}

/**
 * 校验模型提交的参数，把块内编号换回原 ID。不合格的部分丢掉并计数，不请模型重试：
 * 重试要把整块内容再发一遍。
 */
export function parseFindings(
  args: unknown,
  chunk: Chunk,
  dataset: Dataset,
  directions: readonly string[],
  maxFindings: number,
): { findings: Finding[]; dropped: Dropped } {
  const dropped = emptyDropped()
  const raw = (args as { findings?: unknown } | null)?.findings
  if (!Array.isArray(raw)) throw new Error('参数里没有 findings 数组')

  const findings: Finding[] = []
  for (const item of raw) {
    const parsed = looseFinding.safeParse(item)
    const direction = parsed.success && parsed.data.direction !== undefined ? directions[parsed.data.direction - 1] : undefined
    if (!parsed.success || direction === undefined) {
      dropped.invalid_finding++
      continue
    }
    if (findings.length >= maxFindings) {
      dropped.over_limit++
      continue
    }

    const refs = new Map<number, FindingRef>()
    for (const n of parsed.data.refs) {
      const id = n === undefined ? undefined : chunk.ids[n - 1]
      if (n === undefined || id === undefined) dropped.unknown_ref++
      else if (refs.has(n)) continue
      else if (refs.size >= MAX_REFS) dropped.over_limit++
      else refs.set(n, { id })
    }
    for (const quote of parsed.data.quotes ?? []) {
      const ref = quote.ref === undefined ? undefined : refs.get(quote.ref)
      const text = ref && getFeedback(dataset, ref.id)?.text
      if (!ref || !text || !quote.text.trim() || !squeeze(text).includes(squeeze(quote.text))) dropped.bad_quote++
      else ref.quote = quote.text.trim()
    }
    if (refs.size === 0) {
      dropped.no_valid_refs++
      continue
    }
    findings.push({
      chunk: chunk.index,
      direction,
      title: parsed.data.title,
      criteria: parsed.data.criteria,
      support: Math.max(parsed.data.support ?? 0, refs.size),
      refs: [...refs.values()],
    })
  }
  return { findings, dropped }
}

interface Prepared {
  system: string
  tool: ToolDefinition
  directions: readonly string[]
  maxFindings: number
  /** 提供商拒绝指定工具的 tool_choice 后改为 false，之后的块都用 auto */
  forceTool: boolean
}

function prepare(options: Pick<SummarizeOptions, 'dataset' | 'plan' | 'directions' | 'maxFindings' | 'playbook'>): Prepared {
  const directions = options.directions?.length ? options.directions : DEFAULT_DIRECTIONS
  const maxFindings = options.maxFindings ?? 8
  const tool: ToolDefinition = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: '提交这一块里找到的观点。只调用一次。',
      parameters: toParametersSchema(toolSchema(directions.length)),
    },
  }
  return { system: buildSystemPrompt(options.dataset, options.plan, directions, maxFindings, options.playbook), tool, directions, maxFindings, forceTool: true }
}

/** 开始前估算：每块都要重发 system prompt 和工具定义，输出按每条观点的大致长度算 */
export function estimateSummarize(options: Pick<SummarizeOptions, 'dataset' | 'plan' | 'directions' | 'maxFindings' | 'playbook'>): TokenEstimate {
  const { system, tool, maxFindings } = prepare(options)
  const fixed = approxTokens(system) + approxTokens(JSON.stringify(tool)) + TOKENS_PER_CALL
  const total = options.plan.chunks.length
  return {
    calls: total,
    input_tokens: options.plan.chunks.reduce((sum, chunk) => sum + fixed + approxTokens(chunkMessage(chunk, total)), 0),
    output_tokens: total * maxFindings * TOKENS_PER_FINDING,
  }
}

/** 部分思考模型（如开着思考模式的 DeepSeek）不接受指定工具，返回 400 */
export function rejectsToolChoice(error: unknown): boolean {
  return (error as { status?: number }).status === 400 && /tool_choice/i.test((error as Error).message)
}

async function summarizeChunk(chunk: Chunk, prepared: Prepared, options: SummarizeOptions, signal: AbortSignal): Promise<ChunkSummary> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prepared.system },
    { role: 'user', content: chunkMessage(chunk, options.plan.chunks.length) },
  ]
  let usage: Usage | undefined
  const call = (forced: boolean) =>
    options.model.complete({
      messages,
      tools: [prepared.tool],
      toolChoice: forced ? { type: 'function', function: { name: TOOL_NAME } } : 'auto',
      signal,
    })
  try {
    let result
    try {
      result = await call(prepared.forceTool)
    } catch (error) {
      if (!prepared.forceTool || !rejectsToolChoice(error)) throw error
      prepared.forceTool = false
      result = await call(false)
    }
    usage = result.usage
    if (result.finishReason === 'length') throw new Error('输出达到 max_tokens 被截断')
    const toolCall = result.message.tool_calls?.find((item) => item.function.name === TOOL_NAME)
    if (!toolCall) throw new Error(`模型没有调用 ${TOOL_NAME}`)
    let args: unknown
    try {
      args = JSON.parse(toolCall.function.arguments)
    } catch {
      throw new Error('参数不是合法的 JSON')
    }
    const { findings, dropped } = parseFindings(args, chunk, options.dataset, prepared.directions, prepared.maxFindings)
    return { chunk: chunk.index, status: 'ok', findings, dropped, usage }
  } catch (error) {
    return { chunk: chunk.index, status: 'failed', findings: [], dropped: emptyDropped(), usage, error: (error as Error).message }
  }
}

/** 每块调用一次模型，不走 Agent 循环：工具结果不需要再交回模型 */
export async function summarizeChunks(options: SummarizeOptions): Promise<SummarizeResult> {
  const started = performance.now()
  const prepared = prepare(options)
  const signal = options.signal ?? new AbortController().signal
  const chunks = options.plan.chunks
  const summaries: ChunkSummary[] = new Array(chunks.length)
  const usage: Required<Usage> = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }
  let calls = 0
  let next = 0

  const skip = (chunk: Chunk, error: string): ChunkSummary => ({ chunk: chunk.index, status: 'skipped', findings: [], dropped: emptyDropped(), error })

  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!
      let summary: ChunkSummary
      if (signal.aborted) summary = skip(chunk, '已取消')
      else if (options.tokenBudget !== undefined && usage.input_tokens + usage.output_tokens >= options.tokenBudget) {
        summary = skip(chunk, `已用 token 达到预算 ${options.tokenBudget}`)
      } else {
        calls++
        summary = await summarizeChunk(chunk, prepared, options, signal)
        usage.input_tokens += summary.usage?.input_tokens ?? 0
        usage.output_tokens += summary.usage?.output_tokens ?? 0
        usage.cached_input_tokens += summary.usage?.cached_input_tokens ?? 0
      }
      summaries[chunk.index] = summary
      options.onChunk?.(summary)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 4), chunks.length) }, worker))

  return {
    chunks: summaries,
    findings: summaries.flatMap((summary) => summary.findings),
    calls,
    usage,
    estimate: estimateSummarize(options),
    duration_ms: Math.round(performance.now() - started),
  }
}
