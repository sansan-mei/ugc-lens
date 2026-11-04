import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatResult, ToolCall, ToolChoice, Usage } from '../llm/types.ts'
import { toToolDefinition, type AgentTool, type ToolContext } from '../tools/types.ts'
import type { RunEvent, RunEventListener } from './events.ts'
import type { AgentModel } from './model.ts'

export type StopReason = 'completed' | 'max_steps' | 'token_budget' | 'timeout' | 'aborted' | 'tool_errors'

export interface AgentLimits {
  maxSteps: number
  /** 输入加输出的累计 token */
  tokenBudget: number
  timeoutMs: number
  /** 连续多少步的工具调用全部失败后停止 */
  maxConsecutiveToolErrors: number
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 10,
  tokenBudget: 100_000,
  timeoutMs: 5 * 60_000,
  maxConsecutiveToolErrors: 3,
}

export interface ToolCallRecord {
  call_id: string
  name: string
  args: unknown
  ok: boolean
  result: string
  duration_ms: number
}

export interface AgentStep {
  step: number
  /** 收尾调用 */
  final: boolean
  content: string | null
  tool_calls: ToolCallRecord[]
  usage: Usage
}

export interface AgentRunResult {
  run_id: string
  answer: string
  stop_reason: StopReason
  steps: AgentStep[]
  /** 运行结束时的完整历史 */
  messages: ChatMessage[]
  usage: Usage
  duration_ms: number
}

export interface RunAgentOptions {
  model: AgentModel
  /** 初始消息，通常是 system + user。不会被修改 */
  messages: readonly ChatMessage[]
  tools?: readonly AgentTool[]
  limits?: Partial<AgentLimits>
  signal?: AbortSignal
  onEvent?: RunEventListener
}

const FINALIZE_LABELS: Partial<Record<StopReason, string>> = {
  max_steps: '最大步数',
  token_budget: 'token 预算',
  tool_errors: '连续工具错误上限',
}

export function finalizeNotice(reason: StopReason): string {
  const label = FINALIZE_LABELS[reason] ?? reason
  return `【系统说明】已达到${label}，不能再调用工具。请基于以上已有信息直接回答用户的问题，并说明哪些信息还不足。`
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const run_id = randomUUID()
  const startedAt = Date.now()
  const emit: RunEventListener = options.onEvent ?? (() => {})

  const messages: ChatMessage[] = [...options.messages]
  const tools = options.tools ?? []
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
  const definitions = tools.map(toToolDefinition)

  const deadline = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const toolContext: ToolContext = { run_id, signal }

  const steps: AgentStep[] = []
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }
  let consecutiveToolErrors = 0
  let answer = ''
  let stopReason: StopReason | undefined

  const abortReason = (): StopReason | undefined => {
    if (options.signal?.aborted) return 'aborted'
    if (deadline.aborted) return 'timeout'
    return undefined
  }

  // 停止检查放在工具执行之后、下一次调用模型之前
  const limitReason = (step: number): StopReason | undefined => {
    if (usage.input_tokens + usage.output_tokens >= limits.tokenBudget) return 'token_budget'
    if (consecutiveToolErrors >= limits.maxConsecutiveToolErrors) return 'tool_errors'
    if (step > limits.maxSteps) return 'max_steps'
    return undefined
  }

  const callModel = async (step: number, toolChoice: ToolChoice, final: boolean): Promise<ChatResult> => {
    emit({ type: 'model_start', run_id, step, final })
    const result = await options.model.complete({ messages, tools: definitions, toolChoice, signal })
    usage.input_tokens += result.usage.input_tokens
    usage.output_tokens += result.usage.output_tokens
    emit({
      type: 'model_end',
      run_id,
      step,
      usage: result.usage,
      tool_calls: result.message.tool_calls?.length ?? 0,
    })
    return result
  }

  emit({ type: 'run_start', run_id, kind: 'agent' })

  for (let step = 1; ; step++) {
    stopReason = abortReason() ?? limitReason(step)
    if (stopReason) break

    let result: ChatResult
    try {
      result = await callModel(step, 'auto', false)
    } catch (error) {
      stopReason = abortReason()
      if (stopReason) break
      throw error
    }

    messages.push(result.message)
    const calls = result.message.tool_calls ?? []
    const record: AgentStep = {
      step,
      final: false,
      content: result.message.content,
      tool_calls: [],
      usage: result.usage,
    }
    steps.push(record)

    if (calls.length === 0) {
      answer = result.message.content ?? ''
      stopReason = 'completed'
      break
    }

    let failed = 0
    for (const call of calls) {
      const callRecord = await executeToolCall(call, step, toolMap, toolContext, emit)
      record.tool_calls.push(callRecord)
      // 每个 tool_call 都必须有对应的 tool 消息，出错也一样
      messages.push({ role: 'tool', tool_call_id: call.id, content: callRecord.result })
      if (!callRecord.ok) failed++
    }
    consecutiveToolErrors = failed === calls.length ? consecutiveToolErrors + 1 : 0
  }

  if (FINALIZE_LABELS[stopReason] !== undefined) {
    answer = await finalize(stopReason)
  }

  const duration_ms = Date.now() - startedAt
  emit({ type: 'run_end', run_id, stop_reason: stopReason, usage: { ...usage }, duration_ms })
  return { run_id, answer, stop_reason: stopReason, steps, messages, usage, duration_ms }

  async function finalize(reason: StopReason): Promise<string> {
    const last = messages.at(-1)
    // 这条工具结果还没发给模型，附加说明不算修改历史，也不需要伪造一条 user 消息
    if (last?.role === 'tool') {
      messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${finalizeNotice(reason)}` }
    }
    const step = steps.length + 1
    let result: ChatResult
    try {
      result = await callModel(step, 'none', true)
    } catch (error) {
      if (abortReason()) return ''
      throw error
    }
    messages.push(result.message)
    steps.push({ step, final: true, content: result.message.content, tool_calls: [], usage: result.usage })
    return result.message.content ?? ''
  }
}

async function executeToolCall(
  call: ToolCall,
  step: number,
  toolMap: ReadonlyMap<string, AgentTool>,
  ctx: ToolContext,
  emit: (event: RunEvent) => void,
): Promise<ToolCallRecord> {
  const startedAt = Date.now()
  const { name, arguments: rawArgs } = call.function

  let args: unknown = rawArgs
  let ok = false
  let result: string

  const tool = toolMap.get(name)
  const parsed = parseArguments(rawArgs)
  if (parsed.ok) args = parsed.value

  emit({ type: 'tool_start', run_id: ctx.run_id, step, call_id: call.id, name, args })

  if (!tool) {
    const available = [...toolMap.keys()].join(', ') || '无'
    result = `错误：不存在名为 "${name}" 的工具。可用工具：${available}`
  } else if (!parsed.ok) {
    result = `错误：${parsed.error}`
  } else {
    try {
      result = await tool.execute(parsed.value, ctx)
      ok = true
    } catch (error) {
      result = `错误：工具 ${name} 执行失败：${(error as Error).message}`
    }
  }

  const duration_ms = Date.now() - startedAt
  emit({ type: 'tool_end', run_id: ctx.run_id, step, call_id: call.id, name, ok, duration_ms })
  return { call_id: call.id, name, args, ok, result, duration_ms }
}

type ParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

function parseArguments(raw: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(raw.trim() === '' ? '{}' : raw)
  } catch {
    return { ok: false, error: `参数不是合法的 JSON：${raw}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `参数必须是 JSON 对象：${raw}` }
  }
  return { ok: true, value: value as Record<string, unknown> }
}
