import { readConfigSection, writeGlobalSection } from '../config.ts'
import { isWebProvider, loadWebConfig, WEB_PRESETS, webEnabled, type WebConfig, type WebConfigFile, type WebProviderId } from '../web/config.ts'
import { HttpError } from './http.ts'

/**
 * 界面里的联网设置：写全局配置 ~/.ugc-lens/config.json 的 web 字段，与命令行 --web / web.enabled 共用。
 * 规则与模型设置相同：key 只进不出，已保存的 key 只在接口地址不变时沿用。
 * 项目配置不能开启联网（docs/architecture.md 第 2.7 节），所以这里只写全局配置。
 */

export interface WebProviderInfo { id: WebProviderId; name: string; needs_key: boolean; key_env?: string; base_url?: string }

export interface WebSettingsView {
  enabled: boolean
  providers: WebProviderInfo[]
  saved: { provider?: string; base_url?: string; has_key: boolean; endpoint?: string } | null
  effective: { ok: true; enabled: boolean; provider: string; base_url: string; has_key: boolean } | { ok: false; enabled: boolean; error: string }
  overrides: string[]
}

export interface WebDraft { enabled: boolean; provider: WebProviderId; base_url?: string; api_key?: string }

const NAMES: Record<WebProviderId, string> = { searxng: 'SearXNG（自建或公共实例，不需要 key）', tavily: 'Tavily（需要 API key）' }
const normalize = (url: string) => url.trim().replace(/\/+$/, '')

export function webProviderList(): WebProviderInfo[] {
  return (Object.keys(WEB_PRESETS) as WebProviderId[]).map((id) => ({ id, name: NAMES[id], needs_key: WEB_PRESETS[id].needsKey, key_env: WEB_PRESETS[id].apiKeyEnv, base_url: WEB_PRESETS[id].baseUrl }))
}

function endpointOf(file: Partial<WebConfigFile>): string | undefined {
  if (file.base_url) return normalize(file.base_url)
  const preset = file.provider && isWebProvider(file.provider) ? WEB_PRESETS[file.provider] : undefined
  return preset?.baseUrl && normalize(preset.baseUrl)
}

export function describeWebSettings(cwd: string, homeDir: string, env: NodeJS.ProcessEnv = process.env): WebSettingsView {
  const global = readConfigSection<WebConfigFile>(homeDir, 'web')
  const saved = global.provider || global.base_url || global.api_key
    ? { provider: global.provider, base_url: global.base_url ?? undefined, has_key: !!global.api_key, endpoint: endpointOf(global) }
    : null
  const overrides = ['UGC_LENS_WEB', 'UGC_LENS_WEB_PROVIDER', 'UGC_LENS_WEB_BASE_URL'].filter((name) => env[name])
  let effective: WebSettingsView['effective']
  let enabled = false
  try {
    enabled = webEnabled({}, cwd, homeDir)
    const config = loadWebConfig({}, cwd, homeDir)
    effective = { ok: true, enabled, provider: config.provider, base_url: config.baseUrl, has_key: !!config.apiKey }
  } catch (error) {
    effective = { ok: false, enabled, error: (error as Error).message }
  }
  return { enabled: global.enabled === true, providers: webProviderList(), saved, effective, overrides }
}

export function parseWebDraft(body: unknown): WebDraft {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const text = (value: unknown, field: string, max = 2000): string | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是字符串`)
    const trimmed = value.trim()
    if (trimmed.length > max) throw new HttpError(400, `${field} 过长`)
    return trimmed || undefined
  }
  const provider = text(raw.provider, 'provider')
  if (!provider || !isWebProvider(provider)) throw new HttpError(400, `未知的搜索服务：${provider ?? '（空）'}`)
  const baseUrl = text(raw.base_url, 'base_url')
  if (baseUrl) {
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { throw new HttpError(400, `接口地址不是有效网址：${baseUrl}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpError(400, '接口地址只能是 http 或 https')
  }
  return { enabled: raw.enabled === true, provider, base_url: baseUrl, api_key: text(raw.api_key, 'api_key', 4000) }
}

export interface ResolvedWebDraft { file: WebConfigFile; endpoint?: string; apiKey?: string; keySource: 'input' | 'saved' | 'env' | 'none' }

export function resolveWebDraft(draft: WebDraft, homeDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedWebDraft {
  const global = readConfigSection<WebConfigFile>(homeDir, 'web')
  const preset = WEB_PRESETS[draft.provider]
  // 次数上限、超时等与服务无关的字段原样保留；api_key_env 只对同一个服务有意义
  const { enabled: _e, provider: _p, base_url: _b, api_key: _k, api_key_env: keyEnvSaved, ...kept } = global
  const file: WebConfigFile = { ...kept, enabled: draft.enabled, provider: draft.provider }
  if (draft.base_url) file.base_url = draft.base_url
  if (keyEnvSaved && global.provider === draft.provider) file.api_key_env = keyEnvSaved
  const endpoint = endpointOf(file)
  if (draft.api_key) return { file: { ...file, api_key: draft.api_key }, endpoint, apiKey: draft.api_key, keySource: 'input' }
  if (global.api_key && endpoint && endpointOf(global) === endpoint) return { file: { ...file, api_key: global.api_key }, endpoint, apiKey: global.api_key, keySource: 'saved' }
  const keyEnv = file.api_key_env ?? preset.apiKeyEnv
  if (keyEnv && env[keyEnv] && (file.api_key_env || endpoint === endpointOf({ provider: draft.provider }))) return { file, endpoint, apiKey: env[keyEnv], keySource: 'env' }
  return { file, endpoint, keySource: 'none' }
}

/** 测试搜索用的配置：不缓存，短超时 */
export function draftWebConfig(resolved: ResolvedWebDraft): WebConfig {
  if (!resolved.endpoint) throw new HttpError(400, '请填写搜索服务的接口地址')
  return { provider: resolved.file.provider as WebProviderId, baseUrl: resolved.endpoint, apiKey: resolved.apiKey, maxCalls: 1, timeoutMs: 15_000, maxBytes: 1_000_000, maxChars: 2_000, cacheTtlMs: 0 }
}

export function saveWebSettings(draft: WebDraft, homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveWebDraft(draft, homeDir, env)
  if (draft.enabled) {
    if (!resolved.endpoint) throw new HttpError(400, `${NAMES[draft.provider]} 需要填写接口地址`)
    if (WEB_PRESETS[draft.provider].needsKey && resolved.keySource === 'none') throw new HttpError(400, '这个搜索服务需要 API key')
  }
  return writeGlobalSection('web', resolved.file, homeDir)
}

