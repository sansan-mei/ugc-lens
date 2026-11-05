import * as z from 'zod'
import type { AgentModel } from '../agent/model.ts'
import type { FeedbackItem } from '../dataset/types.ts'
import type { Usage } from '../llm/types.ts'
import { approxTokens } from '../llm/tokens.ts'
import { rejectsToolChoice } from '../pipeline/summarize.ts'
import { toParametersSchema } from '../tools/define.ts'

export interface BatchRecord<T> { id: string; status: 'processed' | 'failed' | 'skipped'; value?: T; reason?: string }

/** 一批的非法或重复 ID 使该批失败；遗漏只影响遗漏项。 */
export async function evaluateBatches<S extends z.ZodObject>(options: {
  items: readonly FeedbackItem[]; model: AgentModel; system: string; row: S
  validate?: (row: z.output<S>, item: FeedbackItem) => void
  tokenBudget?: number; batchSize?: number; maxChars?: number; signal?: AbortSignal
}) {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const budget = options.tokenBudget ?? 30_000
  const size = options.batchSize ?? 30
  const maxChars = options.maxChars ?? 12_000
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(maxChars) || maxChars < 1) throw new Error('非法分批参数')
  if (new Set(options.items.map((i) => i.id)).size !== options.items.length) throw new Error('数据集存在重复 ID')
  const schema = z.object({ rows: z.array(options.row) })
  const tool = { type: 'function' as const, function: { name: 'submit_evaluations', description: '逐条提交本批所有 ID 的评估结果', parameters: toParametersSchema(schema) } }
  const records = new Map<string, BatchRecord<z.output<S>>>()
  const batches: FeedbackItem[][] = []
  let batch: FeedbackItem[] = []
  let chars = 2
  for (const item of options.items) {
    const n = JSON.stringify({ id: item.id, text: item.text, kind: item.kind, content_id: item.content_id, parent_id: item.parent_id }).length + 1
    if (n + 2 > maxChars) { records.set(item.id, { id: item.id, status: 'skipped', reason: '原文超过批字符上限，不截断评估' }); continue }
    if (batch.length >= size || chars + n > maxChars) { batches.push(batch); batch = []; chars = 2 }
    batch.push(item); chars += n
  }
  if (batch.length) batches.push(batch)
  const usage: Required<Usage> = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }
  let calls = 0
  let spent = 0
  let force = true
  let exhausted = false
  for (const current of batches) {
    signal.throwIfAborted()
    if (spent >= budget) {
      exhausted = true
      for (const item of current) records.set(item.id, { id: item.id, status: 'skipped', reason: '达到 token 预算' })
      continue
    }
    const input = JSON.stringify(current.map(({ id, text, kind, content_id, parent_id }) => ({ id, text, kind, content_id, parent_id })))
    const messages = [{ role: 'system' as const, content: options.system }, { role: 'user' as const, content: input }]
    const request = () => { calls++; return options.model.complete({ messages, tools: [tool], toolChoice: force ? { type: 'function', function: { name: tool.function.name } } : 'auto', signal }) }
    let charged = false
    try {
      let response
      try { response = await request() } catch (error) {
        if (!force || !rejectsToolChoice(error)) throw error
        force = false; response = await request()
      }
      signal.throwIfAborted()
      usage.input_tokens += response.usage.input_tokens
      usage.output_tokens += response.usage.output_tokens
      usage.cached_input_tokens += response.usage.cached_input_tokens ?? 0
      spent += Math.max(response.usage.input_tokens + response.usage.output_tokens, approxTokens(options.system + input + JSON.stringify(response.message)))
      charged = true
      if (response.finishReason === 'length') throw new Error('模型输出被截断')
      const submissions = response.message.tool_calls?.filter((c) => c.function.name === tool.function.name) ?? []
      if (submissions.length !== 1) throw new Error('必须提交一次 submit_evaluations')
      const { rows } = schema.parse(JSON.parse(submissions[0]!.function.arguments))
      const expected = new Map(current.map((i) => [i.id, i]))
      const found = new Map<string, z.output<S>>()
      for (const row of rows) {
        const id = (row as { id?: unknown }).id
        if (typeof id !== 'string' || !expected.has(id) || found.has(id)) throw new Error('批外或重复 ID')
        options.validate?.(row, expected.get(id)!)
        found.set(id, row)
      }
      for (const item of current) {
        const value = found.get(item.id)
        records.set(item.id, value ? { id: item.id, status: 'processed', value } : { id: item.id, status: 'failed', reason: '模型遗漏该 ID' })
      }
    } catch (error) {
      signal.throwIfAborted()
      if (!charged) spent += approxTokens(options.system + input)
      for (const item of current) records.set(item.id, { id: item.id, status: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) })
    }
  }
  const ordered = options.items.map((i) => records.get(i.id)!)
  const counts = { total: ordered.length, processed: 0, failed: 0, skipped: 0 }
  for (const row of ordered) counts[row.status]++
  return { records: ordered, counts, coverage: counts.total ? counts.processed / counts.total : 0, calls, usage, budget_consumed: spent, stop_reason: exhausted ? 'token_budget' : counts.failed + counts.skipped ? 'partial' : 'completed' }
}
