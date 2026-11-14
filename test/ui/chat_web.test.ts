import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { createFakeModel, type FakeScript } from '../../src/agent/fake_model.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { globalConfigPath } from '../../src/config.ts'
import { createUiServer } from '../../src/ui/server.ts'
import { WEB_PROMPT } from '../../src/web/tools.ts'
import { isolateEnv } from '../helpers/env.ts'
import { sendJson, startMockServer } from '../helpers/mock_server.ts'

// 界面对话按全局配置开启联网：搜索服务用本地模拟，走真实 fetch
const env = isolateEnv()
const home = env.home
const cwd = join(env.dir, 'project')
mkdirSync(cwd, { recursive: true })
mkdirSync(join(home, '.ugc-lens'), { recursive: true })
const search = await startMockServer((_req, res) => sendJson(res, 200, { results: [{ title: '梗的出处', url: 'https://wiki.example/meme', content: '这个梗出自某部动画', engine: 'mock' }] }))

let script: FakeScript = []
let lastModel: ReturnType<typeof createFakeModel> | undefined
const chatModels = () => {
  const fake = lastModel = createFakeModel(script)
  const model: AgentModel = {
    complete: async (request) => typeof request.toolChoice === 'object' && request.toolChoice.function.name === 'submit_profile'
      ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submit_profile', arguments: '{"entries":[]}' } }] }, finishReason: 'tool_calls', usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' }
      : fake.complete(request),
  }
  return { ask: model, analysis: model, name: 'fake' }
}
const ui = createUiServer({ cwd, token: 't', homeDir: home, chatModels, staticDir: cwd })
let port = 0
before(async () => { await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done)); port = (ui.server.address() as AddressInfo).port })
after(async () => { await ui.close(); ui.server.closeAllConnections(); await new Promise((done) => ui.server.close(done)); await search.close(); env.restore() })

const writeWeb = (web: unknown) => writeFileSync(globalConfigPath(home), JSON.stringify({ web }))
beforeEach(() => writeWeb(undefined))

async function ask(text: string): Promise<any[]> {
  const headers = { 'x-ugc-lens-token': 't', 'content-type': 'application/json' }
  const created = await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers, body: '{}' })).json() as { id: string }
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/${created.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) })
  assert.equal(res.status, 200)
  return (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('ui 对话：全局配置开启联网后可以搜索，done 带可点击的来源与外部引用核对', async () => {
  writeWeb({ enabled: true, provider: 'searxng', base_url: search.baseUrl })
  script = [
    { tool_calls: [{ name: 'web_search', args: { query: '梗 出处' } }] },
    { content: '外部资料显示「这个梗出自某部动画」[web:1]，另见 [web:7]' },
  ]
  const events = await ask('这个梗是什么意思')
  const done = events.at(-1)
  assert.equal(done.type, 'done', JSON.stringify(events))
  assert.ok(String(lastModel!.requests[0]!.messages[0]!.content).includes(WEB_PROMPT))
  assert.ok(lastModel!.requests[0]!.tools.some((t) => t.function.name === 'web_search'))
  assert.deepEqual(done.web_sources, [{ id: 'web:1', title: '梗的出处', url: 'https://wiki.example/meme' }])
  assert.deepEqual(done.web_citations.valid, ['web:1'])
  assert.deepEqual(done.web_citations.invalid, ['web:7'])
  assert.ok(search.requests.length >= 1)
})

test('ui 对话：没有开启联网时没有联网工具，done 不带来源', async () => {
  script = [{ content: '数据里没有相关内容' }]
  const events = await ask('这个梗是什么意思')
  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(lastModel!.requests[0]!.tools.some((t) => t.function.name.startsWith('web_')), false)
  assert.equal(done.web_sources, undefined)
})

test('ui 对话：联网配置无效时照常回答，并提示原因', async () => {
  writeWeb({ enabled: true, provider: 'tavily' })
  script = [{ content: '先按数据回答' }]
  const events = await ask('这个梗是什么意思')
  assert.equal(events.at(-1).type, 'done')
  const warning = events.find((e) => e.type === 'warning')
  assert.match(warning?.message ?? '', /联网未开启.*key/)
  assert.equal(lastModel!.requests[0]!.tools.some((t) => t.function.name.startsWith('web_')), false)
})

test('ui 对话：恢复带联网历史的对话时，联网会话据历史标记已用过网页内容（写入工具需要审批）', async () => {
  const { createChatHub } = await import('../../src/ui/chat.ts')
  const observed: unknown[] = []
  const fakeWeb = { config: {} as never, sources: new Map(), used: false, tools: () => [], observeHistory: (messages: readonly unknown[]) => { observed.push(...messages) } }
  const dir = join(home, '.ugc-lens', 'ui', 'chats')
  mkdirSync(dir, { recursive: true })
  const id = 'resumeweb01'
  const history = [{ role: 'user', content: '查一下' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '外部内容' }, { role: 'assistant', content: '好的' }]
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: 't', cwd, created_at: '', updated_at: '', turns: [] }))
  writeFileSync(join(dir, `${id}.messages.json`), JSON.stringify(history))
  script = [{ content: '继续' }]
  const hub = createChatHub({ cwd, homeDir: home, models: chatModels, web: () => ({ session: fakeWeb }) })
  const { EventEmitter } = await import('node:events')
  const res = Object.assign(new EventEmitter(), { writeHead() {}, write() { return true }, end() {}, writableEnded: false, destroyed: false }) as never
  await hub.send(id, { text: '还有吗' }, new EventEmitter() as never, res)
  await hub.close()
  assert.equal(observed.length, history.length)
})
