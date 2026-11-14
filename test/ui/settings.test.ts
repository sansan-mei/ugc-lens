import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { globalConfigPath } from '../../src/config.ts'
import { createUiServer, type UiServer } from '../../src/ui/server.ts'
import { isolateEnv } from '../helpers/env.ts'
import { sendJson, startMockServer, type RecordedRequest } from '../helpers/mock_server.ts'

const KEY = 'sk-test-ui-settings'
const env = isolateEnv()
const home = env.home
const cwd = join(env.dir, 'project')
mkdirSync(cwd, { recursive: true })

let replyText = false
/** 模拟 OpenAI 兼容接口：/models 列表、非流式工具调用、流式文字 */
function handler(request: RecordedRequest, res: ServerResponse) {
  if (request.method === 'GET' && request.url.endsWith('/models')) return sendJson(res, 200, { data: [{ id: 'm-1' }, { id: 'm-2' }] })
  const body = request.body as { stream?: boolean; tool_choice?: unknown }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  if (body.tool_choice && !replyText) {
    return sendJson(res, 200, { model: 'm-1', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  return sendJson(res, 200, { model: 'm-1', choices: [{ message: { role: 'assistant', content: '现在是中午' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
}

let a: Awaited<ReturnType<typeof startMockServer>>
let b: Awaited<ReturnType<typeof startMockServer>>
let ui: UiServer
let port = 0
before(async () => {
  a = await startMockServer(handler)
  b = await startMockServer(handler)
  ui = createUiServer({ cwd, token: 't', homeDir: home, picker: { available: false, pick: async () => undefined }, staticDir: env.dir })
  await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done))
  port = (ui.server.address() as AddressInfo).port
})
after(async () => {
  await ui.close()
  ui.server.closeAllConnections()
  await new Promise((done) => ui.server.close(done))
  await a.close()
  await b.close()
  env.restore()
})
beforeEach(() => { replyText = false })

function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'x-ugc-lens-token': 't' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        let json: unknown
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode!, text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}
const auth = (r: RecordedRequest | undefined) => r?.headers.authorization
const readConfig = () => JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))

test('settings：未配置时列出提供商，并说明当前不可用', async () => {
  const r = await call('/api/settings')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.saved, null)
  assert.equal(r.json.effective.ok, false)
  assert.equal(r.json.path, globalConfigPath(home))
  const ids = r.json.providers.map((p: { id: string }) => p.id)
  assert.ok(ids.includes('deepseek') && ids.includes('custom'))
  const qwen = r.json.providers.find((p: { id: string }) => p.id === 'qwen')
  assert.equal(qwen.regions, true)
  assert.equal(qwen.key, 'required')
  assert.equal(r.json.providers.find((p: { id: string }) => p.id === 'ollama').key, 'none')
})

test('settings：未配置时新建对话返回 422，提示在界面里配置', async () => {
  const r = await call('/api/chat', 'POST', {})
  assert.equal(r.status, 422)
  assert.match(r.json.error, /模型设置/)
})

test('settings：用填写的 key 获取模型列表', async () => {
  const before = a.requests.length
  const r = await call('/api/settings/models', 'POST', { provider: 'custom', base_url: a.baseUrl, api_key: KEY })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.json.models, ['m-1', 'm-2'])
  assert.equal(auth(a.requests[before]), `Bearer ${KEY}`)
})

test('settings：测试连接检查文字和工具调用，失败时返回原因', async () => {
  const ok = await call('/api/settings/test', 'POST', { provider: 'custom', base_url: a.baseUrl, api_key: KEY, model: 'm-1' })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json, { ok: true })
  replyText = true
  const bad = await call('/api/settings/test', 'POST', { provider: 'custom', base_url: a.baseUrl, api_key: KEY, model: 'm-1' })
  assert.equal(bad.json.ok, false)
  assert.match(bad.json.error, /function call/)
  assert.equal((await call('/api/settings/test', 'POST', { provider: 'custom', base_url: a.baseUrl, api_key: KEY })).status, 400)
})

test('settings：参数不合法时返回 400', async () => {
  assert.equal((await call('/api/settings/models', 'POST', { provider: 'nope' })).status, 400)
  assert.equal((await call('/api/settings/models', 'POST', { provider: 'custom' })).status, 400)
  assert.equal((await call('/api/settings/models', 'POST', { provider: 'custom', base_url: 'file:///etc/passwd' })).status, 400)
  assert.equal((await call('/api/settings/models', 'POST', { provider: 'qwen', region: 'mars' })).status, 400)
  assert.equal((await call('/api/settings', 'PUT', { provider: 'deepseek', model: 'x' })).status, 400, '需要 key 的提供商不能不填 key')
})

