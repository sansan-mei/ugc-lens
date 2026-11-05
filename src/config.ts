import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  /** 直接写 key，只建议放在全局配置 ~/.ugc-lens/config.json 里 */
  api_key?: string | null
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

/** 读取 cwd/.env 进环境变量（不覆盖已有的），没有就什么都不做 */
export function loadDotEnv(cwd: string): void {
  const file = join(cwd, '.env')
  if (!existsSync(file)) return
  // Bun 没有 process.loadEnvFile，但启动时会自动加载当前目录的 .env
  if (typeof process.loadEnvFile !== 'function') return
  // 已存在的环境变量不会被 .env 覆盖，保证命令行里临时指定的值优先
  process.loadEnvFile(file)
}

export function globalConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, CONFIG_DIR, 'config.json')
}

/** 读取全局配置（~/.ugc-lens/config.json）里的 llm 字段；没有时返回空对象 */
export function readGlobalConfig(homeDir: string = homedir()): LlmConfigFile {
  return readConfigFile(homeDir)
}

/** 写入全局配置：替换 llm 字段，其他顶层字段保留；权限 600，因为里面有 key */
export function writeGlobalConfig(llm: LlmConfigFile, homeDir: string = homedir()): string {
  const path = globalConfigPath(homeDir)
  let rest: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        const { llm: _old, ...others } = parsed as Record<string, unknown>
        rest = others
      }
    } catch (error) {
      throw new ConfigError(`无法解析 ${path}: ${(error as Error).message}`)
    }
  }
  mkdirSync(join(homeDir, CONFIG_DIR), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...rest, llm }, null, 2)}\n`, { mode: 0o600 })
  return path
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
 * 读取模型配置。每一项的优先级：参数 overrides > 环境变量 > 项目配置（cwd/.ugc-lens）> 全局配置（~/.ugc-lens）> 提供商预设。
 */
export function loadLlmConfig(
  overrides: LlmConfigFile = {},
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): LlmConfig {
  loadDotEnv(cwd)
  const file = readConfigFile(cwd)
  const global = existsSync(globalConfigPath(homeDir)) ? readConfigFile(homeDir) : {}
  const env = process.env

  const provider = pick(overrides.provider, env.UGC_LENS_PROVIDER, file.provider, global.provider)
  if (!provider) {
    throw new ConfigError('未选择模型提供商：设置 UGC_LENS_PROVIDER，或运行 ugc-lens init 写入全局配置')
  }
  if (!isProviderId(provider)) {
    const ids = [...Object.keys(PROVIDERS), 'custom'].join(', ')
    throw new ConfigError(`未知的提供商 "${provider}"，可选：${ids}`)
  }

  const region = (pick(overrides.region, env.UGC_LENS_REGION, file.region, global.region) ?? 'cn') as Region
  if (region !== 'cn' && region !== 'global') {
    throw new ConfigError(`region 只能是 cn 或 global，当前为 "${region}"`)
  }

  const preset: ProviderPreset | undefined = provider === 'custom' ? undefined : PROVIDERS[provider]

  const baseUrl = pick(
    overrides.base_url,
    env.UGC_LENS_BASE_URL,
    file.base_url,
    global.base_url,
    preset && resolveBaseUrl(preset, region),
  )
  if (!baseUrl) {
    throw new ConfigError('custom 提供商必须设置 base_url（UGC_LENS_BASE_URL 或 llm.base_url）')
  }

  const apiKeyEnv = pick(overrides.api_key_env, file.api_key_env, global.api_key_env, preset?.apiKeyEnv)
  const apiKey = pick(overrides.api_key, apiKeyEnv ? env[apiKeyEnv] : undefined, file.api_key, global.api_key)
  // 本地服务（ollama、lmstudio、custom）可以没有 key
  if (preset?.apiKeyEnv && !apiKey && provider !== 'lmstudio') {
    throw new ConfigError(`缺少 API key：设置 ${apiKeyEnv}，或运行 ugc-lens init 写入全局配置`)
  }

  const model = pick(overrides.model, env.UGC_LENS_MODEL, file.model, global.model) ?? ''

  return {
    provider,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: overrides.timeout_ms ?? file.timeout_ms ?? global.timeout_ms ?? 120_000,
    maxRetries: overrides.max_retries ?? file.max_retries ?? global.max_retries ?? 3,
  }
}
