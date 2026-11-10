import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createFakeModel, type FakeScript } from '../../src/agent/fake_model.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { ConfigError } from '../../src/config.ts'
import { createUiServer } from '../../src/ui/server.ts'
import { BV_FIXTURE } from '../helpers/fixtures.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-ui-chat-'))
const cwd = join(root, 'project')
const outside = join(root, 'outside')
mkdirSync(join(cwd, 'data'), { recursive: true })
mkdirSync(outside, { recursive: true })
copyFileSync(BV_FIXTURE, join(cwd, 'data', 'bilibili_all.json'))
writeFileSync(join(outside, 'secret.json'), '[{"text":"secret"}]')

// 每个测试换一份剧本；没有剧本时模拟未配置模型
let script: FakeScript | undefined
let delayMs = 0
let lastModel: ReturnType<typeof createFakeModel> | undefined
const chatModels = () => {
  if (!script) throw new ConfigError('没有配置模型')
  const fake = lastModel = createFakeModel(script, { delayMs })
  // 画像学习的请求单独应答，剧本只描述对话本身
  const model: AgentModel = {
    complete: async (request) => typeof request.toolChoice === 'object' && request.toolChoice.function.name === 'submit_profile'
      ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submit_profile', arguments: '{"entries":[]}' } }] }, finishReason: 'tool_calls', usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' }
      : fake.complete(request),
  }
  return { ask: model, analysis: model, name: 'fake' }
}
const noModel = { complete: async () => { throw new ConfigError('没有配置模型') } }
const ui = createUiServer({ cwd, token: 't', homeDir: join(root, 'home'), picker: { available: false, pick: async () => undefined }, model: noModel, chatModels, staticDir: root })
let port = 0
before(async () => { await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done)); port = (ui.server.address() as AddressInfo).port })
after(async () => { await ui.close(); ui.server.closeAllConnections(); await new Promise((done) => ui.server.close(done)); rmSync(root, { recursive: true, force: true }) })

type Reply = { status: number; type: string; text: string; json: any; events: any[] }
function call(path: string, options: { method?: string; body?: unknown; onChunk?: (text: string, abort: () => void) => void } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'x-ugc-lens-token': 't' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
      let text = ''
      const finish = () => {
        let json: unknown
        try { json = JSON.parse(text) } catch { json = undefined }
        const events = text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
        resolve({ status: res.statusCode!, type: String(res.headers['content-type']), text, json, events })
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk; options.onChunk?.(text, () => { req.destroy(); finish() }) })
      res.on('end', finish)
    })
    req.on('error', (error) => { if (!req.destroyed) reject(error) })
    if (options.body !== undefined) req.write(JSON.stringify(options.body))
    req.end()
  })
}

async function openDataset(): Promise<{ id: string; itemId: string }> {
  const opened = await call('/api/open', { method: 'POST', body: { path: 'data/bilibili_all.json' } })
  assert.equal(opened.status, 200, opened.text)
  const items = await call(`/api/datasets/${opened.json.id}/items?limit=1&kinds=comment`)
  return { id: opened.json.id, itemId: items.json.items[0].id }
}

test('ui 对话：没有模型配置时返回可读错误，不开始对话', async () => {
  script = undefined
  const created = await call('/api/chat', { method: 'POST', body: {} })
  assert.equal(created.status, 422, created.text)
  assert.match(created.json.error, /没有配置模型/)
})

