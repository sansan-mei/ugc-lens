import { createLlmModel } from '../agent/llm_model.ts'
import type { AgentModel } from '../agent/model.ts'
import type { LlmConfig } from '../config.ts'
import { createChatClient } from '../llm/client.ts'
import type { AnalyzeProgress } from '../pipeline/analyze.ts'
import { loadWebConfig, webEnabled } from '../web/config.ts'
import { createWebSession, defaultWebCacheDir, type WebCitations, type WebSession } from '../web/tools.ts'

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

export function mappingSource(mapping: { from_cache: boolean; builtin?: boolean }): string {
  return mapping.builtin ? '由内置规则读取' : mapping.from_cache ? '规则来自缓存' : '由模型识别'
}

/** --web 或可信配置开启时创建联网会话；未开启时返回 undefined */
export function webSessionFor(flag: boolean, cwd: string = process.cwd()): WebSession | undefined {
  if (!webEnabled(flag ? { enabled: true } : {}, cwd)) return undefined
  return createWebSession({ config: loadWebConfig({}, cwd), cacheDir: defaultWebCacheDir(cwd) })
}

/** 外部引用有问题时返回提示，没有问题返回 undefined */
export function formatWebCitations(result: WebCitations | undefined): string | undefined {
  if (!result) return undefined
  const problems = [
    result.invalid.length ? `不存在的来源 ${result.invalid.join(', ')}` : '',
    result.invalid_quotes.length ? `${result.invalid_quotes.length} 处摘句不在对应网页中（${result.invalid_quotes.map((q) => q.source).join(', ')}）` : '',
    result.unverified_urls.length ? `未实际获取的网址 ${result.unverified_urls.join(', ')}` : '',
  ].filter(Boolean)
  return problems.length ? `（外部引用核对：${problems.join('；')}）` : undefined
}
