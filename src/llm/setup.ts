import { createLlmModel } from '../agent/llm_model.ts'
import type { LlmConfig } from '../config.ts'
import { createChatClient } from './client.ts'

/**
 * 配置模型时的两个检查：列出可选模型、发一次测试调用。命令行 init 和图形界面共用。
 */

/** GET {baseUrl}/models，10 秒超时；返回模型 id 列表 */
export async function fetchModelIds({ baseUrl, apiKey }: { baseUrl: string; apiKey?: string }): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) throw new Error('返回的列表是空的')
  return ids
}

/** 一次最小的调用，并要求调用一个假工具，顺便验证 function call 支持；返回错误消息，undefined 表示通过 */
export async function verifyLlm(config: LlmConfig): Promise<string | undefined> {
  try {
    if (!config.model) return '没有选模型'
    const model = createLlmModel(createChatClient(config), { temperature: 0, maxTokens: 30, disableThinking: true })
    const result = await model.complete({
      messages: [{ role: 'user', content: '现在几点？用工具回答。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: '获取当前时间',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'get_current_time' } },
      signal: AbortSignal.timeout(35_000),
    })
    if (!result.message.tool_calls?.length) return '模型返回了文字而不是工具调用，这个模型可能不支持 function call'
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}