test('ui 对话：接入当前打开的数据集，流式返回正文片段、工具进度和核对后的引用', async () => {
  const { id, itemId } = await openDataset()
  script = [
    { tool_calls: [{ name: 'search_feedback', args: { kinds: ['comment'] } }] },
    { content: `有人这样说 [${itemId}]，还有 [nope_1]`, deltas: ['有人这样说 ', `[${itemId}]`, '，还有 [nope_1]'] },
  ]
  const created = await call('/api/chat', { method: 'POST', body: {} })
  assert.equal(created.status, 200, created.text)
  const sid = created.json.id as string
  const reply = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '大家怎么评价', dataset_id: id } })
  assert.equal(reply.status, 200, reply.text)
  assert.match(reply.type, /application\/x-ndjson/)
  const types = reply.events.map((e) => e.type)
  assert.ok(types.indexOf('tool') < types.indexOf('tool_end'))
  assert.equal(reply.events.find((e) => e.type === 'tool').name, 'search_feedback')
  assert.equal(reply.events.find((e) => e.type === 'tool_end').ok, true)
  assert.equal(reply.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), `有人这样说 [${itemId}]，还有 [nope_1]`)
  const done = reply.events.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.answer, `有人这样说 [${itemId}]，还有 [nope_1]`)
  assert.deepEqual(done.citations, { valid: [itemId], invalid: ['nope_1'] })
  assert.equal(done.stop_reason, 'completed')
  // 搜索工具结果来自界面打开的数据集，而不是重新导入
  const toolMessage = lastModel!.requests.at(-1)!.messages.find((m) => m.role === 'tool')
  assert.match(String(toolMessage?.content), new RegExp(itemId))

  // 追问沿用同一会话的历史
  script.push({ content: '补充说明', deltas: ['补充说明'] })
  const again = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '再说说' } })
  assert.equal(again.events.at(-1).answer, '补充说明')
  assert.deepEqual(lastModel!.requests.at(-1)!.messages.filter((m) => m.role === 'user').map((m) => m.content), ['大家怎么评价', '再说说'])
})

test('ui 对话：模型只能访问启动目录和用户选中的文件', async () => {
  script = [
    { tool_calls: [{ name: 'load_dataset', args: { file: join(outside, 'secret.json') } }, { name: 'list_files', args: { dir: '.' } }] },
    { content: '外部文件无法读取' },
  ]
  const sid = (await call('/api/chat', { method: 'POST', body: {} })).json.id
  const reply = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '读一下外面的文件' } })
  assert.equal(reply.events.at(-1).type, 'done')
  const tools = lastModel!.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
  assert.match(tools[0]!, /只能访问启动目录内的文件/)
  assert.doesNotMatch(tools[0]!, /secret"/)
  assert.match(tools[1]!, /"name":"data"/)
  assert.deepEqual(reply.events.filter((e) => e.type === 'tool_end').map((e) => e.ok), [false, true])
})

test('ui 对话：参数校验、未知会话、上一轮未完成时拒绝', async () => {
  script = [{ content: '慢回答', deltas: ['慢'] }, { content: '第二轮' }]
  delayMs = 200
  const sid = (await call('/api/chat', { method: 'POST', body: {} })).json.id
  assert.equal((await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '  ' } })).status, 400)
  assert.equal((await call('/api/chat/unknown/messages', { method: 'POST', body: { text: 'hi' } })).status, 404)
  const slow = call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '第一轮' } })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '插队' } })).status, 409)
  assert.equal((await slow).events.at(-1).answer, '慢回答')
  delayMs = 0
  assert.equal((await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '第二轮' } })).events.at(-1).answer, '第二轮')
  assert.equal((await call(`/api/chat/${sid}`, { method: 'DELETE' })).status, 200)
  assert.equal((await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: 'hi' } })).status, 404)
})

test('ui 对话：浏览器断开时取消本轮，会话之后仍可继续', async () => {
  const lastUser = (messages: readonly { role: string; content?: unknown }[]) => String(messages.filter((m) => m.role === 'user').at(-1)?.content)
  script = (request) => {
    if (lastUser(request.messages) === '继续') return { content: '继续可用' }
    return request.messages.at(-1)?.role === 'tool' ? { content: '不会返回' } : { tool_calls: [{ name: 'list_files', args: {} }] }
  }
  delayMs = 150
  const sid = (await call('/api/chat', { method: 'POST', body: {} })).json.id
  const cut = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '开始' }, onChunk: (text, abort) => { if (text.includes('"tool_end"')) abort() } })
  assert.ok(cut.events.some((e) => e.type === 'tool_end'))
  assert.equal(cut.events.some((e) => e.type === 'done'), false)
  await new Promise((r) => setTimeout(r, 400))
  delayMs = 0
  const next = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: '继续' } })
  assert.equal(next.status, 200, next.text)
  assert.equal(next.events.at(-1).answer, '继续可用')
})

test('ui 对话：模型出错时以 error 事件结束本轮', async () => {
  script = () => { throw new Error('上游 500') }
  const sid = (await call('/api/chat', { method: 'POST', body: {} })).json.id
  const reply = await call(`/api/chat/${sid}/messages`, { method: 'POST', body: { text: 'hi' } })
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.events.at(-1), { type: 'error', message: '上游 500' })
})
