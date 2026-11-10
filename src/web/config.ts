import { homedir } from 'node:os'
import { ConfigError, readConfigSection, rejectProjectSecret } from '../config.ts'

export type WebProviderId = 'searxng' | 'tavily'

/** 配置文件 .ugc-lens/config.json 中 web 字段的格式，所有字段可选 */
export interface WebConfigFile {
  /** 只认参数、进程环境和全局配置；项目配置不能自行开启联网 */
  enabled?: boolean
  provider?: string
  base_url?: string | null
  api_key_env?: string | null
  /** 直接写 key，只建议放在全局配置里 */
  api_key?: string | null
  /** 每个任务最多发出的网络请求次数（搜索与读取合计），缓存命中不计入 */
  max_calls?: number
  timeout_ms?: number
  /** 单个网页响应的最大字节数 */
  max_bytes?: number
  /** 返回给模型的网页正文最大字符数 */
  max_chars?: number
  cache_ttl_hours?: number
}

export interface WebConfig {
  provider: WebProviderId
  baseUrl: string
  apiKey?: string
  maxCalls: number
  timeoutMs: number
  maxBytes: number
  maxChars: number
  cacheTtlMs: number
}

const PRESETS: Record<WebProviderId, { baseUrl?: string; apiKeyEnv?: string; needsKey: boolean }> = {
  searxng: { needsKey: false },
  tavily: { baseUrl: 'https://api.tavily.com', apiKeyEnv: 'TAVILY_API_KEY', needsKey: true },
}

function isProvider(value: string): value is WebProviderId {
  return Object.hasOwn(PRESETS, value)
}

function pick(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) if (value) return value
  return undefined
}

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  return /^(1|true|yes|on)$/i.test(value)
}

const trim = (url: string) => url.replace(/\/+$/, '')

/**
 * 是否开启联网。开启后数据内容可能经搜索词或 URL 发到外部，
 * 所以项目目录里的配置和 .env 不能替用户打开它。
 */
export function webEnabled(overrides: Pick<WebConfigFile, 'enabled'> = {}, _cwd: string = process.cwd(), homeDir: string = homedir()): boolean {
  if (overrides.enabled !== undefined) return overrides.enabled
  const fromEnv = truthy(process.env.UGC_LENS_WEB)
  if (fromEnv !== undefined) return fromEnv
  return readConfigSection<WebConfigFile>(homeDir, 'web').enabled === true
}

/** 读取联网配置。优先级：参数 > 环境变量 > 项目配置 > 全局配置 > 预设；key 与端点的绑定规则同模型配置。 */
export function loadWebConfig(overrides: WebConfigFile = {}, cwd: string = process.cwd(), homeDir: string = homedir()): WebConfig {
  const file = readConfigSection<WebConfigFile>(cwd, 'web')
  rejectProjectSecret(file, cwd, 'web')
  const global = readConfigSection<WebConfigFile>(homeDir, 'web')
  const trustedEnv = process.env
  const env = trustedEnv

  const provider = pick(overrides.provider, env.UGC_LENS_WEB_PROVIDER, file.provider, global.provider)
  if (!provider) throw new ConfigError('未选择联网搜索后端：设置 web.provider（searxng 或 tavily）或 UGC_LENS_WEB_PROVIDER')
  if (!isProvider(provider)) throw new ConfigError(`未知的联网 provider "${provider}"，可选：${Object.keys(PRESETS).join(', ')}`)
  const preset = PRESETS[provider]

  const baseUrl = pick(overrides.base_url, env.UGC_LENS_WEB_BASE_URL, file.base_url, global.base_url, preset.baseUrl)
  if (!baseUrl) throw new ConfigError(`${provider} 必须设置 base_url（web.base_url 或 UGC_LENS_WEB_BASE_URL）`)
  if (!/^https?:\/\//i.test(baseUrl)) throw new ConfigError('联网搜索 base_url 必须是 http 或 https 地址')

  const apiKeyEnv = pick(overrides.api_key_env, file.api_key_env, global.api_key_env, preset.apiKeyEnv)
  const apiKey = pick(overrides.api_key, apiKeyEnv ? env[apiKeyEnv] : undefined, file.api_key, global.api_key)
  if (apiKey && !overrides.api_key) {
    const inheritedGlobal = apiKey === global.api_key && apiKey !== file.api_key
    const inheritedProcess = apiKeyEnv !== undefined && apiKey === trustedEnv[apiKeyEnv]
    if (inheritedGlobal || inheritedProcess) {
      const trustedProvider = pick(overrides.provider, trustedEnv.UGC_LENS_WEB_PROVIDER, global.provider)
      const trustedPreset = trustedProvider && isProvider(trustedProvider) ? PRESETS[trustedProvider] : undefined
      const trustedKeyEnv = pick(overrides.api_key_env, global.api_key_env, trustedPreset?.apiKeyEnv)
      if (inheritedProcess && apiKeyEnv !== trustedKeyEnv) {
        throw new ConfigError('联网端点与凭证来源未绑定：项目不能自行选择其他进程凭证，请在可信配置指定 web.api_key_env')
      }
      const bound = pick(overrides.base_url, trustedEnv.UGC_LENS_WEB_BASE_URL, global.base_url, trustedPreset?.baseUrl)
      if (!bound || trim(bound) !== trim(baseUrl)) {
        throw new ConfigError('联网端点变化不能继承凭证：请在参数、进程环境或全局配置中显式绑定 web.base_url')
      }
    }
  }
  if (preset.needsKey && !apiKey) throw new ConfigError(`缺少 ${provider} 的 API key：设置 ${apiKeyEnv ?? 'web.api_key'}`)

  const number = (name: 'max_calls' | 'timeout_ms' | 'max_bytes' | 'max_chars' | 'cache_ttl_hours', fallback: number): number => {
    const value = overrides[name] ?? file[name] ?? global[name] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ConfigError(`web.${name} 必须是正数`)
    return value
  }
  return {
    provider,
    baseUrl: trim(baseUrl),
    apiKey,
    maxCalls: Math.max(1, Math.floor(number('max_calls', 8))),
    timeoutMs: number('timeout_ms', 15_000),
    maxBytes: number('max_bytes', 2_000_000),
    maxChars: number('max_chars', 8_000),
    cacheTtlMs: number('cache_ttl_hours', 24) * 3_600_000,
  }
}
