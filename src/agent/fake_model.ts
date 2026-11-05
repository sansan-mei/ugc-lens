import { setTimeout as sleep } from 'node:timers/promises'
import type { AssistantMessage, ChatMessage, ToolCall, ToolChoice, ToolDefinition } from '../llm/types.ts'
import type { AgentModel, AgentModelRequest } from './model.ts'

export interface FakeToolCall {
  name: string
  args?: unknown
  /** 直接指定 arguments 字符串，用来模拟模型给出不合法 JSON 的情况 */
  raw_arguments?: string
}

export interface FakeReply {
  content?: string
  tool_calls?: FakeToolCall[]
}

/** 数组：按调用顺序依次返回；函数：根据请求动态决定（call 从 1 开始） */
export type FakeScript = FakeReply[] | ((request: AgentModelRequest, call: number) => FakeReply)

/** 每次调用时请求内容的快照，测试用来检查循环发出了什么 */
export interface FakeRequestRecord {
  messages: ChatMessage[]
  tools: ToolDefinition[]
  toolChoice: ToolChoice
}

export interface FakeModel extends AgentModel {
  readonly requests: readonly FakeRequestRecord[]
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

/**
 * 按剧本返回结果的假模型。行为与真实模型的约束一致：
 * tool_choice 为 none 时不能请求工具。
 */
export function createFakeModel(script: FakeScript, options: { delayMs?: number } = {}): FakeModel {
  const requests: FakeRequestRecord[] = []

  return {
    requests,
    async complete(request) {
      const call = requests.length + 1
      requests.push({
        messages: structuredClone([...request.messages]),
        tools: structuredClone([...request.tools]),
        toolChoice: request.toolChoice,
      })

      if (options.delayMs) await sleep(options.delayMs, undefined, { signal: request.signal })

      const reply = typeof script === 'function' ? script(request, call) : script[call - 1]
      if (!reply) throw new Error(`假模型剧本已用完：第 ${call} 次调用没有对应的回复`)
      if (request.toolChoice === 'none' && reply.tool_calls?.length) {
        throw new Error(`假模型剧本错误：第 ${call} 次调用的 tool_choice 为 none，却返回了工具调用`)
      }
      if (typeof request.toolChoice === 'object') {
        const forced = request.toolChoice.function.name
        if (!reply.tool_calls?.length || reply.tool_calls.some((item) => item.name !== forced)) {
          throw new Error(`假模型剧本错误：第 ${call} 次调用指定了工具 ${forced}，返回的工具调用不符`)
        }
      }

      const toolCalls: ToolCall[] = (reply.tool_calls ?? []).map((item, index) => ({
        id: `call_${call}_${index + 1}`,
        type: 'function',
        function: { name: item.name, arguments: item.raw_arguments ?? JSON.stringify(item.args ?? {}) },
      }))
      const message: AssistantMessage = { role: 'assistant', content: reply.content ?? null }
      if (toolCalls.length > 0) message.tool_calls = toolCalls

      return {
        message,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: {
          input_tokens: estimateTokens(JSON.stringify(request.messages)),
          output_tokens: estimateTokens(JSON.stringify(message)),
        },
        model: 'fake',
      }
    },
  }
}
