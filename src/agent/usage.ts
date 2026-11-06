import { approxTokens } from '../llm/tokens.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { AgentModel, AgentModelRequest } from './model.ts'
import type { ChatResult } from '../llm/types.ts'

export interface TaskUsage {
  task_id: string
  token_budget: number
  known_tokens: number
  unknown_estimated_tokens: number
  unknown_calls: number
  calls: Array<{ id: string; stage: string; final: boolean; status: 'pending' | 'ok' | 'failed'; input_tokens: number | null; output_tokens: number | null }>
}

export class TaskBudgetError extends Error {
  override name = 'TaskBudgetError'
  constructor() { super('已达到任务 token 软预算，停止新增模型调用') }
}

export class TaskLedger {
  private readonly value: TaskUsage
  private finalized = false
  constructor(tokenBudget = 100_000) {
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) throw new Error('任务预算必须是正数')
    this.value = { task_id: randomUUID(), token_budget: tokenBudget, known_tokens: 0, unknown_estimated_tokens: 0, unknown_calls: 0, calls: [] }
  }
  get exhausted(): boolean { return this.value.known_tokens + this.value.unknown_estimated_tokens >= this.value.token_budget }
  snapshot(): TaskUsage { return structuredClone(this.value) }
  async complete(model: AgentModel, request: AgentModelRequest, stage: string, final: boolean): Promise<ChatResult> {
    request.signal.throwIfAborted()
    if (this.exhausted && (!final || this.finalized)) throw new TaskBudgetError()
    if (final) {
      if (this.finalized) throw new TaskBudgetError()
      this.finalized = true
    }
    let call: TaskUsage['calls'][number] = { id: randomUUID(), stage, final, status: 'pending', input_tokens: null, output_tokens: null }
    this.value.calls.push(call)
    this.value.unknown_calls++
    try {
      const result = await model.complete({ ...request, onRetry: (info) => {
        // 重试前一次请求的计费不可确定，不能用最终成功响应覆盖它。
        call.status = 'failed'
        this.value.unknown_estimated_tokens += approxTokens(JSON.stringify([request.messages, request.tools]))
        request.onRetry?.(info)
        if (this.exhausted && !final) throw new TaskBudgetError()
        call = { id: randomUUID(), stage, final, status: 'pending', input_tokens: null, output_tokens: null }
        this.value.calls.push(call)
        this.value.unknown_calls++

      } })
      call.status = 'ok'
      if (result.usageReported !== false && Number.isFinite(result.usage.input_tokens) && Number.isFinite(result.usage.output_tokens) && result.usage.input_tokens >= 0 && result.usage.output_tokens >= 0) {
        call.input_tokens = result.usage.input_tokens
        call.output_tokens = result.usage.output_tokens
        this.value.known_tokens += call.input_tokens + call.output_tokens
        this.value.unknown_calls--
      } else {
        this.value.unknown_estimated_tokens += approxTokens(JSON.stringify([request.messages, request.tools, result.message]))
      }
      return result
    } catch (error) {
      if (call.status === 'pending') {
        call.status = 'failed'
        this.value.unknown_estimated_tokens += approxTokens(JSON.stringify([request.messages, request.tools]))
      }
      throw error
    }
  }
}

const context = new AsyncLocalStorage<TaskLedger>()
export function currentTask(): TaskLedger | undefined { return context.getStore() }

/** 嵌套调用共享任务；入口负责界定一次任务的生命周期。 */
export function withTask<T>(work: () => Promise<T>, tokenBudget?: number, independent = false): Promise<T> {
  if (currentTask() && !independent) return work()
  const ledger = new TaskLedger(tokenBudget)
  return context.run(ledger, async () => {
    try { return await work() } catch (error) {
      if (error instanceof Error) Object.assign(error, { task_usage: ledger.snapshot() })
      throw error
    }
  })
}

export function completeTracked(model: AgentModel, request: AgentModelRequest, stage: string, final = false): Promise<ChatResult> {
  return currentTask()?.complete(model, request, stage, final) ?? model.complete(request)
}
