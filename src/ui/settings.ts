import { existsSync } from 'node:fs'
import {
  globalConfigPath,
  loadLlmConfig,
  readConfigSection,
  readGlobalConfig,
  writeGlobalConfig,
  type LlmConfig,
  type LlmConfigFile,
} from '../config.ts'
import { isProviderId, PROVIDERS, resolveBaseUrl, type ProviderId, type ProviderPreset, type Region } from '../llm/providers.ts'
import { HttpError } from './http.ts'

/**
 * 界面里的模型设置：与 ugc-lens init 写同一份全局配置 ~/.ugc-lens/config.json。
 * key 只进不出：读取接口只返回“是否已保存”，不返回 key 本身。
 * 已保存的 key 只在接口地址不变时沿用，换地址必须重新填写，避免把 key 发往别的服务。
 */

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** 是否区分国内 / 国际接口 */
  regions: boolean
  key: 'required' | 'optional' | 'none'
  key_env?: string
  /** 预设接口地址；custom 没有 */
  base_url?: string | Record<Region, string>
}

export interface SettingsView {
  path: string
  providers: ProviderInfo[]
  saved: { provider?: string; region: Region; base_url?: string; model?: string; has_key: boolean; endpoint?: string } | null
  effective: { ok: true; provider: string; model: string; base_url: string; has_key: boolean } | { ok: false; error: string }
  /** 会覆盖全局配置的环境变量与项目配置项 */
  overrides: string[]
}

export interface SettingsDraft { provider: ProviderId; region: Region; base_url?: string; model?: string; api_key?: string }

export interface ResolvedDraft {
  file: LlmConfigFile
  endpoint: string
  apiKey?: string
  keySource: 'input' | 'saved' | 'env' | 'none'
}

const normalize = (url: string) => url.trim().replace(/\/+$/, '')

function presetOf(provider: string | undefined): ProviderPreset | undefined {
  return provider && isProviderId(provider) && provider !== 'custom' ? PROVIDERS[provider] : undefined
}

function keyMode(id: ProviderId): ProviderInfo['key'] {
  if (id === 'custom' || id === 'lmstudio') return 'optional'
  return presetOf(id)?.apiKeyEnv ? 'required' : 'none'
}

export function providerList(): ProviderInfo[] {
  const ids: ProviderId[] = [...(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>), 'custom']
  return ids.map((id) => {
    const preset = presetOf(id)
    return {
      id,
      name: preset?.name ?? '自定义（任意 OpenAI 兼容接口）',
      regions: !!preset && typeof preset.baseUrl !== 'string',
      key: keyMode(id),
      key_env: preset?.apiKeyEnv,
      base_url: preset?.baseUrl,
    }
  })
}

function endpointOf(file: LlmConfigFile): string | undefined {
  if (file.base_url) return normalize(file.base_url)
  const preset = presetOf(file.provider)
  return preset ? normalize(resolveBaseUrl(preset, file.region === 'global' ? 'global' : 'cn')) : undefined
}

export function describeSettings(cwd: string, homeDir: string, env: NodeJS.ProcessEnv = process.env): SettingsView {
  const path = globalConfigPath(homeDir)
  const global = existsSync(path) ? readGlobalConfig(homeDir) : {}
  const saved = global.provider || global.model || global.api_key
    ? { provider: global.provider, region: (global.region === 'global' ? 'global' : 'cn') as Region, base_url: global.base_url ?? undefined, model: global.model, has_key: !!global.api_key, endpoint: endpointOf(global) }
    : null

  const overrides = ['UGC_LENS_PROVIDER', 'UGC_LENS_MODEL', 'UGC_LENS_BASE_URL', 'UGC_LENS_REGION'].filter((name) => env[name])
  const keyEnv = global.api_key_env ?? presetOf(global.provider)?.apiKeyEnv
  if (keyEnv && env[keyEnv]) overrides.push(keyEnv)
  try {
    const project = readConfigSection<LlmConfigFile>(cwd, 'llm')
    for (const field of ['provider', 'model', 'region', 'base_url'] as const) {
      if (project[field]) overrides.push(`项目配置 ${field}`)
    }
  } catch { /* 项目配置无法解析时，下面的 effective 会给出错误 */ }

  let effective: SettingsView['effective']
  try {
    const config = loadLlmConfig({}, cwd, homeDir)
    effective = config.model
      ? { ok: true, provider: config.provider, model: config.model, base_url: config.baseUrl, has_key: !!config.apiKey }
      : { ok: false, error: '还没有选择模型' }
  } catch (error) {
    effective = { ok: false, error: (error as Error).message }
  }
  return { path, providers: providerList(), saved, effective, overrides }
}

