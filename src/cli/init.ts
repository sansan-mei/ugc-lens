import { initPlaybook } from '../memory/playbook.ts'
import { createInterface } from 'node:readline/promises'
import { loadLlmConfig, readGlobalConfig, writeGlobalConfig, type LlmConfigFile } from '../config.ts'
import { isProviderId, PROVIDERS, resolveBaseUrl, type ProviderId, type ProviderPreset, type Region } from '../llm/providers.ts'
import { fetchModelIds, verifyLlm } from '../llm/setup.ts'
import { UsageError } from './common.ts'

export const INIT_USAGE = `用法：ugc-lens init

交互式初始化：选择提供商和模型、填 API key、发一次测试调用，
写入全局配置 ~/.ugc-lens/config.json（权限 600），所有目录下生效。
密钥只保存在全局配置；项目目录的 .ugc-lens/config.json 只能覆盖提供商、模型等非密钥设置。`

/** 交互的输入输出，测试时换成假的 */
export interface InitIo {
  ask(question: string): Promise<string>
  print(text: string): void
}

export interface InitDeps {
  io: InitIo
  homeDir: string
  /** 当前目录，只用于创建项目分析手册；不从这里读取密钥 */
  cwd?: string
  /** 列出提供商的模型；默认真的请求 GET {baseUrl}/models */
  fetchModels?: (config: { baseUrl: string; apiKey?: string }) => Promise<string[]>
  /** 发一次测试调用，返回错误消息；undefined 表示通过。默认用真实客户端 */
  verifyModel?: (config: LlmConfigFile) => Promise<string | undefined>
}

const PROVIDER_IDS: readonly ProviderId[] = [...(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>), 'custom']

/** 一次最小的调用，并要求调用一个假工具，顺便验证 function call 支持 */
async function verifyModelReal(file: LlmConfigFile): Promise<string | undefined> {
  try {
    return await verifyLlm(loadLlmConfig({ ...file, timeout_ms: 30_000, max_retries: 0 }))
  } catch (error) {
    return (error as Error).message
  }
}

function pickProviderId(input: string): ProviderId | undefined {
  const value = input.trim().toLowerCase()
  const byNumber = PROVIDER_IDS[Number(value) - 1]
  if (byNumber) return byNumber
  return isProviderId(value) ? value : undefined
}

