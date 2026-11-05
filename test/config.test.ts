import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ConfigError, loadLlmConfig } from '../src/config.ts'
import { isolateEnv } from './helpers/env.ts'

let env: ReturnType<typeof isolateEnv>

beforeEach(() => {
  env = isolateEnv()
})
afterEach(() => {
  env.restore()
})

function writeConfig(llm: Record<string, unknown>): void {
  mkdirSync(join(env.dir, '.ugc-lens'), { recursive: true })
  writeFileSync(join(env.dir, '.ugc-lens', 'config.json'), JSON.stringify({ llm }))
}

describe('loadLlmConfig', () => {
  test('根据提供商预设得到接口地址和 key', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key'
    const config = loadLlmConfig({ provider: 'deepseek', model: 'm' }, env.dir)
    assert.equal(config.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal(config.apiKey, 'test-key')
    assert.equal(config.model, 'm')
  })

  test('region 选择国内或国际地址，默认国内', () => {
    process.env.KIMI_API_KEY = 'k'
    assert.equal(loadLlmConfig({ provider: 'kimi' }, env.dir).baseUrl, 'https://api.moonshot.cn/v1')
    assert.equal(loadLlmConfig({ provider: 'kimi', region: 'global' }, env.dir).baseUrl, 'https://api.moonshot.ai/v1')
  })

  test('优先级：参数 > 环境变量 > 配置文件', () => {
    process.env.DEEPSEEK_API_KEY = 'k'
    writeConfig({ provider: 'deepseek', model: 'from-file' })
    assert.equal(loadLlmConfig({}, env.dir).model, 'from-file')

    process.env.UGC_LENS_MODEL = 'from-env'
    assert.equal(loadLlmConfig({}, env.dir).model, 'from-env')

    assert.equal(loadLlmConfig({ model: 'from-arg' }, env.dir).model, 'from-arg')
  })

  test('读取工作目录下的 .env，但不覆盖已有环境变量', () => {
    writeFileSync(join(env.dir, '.env'), 'UGC_LENS_PROVIDER=deepseek\nDEEPSEEK_API_KEY=from-dotenv\nUGC_LENS_MODEL=from-dotenv\n')
    process.env.UGC_LENS_MODEL = 'from-shell'
    const config = loadLlmConfig({}, env.dir)
    assert.equal(config.apiKey, 'from-dotenv')
    assert.equal(config.model, 'from-shell')
  })

  test('base_url 覆盖预设地址，并去掉末尾斜杠', () => {
    process.env.OPENAI_API_KEY = 'k'
    const config = loadLlmConfig({ provider: 'openai', base_url: 'https://proxy.example.com/v1/' }, env.dir)
    assert.equal(config.baseUrl, 'https://proxy.example.com/v1')
  })

  test('api_key_env 改从指定的环境变量读取 key', () => {
    process.env.MY_PROXY_KEY = 'proxy-key'
    const config = loadLlmConfig({ provider: 'openai', api_key_env: 'MY_PROXY_KEY' }, env.dir)
    assert.equal(config.apiKey, 'proxy-key')
    delete process.env.MY_PROXY_KEY
  })

  test('本地服务不需要 key', () => {
    const config = loadLlmConfig({ provider: 'ollama' }, env.dir)
    assert.equal(config.baseUrl, 'http://localhost:11434/v1')
    assert.equal(config.apiKey, undefined)
  })

  test('缺少必要配置时给出明确错误', () => {
    assert.throws(() => loadLlmConfig({}, env.dir), ConfigError)
    assert.throws(() => loadLlmConfig({ provider: 'nope' }, env.dir), /未知的提供商/)
    assert.throws(() => loadLlmConfig({ provider: 'deepseek' }, env.dir), /DEEPSEEK_API_KEY/)
    assert.throws(() => loadLlmConfig({ provider: 'custom' }, env.dir), /base_url/)
    assert.throws(
      () => loadLlmConfig({ provider: 'ollama', region: 'mars' as 'cn' }, env.dir),
      /region/,
    )
  })

  test('max_retries 默认为 3，可以在配置文件或参数里修改', () => {
    assert.equal(loadLlmConfig({ provider: 'ollama' }, env.dir).maxRetries, 3)
    writeConfig({ provider: 'ollama', max_retries: 0 })
    assert.equal(loadLlmConfig({}, env.dir).maxRetries, 0)
    assert.equal(loadLlmConfig({ max_retries: 5 }, env.dir).maxRetries, 5)
  })

  test('配置文件不是合法 JSON 时报错', () => {
    mkdirSync(join(env.dir, '.ugc-lens'), { recursive: true })
    writeFileSync(join(env.dir, '.ugc-lens', 'config.json'), '{ broken')
    assert.throws(() => loadLlmConfig({ provider: 'ollama' }, env.dir), /无法解析/)
  })
})
