import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { createMcpServer } from '../../src/mcp/server.ts'
import { createDataTools } from '../../src/tools/data/index.ts'
import { createDatasetStore } from '../../src/dataset/store.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'
import { isolateEnv } from '../helpers/env.ts'

const dataset = makeDataset([makeItem({ id: 'c1', text: '价格太贵', likes: 10 }), makeItem({ id: 'c2', text: '内容很好' })])
const text = (result: CallToolResult) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
async function connect(options: Parameters<typeof createMcpServer>[0] = {}) {
  const server = createMcpServer(options)
  const client = new Client({ name: 'ugc-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  return { server, client, close: async () => { await client.close(); await server.close() } }
}

test('握手和工具发现不需要模型配置，数据工具沿用原有 schema', async () => {
  const env = isolateEnv()
  const connection = await connect({ cwd: env.dir })
  try {
    assert.equal(connection.client.getServerVersion()?.name, 'ugc-lens')
    const { tools } = await connection.client.listTools()
    for (const tool of createDataTools(createDatasetStore([]))) {
      const registered = tools.find((candidate) => candidate.name === tool.name)
      assert.ok(registered)
      assert.deepEqual(registered.inputSchema.properties, tool.parameters.properties)
      assert.equal(registered.annotations?.readOnlyHint, true)
    }
    for (const name of ['load_dataset', 'analyze', 'ask']) assert.ok(tools.some((tool) => tool.name === name))
    const listed = await connection.client.callTool({ name: 'list_datasets' })
    assert.equal(Boolean(listed.isError), false)
    assert.match(text(listed), /没有|无|未/)
  } finally { await connection.close(); env.restore() }
})

test('导入后查询和生成报告复用核心接口，路径以服务 cwd 为准', async () => {
  const loaded: string[] = []
  const analyzed: unknown[] = []
  const connection = await connect({
    cwd: '/data', model: createFakeModel([]),
    load: async (file) => { loaded.push(file); return { ...dataset, file_path: file } },
    analyze: async (options) => {
      analyzed.push({ id: options.dataset.id, cwd: options.cwd, directions: options.directions })
      return { markdown: '# 报告', path: '/data/report.md', calls: 1, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }
    },
  })
  try {
    const imported = await connection.client.callTool({ name: 'load_dataset', arguments: { file: 'video.json' } })
    const data = JSON.parse(text(imported)) as { dataset_id: string }
    const search = await connection.client.callTool({ name: 'search_feedback', arguments: { dataset_id: data.dataset_id, query: '价格' } })
    assert.match(text(search), /\[c1\].*价格太贵/)
    assert.doesNotMatch(text(search), /\[c2\]/)
    const report = await connection.client.callTool({ name: 'analyze', arguments: { file: 'video.json', directions: ['价格'] } })
    assert.match(text(report), /# 报告/)
    assert.match(text(report), /\/data\/report.md/)
    assert.deepEqual(loaded, ['/data/video.json'])
    assert.deepEqual(analyzed, [{ id: dataset.id, cwd: '/data', directions: ['价格'] }])
  } finally { await connection.close() }
})

test('ask 返回会话 ID 并保留追问历史，不同会话隔离', async () => {
  const model = createFakeModel([{ content: '价格贵 [c1]' }, { content: '上次说价格贵 [c1]' }, { content: '独立问题 [c2]' }])
  const connection = await connect({ model, load: async () => dataset })
  try {
    const first = await connection.client.callTool({ name: 'ask', arguments: { file: 'a.json', question: '吐槽什么？' } })
    const data = JSON.parse(text(first)) as { conversation_id: string; citations: { valid: string[] } }
    assert.deepEqual(data.citations.valid, ['c1'])
    await connection.client.callTool({ name: 'ask', arguments: { conversation_id: data.conversation_id, question: '上次说什么？' } })
    await connection.client.callTool({ name: 'ask', arguments: { dataset_id: dataset.id, question: '独立问题' } })
    assert.deepEqual(model.requests[1]?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['吐槽什么？', '上次说什么？'])
    assert.deepEqual(model.requests[2]?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['独立问题'])
    const wrong = await connection.client.callTool({ name: 'ask', arguments: { conversation_id: 'missing', question: 'q' } })
    assert.equal(wrong.isError, true)
  } finally { await connection.close() }
})

test('业务错误和无效参数是错误工具结果，之后仍能调用', async () => {
  const connection = await connect({ model: createFakeModel([]), load: async () => { throw new Error('文件不存在') } })
  try {
    const failed = await connection.client.callTool({ name: 'load_dataset', arguments: { file: 'missing.json' } })
    assert.equal(failed.isError, true)
    assert.match(text(failed), /文件不存在/)
    const invalid = await connection.client.callTool({ name: 'load_dataset', arguments: {} })
    assert.equal(invalid.isError, true)
    const listed = await connection.client.callTool({ name: 'list_datasets' })
    assert.equal(Boolean(listed.isError), false)
  } finally { await connection.close() }
})

test('取消 MCP 请求传递到分析流水线', async () => {
  let started!: () => void
  const running = new Promise<void>((done) => { started = done })
  let cancelled!: () => void
  const aborted = new Promise<void>((done) => { cancelled = done })
  const connection = await connect({ model: createFakeModel([]), load: async () => dataset, analyze: async ({ signal }) => {
    started()
    await new Promise<void>((done) => signal?.addEventListener('abort', () => { cancelled(); done() }, { once: true }))
    signal?.throwIfAborted()
    throw new Error('应当已取消')
  } })
  try {
    const controller = new AbortController()
    const request = connection.client.callTool({ name: 'analyze', arguments: { file: 'a.json' } }, { signal: controller.signal })
    const rejected = assert.rejects(request)
    await running
    controller.abort()
    await rejected
    await aborted
  } finally { await connection.close() }
})

test('同一实例的数据不会泄漏给另一个实例', async () => {
  const one = await connect({ model: createFakeModel([]), load: async () => dataset })
  const two = await connect()
  try {
    await one.client.callTool({ name: 'load_dataset', arguments: { file: 'a.json' } })
    assert.match(text(await one.client.callTool({ name: 'list_datasets' })), new RegExp(dataset.id))
    assert.doesNotMatch(text(await two.client.callTool({ name: 'list_datasets' })), new RegExp(dataset.id))
  } finally { await one.close(); await two.close() }
})

test('追问禁止切换数据集，同一会话并发请求只接受一个', async () => {
  const model = createFakeModel([{ content: '第一轮' }, { content: '第二轮' }], { delayMs: 20 })
  const connection = await connect({ model, load: async (file) => ({ ...dataset, id: file.endsWith('b.json') ? 'other' : dataset.id, file_path: file }) })
  try {
    const first = await connection.client.callTool({ name: 'ask', arguments: { file: 'a.json', question: 'q1' } })
    const { conversation_id } = JSON.parse(text(first)) as { conversation_id: string }
    await connection.client.callTool({ name: 'load_dataset', arguments: { file: 'b.json' } })
    const wrong = await connection.client.callTool({ name: 'ask', arguments: { dataset_id: 'other', conversation_id, question: 'q2' } })
    assert.equal(wrong.isError, true)
    assert.match(text(wrong), /其他数据集/)
    const results = await Promise.all([
      connection.client.callTool({ name: 'ask', arguments: { conversation_id, question: 'q2' } }),
      connection.client.callTool({ name: 'ask', arguments: { conversation_id, question: 'q3' } }),
    ])
    assert.equal(results.filter((result) => result.isError).length, 1)
    assert.equal(model.requests.length, 2)
    assert.equal(model.requests.at(-1)?.messages.filter((message) => message.role === 'user').length, 2)
  } finally { await connection.close() }
})

test('宿主断开时取消尚未完成的分析', async () => {
  let started!: () => void
  const running = new Promise<void>((done) => { started = done })
  let cancelled!: () => void
  const aborted = new Promise<void>((done) => { cancelled = done })
  const connection = await connect({ model: createFakeModel([]), load: async () => dataset, analyze: async ({ signal }) => {
    started()
    await new Promise<void>((done) => signal?.addEventListener('abort', () => { cancelled(); done() }, { once: true }))
    signal?.throwIfAborted()
    throw new Error('应当已取消')
  } })
  try {
    const request = connection.client.callTool({ name: 'analyze', arguments: { file: 'a.json' } })
    const rejected = assert.rejects(request)
    await running
    await connection.client.close()
    await rejected
    await aborted
  } finally { await connection.close() }
})

test('启用 memory 后 MCP 提供经验与待审工具；追问冻结规则，新对话重新读取', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { initPlaybook, loadPlaybook, readProposal } = await import('../../src/memory/playbook.ts')
  const cwd = mkdtempSync(join(tmpdir(), 'ugc-mcp-memory-'))
  const memory = { cwd, homeDir: cwd }
  const path = initPlaybook(memory)
  const model = createFakeModel([{ content: '第一轮 [c1]' }, { content: '第二轮 [c1]' }, { content: '新对话 [c1]' }])
  const connection = await connect({ cwd, memory, model, load: async () => dataset })
  try {
    const { tools } = await connection.client.listTools()
    for (const name of ['search_learnings', 'record_learning', 'playbook_update']) assert.ok(tools.some((t) => t.name === name))
    assert.equal(tools.find((t) => t.name === 'search_learnings')?.annotations?.readOnlyHint, true)
    const first = JSON.parse(text(await connection.client.callTool({ name: 'ask', arguments: { file: 'a.json', question: 'q' } })))
    const changed = loadPlaybook(memory).text.replace('使用中文', '使用简体中文')
    writeFileSync(path, changed)
    await connection.client.callTool({ name: 'ask', arguments: { conversation_id: first.conversation_id, question: '继续' } })
    await connection.client.callTool({ name: 'ask', arguments: { dataset_id: dataset.id, question: '新对话' } })
    assert.deepEqual(model.requests[0]?.messages[0], model.requests[1]?.messages[0])
    assert.match(model.requests[2]?.messages[0]?.content ?? '', /使用简体中文/)
    const candidate = await connection.client.callTool({ name: 'record_learning', arguments: { note: '价格观察', evidence_ids: ['c1'] } })
    assert.equal(Boolean(candidate.isError), false)
    const found = await connection.client.callTool({ name: 'search_learnings', arguments: { query: '价格观察', dataset_id: dataset.id } })
    assert.match(text(found), /价格观察/)
    const pending = await connection.client.callTool({ name: 'playbook_update', arguments: { operation: 'add', section: 'ask', text: '- 先列出证据。' } })
    assert.equal(Boolean(pending.isError), false)
    assert.ok(readProposal(memory))
    assert.doesNotMatch(loadPlaybook(memory).text, /先列出证据/)
  } finally { await connection.close(); rmSync(cwd, { recursive: true, force: true }) }
})