/** 交互式初始化流程；返回写入的配置，用户取消时返回 undefined */
export async function runInitFlow(deps: InitDeps): Promise<LlmConfigFile | undefined> {
  const { io } = deps
  const initEnv = process.env
  const existing = readGlobalConfig(deps.homeDir)
  const fetchModels = deps.fetchModels ?? fetchModelIds
  const verifyModel = deps.verifyModel ?? verifyModelReal

  if (existing.provider) {
    io.print(`当前全局配置：${existing.provider}${existing.model ? ` / ${existing.model}` : ''}${existing.api_key ? '（已保存 key）' : ''}`)
    if ((await io.ask('重新设置？[y/N] ')).toLowerCase() !== 'y') return undefined
  }

  io.print('\n选择模型提供商：')
  PROVIDER_IDS.forEach((id, i) => {
    io.print(`  ${i + 1}. ${id === 'custom' ? '自定义（任意 OpenAI 兼容接口）' : PROVIDERS[id].name}（${id}）`)
  })
  let provider: ProviderId | undefined
  while (!provider) {
    provider = pickProviderId(await io.ask(`输入编号或 id${existing.provider ? `（回车保持 ${existing.provider}）` : ''}：`))
    if (!provider && existing.provider) provider = existing.provider as ProviderId
    if (!provider) io.print('没认出来，再试一次。')
  }
  const preset: ProviderPreset | undefined = provider === 'custom' ? undefined : PROVIDERS[provider]

  const file: LlmConfigFile = { provider }

  let region: Region = 'cn'
  if (preset && typeof preset.baseUrl !== 'string') {
    const answer = await io.ask(`国内还是国际接口？[1] 国内 [2] 国际（回车默认国内）：`)
    region = answer.trim() === '2' ? 'global' : 'cn'
    if (region !== 'cn') file.region = region
  }

  if (provider === 'custom') {
    const baseUrl = (await io.ask('接口地址（如 http://localhost:8000/v1）：')).trim()
    if (!baseUrl) throw new UsageError('自定义提供商必须填接口地址')
    file.base_url = baseUrl
  }

  const keyEnv = preset?.apiKeyEnv
  const needsKey = Boolean(keyEnv) && provider !== 'lmstudio'
  if (provider !== 'ollama') {
    const envKey = keyEnv ? initEnv[keyEnv] : undefined
    const hints = [
      envKey ? `环境变量 ${keyEnv} 里已经有，回车用它` : '',
      existing.api_key ? '回车保持已保存的 key' : '',
      needsKey ? '' : '没有就回车跳过',
    ].filter(Boolean)
    const key = (await io.ask(`API key${hints.length > 0 ? `（${hints.join('；')}）` : ''}：`)).trim()
    if (key) file.api_key = key
    else if (existing.api_key) file.api_key = existing.api_key
    if (!file.api_key && !envKey && needsKey) {
      io.print(`注意：没有 key，运行前还需要设置 ${keyEnv}。`)
    }
  }

  const baseUrl = file.base_url ?? (preset ? resolveBaseUrl(preset, region) : '')
  const effectiveKey = file.api_key ?? (keyEnv ? initEnv[keyEnv] : undefined)
  try {
    io.print('正在获取模型列表……')
    const models = await fetchModels({ baseUrl, apiKey: effectiveKey })
    const shown = models.slice(0, 30)
    shown.forEach((id, i) => io.print(`  ${i + 1}. ${id}`))
    if (models.length > shown.length) io.print(`  ……共 ${models.length} 个，也可以直接输入名字`)
    while (!file.model) {
      const answer = (await io.ask(`选择模型，输入编号或名字${existing.model ? `（回车保持 ${existing.model}）` : ''}：`)).trim()
      if (!answer && existing.model) file.model = existing.model
      else if (models[Number(answer) - 1]) file.model = models[Number(answer) - 1]
      else if (answer) file.model = answer
      else io.print('需要一个模型。')
    }
  } catch (error) {
    io.print(`获取模型列表失败：${(error as Error).message}，手动输入。`)
    while (!file.model) {
      const answer = (await io.ask(`模型名字${existing.model ? `（回车保持 ${existing.model}）` : ''}：`)).trim()
      if (answer) file.model = answer
      else if (existing.model) file.model = existing.model
      else io.print('需要一个模型。')
    }
  }

  const verify = (await io.ask('发一次测试调用验证模型和 key？[Y/n] ')).trim().toLowerCase()
  if (verify !== 'n') {
    const problem = await verifyModel({ ...existing, ...file })
    if (problem) {
      io.print(`测试调用失败：${problem}`)
      const save = (await io.ask('仍然保存配置？[y/N] ')).trim().toLowerCase()
      if (save !== 'y') return undefined
    } else {
      io.print('测试调用通过。')
    }
  }

  const path = writeGlobalConfig(file, deps.homeDir)
  initPlaybook({ cwd: deps.cwd ?? process.cwd(), homeDir: deps.homeDir }, true)
  io.print(`已写入 ${path}（权限 600），所有目录下生效。密钥不会写入项目目录。`)
  return file
}

export async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) throw new UsageError('init 需要在终端里交互运行')
  // 整个流程共用一个接口：每问新建会把用户一次粘贴的多行回答丢掉
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await runInitFlow({
      io: { ask: (question) => rl.question(question), print: (text) => console.log(text) },
      homeDir: process.env.HOME ?? process.cwd(),
    })
  } finally {
    rl.close()
  }
}