const text = (value: unknown, field: string, max = 2000): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new HttpError(400, `${field} 过长`)
  return trimmed || undefined
}

export function parseDraft(body: unknown): SettingsDraft {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const provider = text(raw.provider, 'provider')
  if (!provider || !isProviderId(provider)) throw new HttpError(400, `未知的提供商：${provider ?? '（空）'}`)
  const region = text(raw.region, 'region') ?? 'cn'
  if (region !== 'cn' && region !== 'global') throw new HttpError(400, 'region 只能是 cn 或 global')
  const baseUrl = text(raw.base_url, 'base_url')
  if (baseUrl) {
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { throw new HttpError(400, `接口地址不是有效网址：${baseUrl}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpError(400, '接口地址只能是 http 或 https')
  }
  if (provider === 'custom' && !baseUrl) throw new HttpError(400, '自定义提供商必须填写接口地址')
  return { provider, region, base_url: baseUrl, model: text(raw.model, 'model', 300), api_key: text(raw.api_key, 'api_key', 4000) }
}

export function resolveDraft(draft: SettingsDraft, homeDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedDraft {
  const path = globalConfigPath(homeDir)
  const global = existsSync(path) ? readGlobalConfig(homeDir) : {}
  const preset = presetOf(draft.provider)
  const regional = !!preset && typeof preset.baseUrl !== 'string'
  const file: LlmConfigFile = { provider: draft.provider }
  if (regional && draft.region !== 'cn') file.region = draft.region
  if (draft.base_url) file.base_url = draft.base_url
  if (draft.model) file.model = draft.model
  // 超时、重试是与提供商无关的设置；api_key_env 只对同一个提供商有意义
  if (global.timeout_ms !== undefined) file.timeout_ms = global.timeout_ms
  if (global.max_retries !== undefined) file.max_retries = global.max_retries
  if (global.api_key_env && global.provider === draft.provider) file.api_key_env = global.api_key_env

  const endpoint = endpointOf(file)!
  if (draft.api_key) return { file: { ...file, api_key: draft.api_key }, endpoint, apiKey: draft.api_key, keySource: 'input' }
  if (global.api_key && endpointOf(global) === endpoint) return { file: { ...file, api_key: global.api_key }, endpoint, apiKey: global.api_key, keySource: 'saved' }
  // 环境变量里的 key 只用于它对应的预设地址，与 loadLlmConfig 的端点绑定规则一致
  const keyEnv = file.api_key_env ?? preset?.apiKeyEnv
  const presetEndpoint = preset && normalize(resolveBaseUrl(preset, draft.region))
  if (keyEnv && env[keyEnv] && (file.api_key_env || endpoint === presetEndpoint)) return { file, endpoint, apiKey: env[keyEnv], keySource: 'env' }
  return { file, endpoint, keySource: 'none' }
}

/** 测试连接用：不重试、30 秒超时 */
export function draftConfig(resolved: ResolvedDraft): LlmConfig {
  return { provider: resolved.file.provider as ProviderId, model: resolved.file.model ?? '', baseUrl: resolved.endpoint, apiKey: resolved.apiKey, timeoutMs: 30_000, maxRetries: 0 }
}

export function saveSettings(draft: SettingsDraft, homeDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!draft.model) throw new HttpError(400, '请选择或填写模型')
  const resolved = resolveDraft(draft, homeDir, env)
  if (keyMode(draft.provider) === 'required' && resolved.keySource === 'none') throw new HttpError(400, '这个提供商需要 API key')
  writeGlobalConfig(resolved.file, homeDir)
}
