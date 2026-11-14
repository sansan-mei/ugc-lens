import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { globalConfigPath } from '../../src/config.ts'
import { HttpError } from '../../src/ui/http.ts'
import { describeWebSettings, parseWebDraft, resolveWebDraft, saveWebSettings } from '../../src/ui/web_settings.ts'
import { webEnabled, loadWebConfig } from '../../src/web/config.ts'
import { isolateEnv } from '../helpers/env.ts'

const env = isolateEnv()
const home = env.home
const cwd = join(env.dir, 'project')
mkdirSync(cwd, { recursive: true })
mkdirSync(join(home, '.ugc-lens'), { recursive: true })
after(() => env.restore())
beforeEach(() => writeFileSync(globalConfigPath(home), JSON.stringify({ llm: { provider: 'deepseek', model: 'm' }, web: { max_calls: 3 } })))

const saved = () => JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))

test('联网设置：默认未开启，视图不含 key 本身', () => {
  const view = describeWebSettings(cwd, home, {})
  assert.equal(view.enabled, false)
  assert.equal(view.saved?.has_key ?? false, false)
  assert.deepEqual(view.providers.map((p) => p.id).sort(), ['searxng', 'tavily'])
  saveWebSettings(parseWebDraft({ enabled: true, provider: 'tavily', api_key: 'tvly-secret' }), home, {})
  const after = describeWebSettings(cwd, home, {})
  assert.equal(after.enabled, true)
  assert.equal(after.saved?.has_key, true)
  assert.equal(after.effective.ok, true)
  assert.doesNotMatch(JSON.stringify(after), /tvly-secret/)
})

test('联网设置：保存后与命令行读同一份配置，保留模型配置与其他联网字段，文件权限 600', () => {
  saveWebSettings(parseWebDraft({ enabled: true, provider: 'searxng', base_url: 'http://127.0.0.1:8888/' }), home, {})
  const file = saved()
  assert.deepEqual(file.llm, { provider: 'deepseek', model: 'm' })
  assert.equal(file.web.max_calls, 3)
  assert.equal(webEnabled({}, cwd, home), true)
  const config = loadWebConfig({}, cwd, home)
  assert.equal(config.provider, 'searxng')
  assert.equal(config.baseUrl, 'http://127.0.0.1:8888')
  assert.equal(config.maxCalls, 3)
  if (process.platform !== 'win32') assert.equal((statSync(globalConfigPath(home)).mode & 0o777), 0o600)
})

test('联网设置：已保存的 key 只在接口地址不变时沿用', () => {
  saveWebSettings(parseWebDraft({ enabled: true, provider: 'tavily', api_key: 'k-1' }), home, {})
  assert.equal(resolveWebDraft(parseWebDraft({ enabled: true, provider: 'tavily' }), home, {}).keySource, 'saved')
  const moved = parseWebDraft({ enabled: true, provider: 'tavily', base_url: 'https://proxy.example/tavily' })
  assert.equal(resolveWebDraft(moved, home, {}).keySource, 'none')
  assert.throws(() => saveWebSettings(moved, home, {}), (e: unknown) => e instanceof HttpError && /key/.test(e.message))
  assert.equal(saved().web.api_key, 'k-1')
})

test('联网设置：关闭时不要求填写其他项；SearXNG 必须有地址；地址只能是 http(s)', () => {
  saveWebSettings(parseWebDraft({ enabled: false, provider: 'searxng' }), home, {})
  assert.equal(saved().web.enabled, false)
  assert.throws(() => saveWebSettings(parseWebDraft({ enabled: true, provider: 'searxng' }), home, {}), HttpError)
  assert.throws(() => parseWebDraft({ enabled: true, provider: 'searxng', base_url: 'file:///etc' }), HttpError)
  assert.throws(() => parseWebDraft({ enabled: true, provider: 'bing' }), HttpError)
})

test('联网设置：会覆盖全局配置的环境变量会列出来', () => {
  const view = describeWebSettings(cwd, home, { UGC_LENS_WEB: '0', UGC_LENS_WEB_PROVIDER: 'tavily' })
  assert.ok(view.overrides.includes('UGC_LENS_WEB'))
  assert.ok(view.overrides.includes('UGC_LENS_WEB_PROVIDER'))
})