test('settings：保存到全局配置，权限 600，保留其他字段，读取时不返回 key', async () => {
  mkdirSync(join(home, '.ugc-lens'), { recursive: true })
  writeFileSync(globalConfigPath(home), JSON.stringify({ web: { provider: 'searxng' }, llm: { provider: 'custom', base_url: 'http://127.0.0.1:1/v1', timeout_ms: 5000 } }))
  const r = await call('/api/settings', 'PUT', { provider: 'custom', base_url: a.baseUrl, api_key: KEY, model: 'm-1' })
  assert.equal(r.status, 200, r.text)
  assert.doesNotMatch(r.text, new RegExp(KEY))
  assert.equal(r.json.saved.has_key, true)
  assert.equal(r.json.saved.model, 'm-1')
  assert.equal(r.json.effective.ok, true)
  const saved = readConfig()
  assert.deepEqual(saved.web, { provider: 'searxng' })
  assert.equal(saved.llm.api_key, KEY)
  assert.equal(saved.llm.base_url, a.baseUrl)
  assert.equal(saved.llm.timeout_ms, 5000)
  if (process.platform !== 'win32') assert.equal(statSync(globalConfigPath(home)).mode & 0o777, 0o600)
  const again = await call('/api/settings')
  assert.doesNotMatch(again.text, new RegExp(KEY))
})

test('settings：key 留空且接口地址不变时沿用已保存的 key', async () => {
  const before = a.requests.length
  const models = await call('/api/settings/models', 'POST', { provider: 'custom', base_url: `${a.baseUrl}/` })
  assert.equal(models.status, 200, models.text)
  assert.equal(auth(a.requests[before]), `Bearer ${KEY}`)
  const r = await call('/api/settings', 'PUT', { provider: 'custom', base_url: a.baseUrl, model: 'm-2' })
  assert.equal(r.status, 200, r.text)
  assert.equal(readConfig().llm.api_key, KEY)
  assert.equal(readConfig().llm.model, 'm-2')
})

test('settings：接口地址变化后不把已保存的 key 发往新地址', async () => {
  const before = b.requests.length
  const models = await call('/api/settings/models', 'POST', { provider: 'custom', base_url: b.baseUrl })
  assert.equal(models.status, 200, models.text)
  assert.equal(auth(b.requests[before]), undefined)
  const r = await call('/api/settings', 'PUT', { provider: 'custom', base_url: b.baseUrl, model: 'm-1' })
  assert.equal(r.status, 200, r.text)
  assert.equal(readConfig().llm.api_key, undefined)
  assert.equal(r.json.saved.has_key, false)
})

test('settings：保存后已有对话改用新配置', async () => {
  await call('/api/settings', 'PUT', { provider: 'custom', base_url: a.baseUrl, api_key: KEY, model: 'm-1' })
  // 一个已经聊过（历史已保存），一个刚新建还没发消息
  const talked = (await call('/api/chat', 'POST', {})).json.id
  const first = await call(`/api/chat/${talked}/messages`, 'POST', { text: '第一句' })
  assert.match(first.text, /"type":"done"/)
  const fresh = await call('/api/chat', 'POST', {})
  assert.equal(fresh.status, 200, fresh.text)
  await call('/api/settings', 'PUT', { provider: 'custom', base_url: b.baseUrl, api_key: 'sk-other', model: 'm-2' })
  for (const id of [talked, fresh.json.id]) {
    const before = b.requests.length
    const sent = await call(`/api/chat/${id}/messages`, 'POST', { text: '你好' })
    assert.equal(sent.status, 200, sent.text)
    assert.match(sent.text, /"type":"done"/)
    const used = b.requests.slice(before).find((r) => (r.body as { stream?: boolean })?.stream)
    assert.ok(used, '新消息应发往新保存的接口')
    assert.equal(auth(used), 'Bearer sk-other')
    assert.equal((used.body as { model: string }).model, 'm-2')
  }
})

test('settings：环境变量和项目配置覆盖时列出覆盖项', async () => {
  process.env.UGC_LENS_MODEL = 'env-model'
  mkdirSync(join(cwd, '.ugc-lens'), { recursive: true })
  writeFileSync(join(cwd, '.ugc-lens', 'config.json'), JSON.stringify({ llm: { model: 'project-model' } }))
  try {
    const r = await call('/api/settings')
    assert.ok(r.json.overrides.includes('UGC_LENS_MODEL'))
    assert.ok(r.json.overrides.some((o: string) => o.includes('model') && o.includes('项目')))
    assert.equal(r.json.effective.model, 'env-model')
  } finally { delete process.env.UGC_LENS_MODEL }
})
