import { createLlmModel } from '../agent/llm_model.ts'
import type { AgentModel } from '../agent/model.ts'
import type { LlmConfig } from '../config.ts'
import { createChatClient } from '../llm/client.ts'
import type { AnalyzeProgress } from '../pipeline/analyze.ts'

/** 参数不对：入口打印这条消息和用法，退出码 2 */
export class UsageError extends Error {
  override name = 'UsageError'
}

export function positiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} 需要正数，收到 ${value}`)
  return n
}

/** 逗号分开的列表，中英文逗号都行；空列表返回 undefined */
export function splitList(value: string | undefined): string[] | undefined {
  const list = value?.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
  return list?.length ? list : undefined
}

/** 分析用：输出稳定，关闭思考省 token */
export function analysisModel(config: LlmConfig): AgentModel {
  return createLlmModel(createChatClient(config), { temperature: 0, maxTokens: 4_000, disableThinking: true })
}

export function askModel(config: LlmConfig): AgentModel {
  return createLlmModel(createChatClient(config), { temperature: 0.2 })
}

export function formatAnalyzeProgress(event: AnalyzeProgress): string {
  if (event.type === 'planned') return `  分成 ${event.chunks} 块，预计输入约 ${event.estimate.input_tokens} token`
  if (event.type === 'chunk') return `  块 ${event.summary.chunk + 1}：${event.summary.status === 'ok' ? `${event.summary.findings.length} 条观点` : event.summary.status}`
  return `  合并成 ${event.themes} 个主题`
}

/** 第一次 Ctrl+C 取消，第二次直接退出 */
export function abortOnInterrupt(message: string): AbortController {
  const controller = new AbortController()
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130)
    console.error(`\n${message}……再按一次 Ctrl+C 直接退出`)
    controller.abort()
  })
  return controller
}
