import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROVIDERS,
  isProviderId,
  resolveBaseUrl,
  type ProviderId,
  type ProviderPreset,
  type Region,
} from './llm/providers.ts'

/** 配置文件 .ugc-lens/config.json 中 llm 字段的格式，所有字段可选 */
export interface LlmConfigFile {
  provider?: string
  model?: string
  region?: Region
  base_url?: string | null
  api_key_env?: string | null
  timeout_ms?: number
  max_retries?: number
}

/** 解析完成、可以直接使用的模型配置 */
export interface LlmConfig {
  provider: ProviderId
  model: string
  baseUrl: string
  apiKey?: string
  timeoutMs: number
  /** 网络错误、超时、限流、服务端错误时最多重试几次，未设置时为 3 */
  maxRetries?: number
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const CONFIG_DIR = '.ugc-lens'

function loadDotEnv(cwd: string): void {
  const file = join(cwd, '.env')
  if (!existsSync(file)) return
  // Bun 没有 process.loadEnvFile，但启动时会自动加载当前目录的 .env
  if (typeof process.loadEnvFile !== 'function') return
  // 已存在的环境变量不会被 .env 覆盖，保证命令行里临时指定的值优先
  process.loadEnvFile(file)
}

function readConfigFile(cwd: string): LlmConfigFile {
  const file = join(cwd, CONFIG_DIR, 'config.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { llm?: LlmConfigFile }
    return parsed.llm ?? {}
  } catch (error) {
    throw new ConfigError(`无法解析 ${file}: ${(error as Error).message}`)
  }
}

/** 空字符串视为未设置，方便在 .env 里留空占位 */
function pick(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value
  }
  return undefined
}

/**
 * 读取模型配置。优先级：参数 overrides > 环境变量 > 配置文件 > 提供商预设。
 */
export function loadLlmConfig(
  overrides: LlmConfigFile = {},
  cwd: string = process.cwd(),
): LlmConfig {
  loadDotEnv(cwd)
  const file = readConfigFile(cwd)
  const env = process.env

  const provider = pick(overrides.provider, env.UGC_LENS_PROVIDER, file.provider)
  if (!provider) {
    throw new ConfigError('未选择模型提供商：设置 UGC_LENS_PROVIDER 或配置文件中的 llm.provider')
  }
  if (!isProviderId(provider)) {
    const ids = [...Object.keys(PROVIDERS), 'custom'].join(', ')
    throw new ConfigError(`未知的提供商 "${provider}"，可选：${ids}`)
  }

  const region = (pick(overrides.region, env.UGC_LENS_REGION, file.region) ?? 'cn') as Region
  if (region !== 'cn' && region !== 'global') {
    throw new ConfigError(`region 只能是 cn 或 global，当前为 "${region}"`)
  }

  const preset: ProviderPreset | undefined = provider === 'custom' ? undefined : PROVIDERS[provider]

  const baseUrl = pick(
    overrides.base_url,
    env.UGC_LENS_BASE_URL,
    file.base_url,
    preset && resolveBaseUrl(preset, region),
  )
  if (!baseUrl) {
    throw new ConfigError('custom 提供商必须设置 base_url（UGC_LENS_BASE_URL 或 llm.base_url）')
  }

  const apiKeyEnv = pick(overrides.api_key_env, file.api_key_env, preset?.apiKeyEnv)
  const apiKey = apiKeyEnv ? pick(env[apiKeyEnv]) : undefined
  // 本地服务（ollama、lmstudio、custom）可以没有 key
  if (preset?.apiKeyEnv && !apiKey && provider !== 'lmstudio') {
    throw new ConfigError(`缺少 API key：请在环境变量或 .env 中设置 ${apiKeyEnv}`)
  }

  const model = pick(overrides.model, env.UGC_LENS_MODEL, file.model) ?? ''

  return {
    provider,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: overrides.timeout_ms ?? file.timeout_ms ?? 120_000,
    maxRetries: overrides.max_retries ?? file.max_retries ?? 3,
  }
}
