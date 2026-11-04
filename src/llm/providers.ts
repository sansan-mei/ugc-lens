export type Region = 'cn' | 'global'

export interface ProviderPreset {
  id: string
  name: string
  /** 有国内 / 国际两个地址的提供商用对象表示，按 region 选择 */
  baseUrl: string | Record<Region, string>
  /** 不需要 key 的本地服务为 undefined */
  apiKeyEnv?: string
}

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  qwen: {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseUrl: {
      cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      global: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    baseUrl: { cn: 'https://api.moonshot.cn/v1', global: 'https://api.moonshot.ai/v1' },
    apiKeyEnv: 'KIMI_API_KEY',
  },
  glm: {
    id: 'glm',
    name: '智谱 GLM / Z.ai',
    baseUrl: {
      cn: 'https://open.bigmodel.cn/api/paas/v4',
      global: 'https://api.z.ai/api/paas/v4',
    },
    apiKeyEnv: 'GLM_API_KEY',
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: { cn: 'https://api.minimaxi.com/v1', global: 'https://api.minimax.io/v1' },
    apiKeyEnv: 'MINIMAX_API_KEY',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  xai: {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: 'http://localhost:1234/v1',
    apiKeyEnv: 'LM_API_KEY',
  },
} satisfies Record<string, ProviderPreset>

export type ProviderId = keyof typeof PROVIDERS | 'custom'

export function isProviderId(value: string): value is ProviderId {
  return value === 'custom' || Object.hasOwn(PROVIDERS, value)
}

export function resolveBaseUrl(preset: ProviderPreset, region: Region): string {
  if (typeof preset.baseUrl === 'string') return preset.baseUrl
  return preset.baseUrl[region]
}
