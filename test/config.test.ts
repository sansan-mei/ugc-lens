import { createChatClient } from '../src/llm/client.ts'
import { startMockServer, completion, sendJson } from './helpers/mock_server.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ConfigError, globalConfigPath, loadLlmConfig, writeGlobalConfig } from '../src/config.ts'
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
describe('全局配置 ~/.ugc-lens/config.json', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ugc-home-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })
  const writeGlobal = (llm: Record<string, unknown>) => {
    mkdirSync(join(home, '.ugc-lens'), { recursive: true })
    writeFileSync(join(home, '.ugc-lens', 'config.json'), JSON.stringify({ llm }))
  }

  test('项目目录没有配置时用全局配置；项目配置和环境变量优先于它', () => {
    writeGlobal({ provider: 'deepseek', model: 'from-global', api_key: 'global-key' })
    let config = loadLlmConfig({}, env.dir, home)
    assert.equal(config.provider, 'deepseek')
    assert.equal(config.model, 'from-global')
    assert.equal(config.apiKey, 'global-key')

    writeConfig({ model: 'from-local' })
    config = loadLlmConfig({}, env.dir, home)
    assert.equal(config.model, 'from-local')
    assert.equal(config.provider, 'deepseek')

    process.env.UGC_LENS_MODEL = 'from-env'
    process.env.DEEPSEEK_API_KEY = 'env-key'
    config = loadLlmConfig({}, env.dir, home)
    assert.equal(config.model, 'from-env')
    assert.equal(config.apiKey, 'env-key')
  })

  test('全局配置里的 key 让只写了提供商的项目配置也能用', () => {
    writeGlobal({ provider: 'deepseek', model: 'm', api_key: 'global-key' })
    writeConfig({ provider: 'deepseek' })
    assert.equal(loadLlmConfig({}, env.dir, home).apiKey, 'global-key')
  })

  test('项目端点和项目 .env 不能携带全局或进程凭证，反复加载也不能提升信任', () => {
    writeGlobal({ provider: 'deepseek', api_key: 'fictional-global' })
    writeConfig({ base_url: 'https://untrusted.example/v1', api_key_env: 'DEEPSEEK_API_KEY' })
    process.env.DEEPSEEK_API_KEY = 'fictional-process'
    assert.throws(() => loadLlmConfig({}, env.dir, home), /端点.*凭证/)
    writeConfig({})
    writeFileSync(join(env.dir, '.env'), 'UGC_LENS_BASE_URL=https://untrusted.example/v1\n')
    for (let i = 0; i < 2; i++) assert.throws(() => loadLlmConfig({}, env.dir, home), /端点.*凭证/)
    assert.equal(process.env.UGC_LENS_BASE_URL, undefined)
  })

  test('项目改变提供商或区域不能把全局凭证带到另一端点', () => {
    writeGlobal({ provider: 'kimi', api_key: 'fictional-global' })
    writeConfig({ region: 'global' })
    assert.throws(() => loadLlmConfig({}, env.dir, home), /端点.*凭证/)
    writeConfig({ provider: 'custom', base_url: 'https://untrusted.example/v1' })
    assert.throws(() => loadLlmConfig({}, env.dir, home), /端点.*凭证/)
  })

  test('不可信端点实际收不到请求；可信显式绑定后走真实 fetch', async () => {
    const server = await startMockServer((_request, response) => sendJson(response, 200, completion('ok')))
    try {
      writeGlobal({ provider: 'deepseek', model: 'mock', api_key: 'fictional-only' })
      writeConfig({ base_url: server.baseUrl })
      assert.throws(() => loadLlmConfig({}, env.dir, home), /端点.*凭证/)
      assert.equal(server.requests.length, 0)
      const config = loadLlmConfig({ base_url: server.baseUrl }, env.dir, home)
      await createChatClient(config).chat([{ role: 'user', content: '测试' }])
      assert.equal(server.requests[0]?.headers.authorization, 'Bearer fictional-only')
    } finally { await server.close() }
  })

  test('同一端点规范化可复用；可信参数或进程显式端点允许绑定', () => {
    writeGlobal({ provider: 'deepseek', api_key: 'fictional-global' })
    writeConfig({ base_url: 'https://api.deepseek.com/v1/' })
    assert.equal(loadLlmConfig({}, env.dir, home).apiKey, 'fictional-global')
    const endpoint = 'https://trusted.example/v1'
    assert.equal(loadLlmConfig({ base_url: endpoint }, env.dir, home).baseUrl, endpoint)
    process.env.UGC_LENS_BASE_URL = endpoint
    assert.equal(loadLlmConfig({}, env.dir, home).baseUrl, endpoint)
  })

  test('全局配置不是合法 JSON 时报错并指出路径', () => {
    mkdirSync(join(home, '.ugc-lens'), { recursive: true })
    writeFileSync(join(home, '.ugc-lens', 'config.json'), '{ broken')
    assert.throws(() => loadLlmConfig({ provider: 'ollama' }, env.dir, home), /无法解析.*ugc-home/)
  })
})

describe('writeGlobalConfig', () => {
  test('替换 llm 字段、保留其他顶层字段，权限 600', () => {
    const home = mkdtempSync(join(tmpdir(), 'ugc-home-'))
    writeGlobalConfig({ provider: 'deepseek', model: 'a' }, home)
    writeFileSync(globalConfigPath(home), JSON.stringify({ llm: { provider: 'old' }, other: 1 }))
    const path = writeGlobalConfig({ provider: 'kimi', model: 'b', api_key: 'k' }, home)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: 1, llm: { provider: 'kimi', model: 'b', api_key: 'k' } })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    rmSync(home, { recursive: true, force: true })
  })
})
