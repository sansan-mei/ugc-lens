import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ConfigError } from '../../src/config.ts'
import { loadWebConfig, webEnabled } from '../../src/web/config.ts'
import { isolateEnv } from '../helpers/env.ts'

let env: ReturnType<typeof isolateEnv>
let project: string
let home: string

beforeEach(() => {
  env = isolateEnv()
  project = join(env.dir, 'project')
  home = join(env.dir, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
})
afterEach(() => { env.restore() })

function write(dir: string, web: Record<string, unknown>): void {
  mkdirSync(join(dir, '.ugc-lens'), { recursive: true })
  writeFileSync(join(dir, '.ugc-lens', 'config.json'), JSON.stringify({ web }))
}

describe('webEnabled', () => {
  test('默认关闭；参数、进程环境或全局配置可以开启', () => {
    assert.equal(webEnabled({}, project, home), false)
    assert.equal(webEnabled({ enabled: true }, project, home), true)
    process.env.UGC_LENS_WEB = '1'
    assert.equal(webEnabled({}, project, home), true)
    delete process.env.UGC_LENS_WEB
    write(home, { enabled: true })
    assert.equal(webEnabled({}, project, home), true)
    assert.equal(webEnabled({ enabled: false }, project, home), false)
  })

  test('项目配置和项目 .env 不能自行开启联网', () => {
    write(project, { enabled: true })
    writeFileSync(join(project, '.env'), 'UGC_LENS_WEB=1\n')
    assert.equal(webEnabled({}, project, home), false)
  })
})

describe('loadWebConfig', () => {
  test('Tavily 使用默认端点和 TAVILY_API_KEY，带默认限制', () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    const config = loadWebConfig({ provider: 'tavily' }, project, home)
    assert.equal(config.provider, 'tavily')
    assert.equal(config.baseUrl, 'https://api.tavily.com')
    assert.equal(config.apiKey, 'tvly-test')
    assert.ok(config.maxCalls > 0 && config.timeoutMs > 0 && config.maxBytes > 0 && config.maxChars > 0 && config.cacheTtlMs > 0)
  })

  test('SearXNG 必须设置 base_url，可以没有 key；Tavily 缺 key 报错', () => {
    assert.throws(() => loadWebConfig({ provider: 'searxng' }, project, home), ConfigError)
    const config = loadWebConfig({ provider: 'searxng', base_url: 'http://127.0.0.1:8888/' }, project, home)
    assert.equal(config.baseUrl, 'http://127.0.0.1:8888')
    assert.equal(config.apiKey, undefined)
    assert.throws(() => loadWebConfig({ provider: 'tavily' }, project, home), /key/)
    assert.throws(() => loadWebConfig({}, project, home), ConfigError)
    assert.throws(() => loadWebConfig({ provider: 'google' }, project, home), /provider/)
  })

  test('项目配置改端点不能带走全局或进程中的 key，错误信息不含 key', () => {
    write(home, { provider: 'tavily', api_key: 'global-secret-key' })
    write(project, { base_url: 'https://collector.example' })
    assert.throws(() => loadWebConfig({}, project, home), (error: Error) => error instanceof ConfigError && !error.message.includes('global-secret-key'))

    write(home, { provider: 'tavily' })
    process.env.TAVILY_API_KEY = 'process-secret-key'
    assert.throws(() => loadWebConfig({}, project, home), (error: Error) => error instanceof ConfigError && !error.message.includes('process-secret-key'))

    writeFileSync(join(project, '.env'), 'UGC_LENS_WEB_BASE_URL=https://collector.example\n')
    write(project, {})
    assert.throws(() => loadWebConfig({}, project, home), ConfigError)
  })

  test('项目配置自带 key 时可以使用自己的端点；可信参数可以显式绑定端点', () => {
    write(home, { provider: 'tavily', api_key: 'global-secret-key' })
    write(project, { base_url: 'https://proxy.example', api_key: 'project-key' })
    assert.equal(loadWebConfig({}, project, home).apiKey, 'project-key')
    write(project, {})
    assert.equal(loadWebConfig({ base_url: 'https://proxy.example' }, project, home).baseUrl, 'https://proxy.example')
  })
})
