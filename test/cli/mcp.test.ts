import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { parseMcpArgs } from '../../src/cli/mcp.ts'
import { isolateEnv } from '../helpers/env.ts'
import { BV_FIXTURE, BILIBILI_MAPPING } from '../helpers/fixtures.ts'
import { completion, sendJson, startMockServer } from '../helpers/mock_server.ts'

const CLI = process.env.UGC_LENS_TEST_CLI ?? fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url))

test('mcp 参数只接受工作目录', () => {
  assert.equal(parseMcpArgs(['--cwd', '/data']).cwd, '/data')
  assert.throws(() => parseMcpArgs(['data']), /位置参数/)
  assert.throws(() => parseMcpArgs(['--cwd', ' ']), /目录路径/)
})

test('真实 stdio 握手、工具发现、模型 HTTP 调用和连续追问', { timeout: 10_000 }, async () => {
  const isolated = isolateEnv()
  const server = await startMockServer((request, response) => {
    const body = request.body as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> }
    if (body.tools?.some((tool) => tool.function.name === 'submit_mapping')) {
      if (body.messages.some((message) => message.role === 'tool')) return sendJson(response, 200, completion('映射完成'))
      return sendJson(response, 200, {
        model: 'mock-model', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'map1', type: 'function', function: { name: 'submit_mapping', arguments: JSON.stringify(BILIBILI_MAPPING) } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    }
    return sendJson(response, 200, completion('这是根据数据给出的回答'))
  })
  const project = join(isolated.dir, 'project')
  await mkdir(join(project, '.ugc-lens'), { recursive: true })
  await writeFile(join(project, '.ugc-lens', 'config.json'), JSON.stringify({ llm: { provider: 'custom', model: 'mock-model', base_url: server.baseUrl, max_retries: 0 } }))
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--cwd', project], cwd: isolated.dir, env: { HOME: isolated.dir }, stderr: 'pipe' })
  const client = new Client({ name: 'ugc-integration', version: '1.0.0' })
  let stderr = ''
  try {
    await client.connect(transport)
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const { tools } = await client.listTools()
    assert.ok(tools.some((tool) => tool.name === 'analyze'))
    const first = await client.callTool({ name: 'ask', arguments: { file: BV_FIXTURE, question: '主要说什么？' } })
    assert.equal(Boolean(first.isError), false, JSON.stringify(first))
    const text = first.content.find((block) => block.type === 'text')
    assert.ok(text?.type === 'text')
    const body = JSON.parse(text.text) as { conversation_id: string; dataset_id: string }
    assert.ok(body.conversation_id)
    const second = await client.callTool({ name: 'ask', arguments: { conversation_id: body.conversation_id, question: '接着上面的说' } })
    assert.equal(Boolean(second.isError), false)
    assert.ok(server.requests.length > 1)
    const last = server.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    assert.deepEqual(last.messages.filter((m) => m.role === 'user').map((m) => m.content), ['主要说什么？', '接着上面的说'])
    const listed = await client.callTool({ name: 'list_datasets' })
    assert.match(JSON.stringify(listed), new RegExp(body.dataset_id))
    assert.doesNotMatch(stderr, /Error|错误/)
  } finally { await client.close(); await server.close(); isolated.restore() }
})

test('兼容 2025 协议握手，stdout 只有 JSON-RPC，EOF 后退出', { timeout: 5_000 }, async () => {
  const isolated = isolateEnv()
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: isolated.dir, env: { HOME: isolated.dir }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  const iterator = lines[Symbol.asyncIterator]()
  const send = (body: unknown) => child.stdin.write(`${JSON.stringify(body)}\n`)
  const next = async () => {
    const line = await iterator.next()
    assert.equal(line.done, false)
    return JSON.parse(line.value!) as { id: number; result: Record<string, unknown>; error?: unknown }
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } })
    const handshake = await next()
    assert.equal(handshake.id, 1)
    assert.equal(handshake.result.protocolVersion, '2025-11-25')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = await next()
    assert.equal(tools.id, 2)
    assert.ok(Array.isArray(tools.result.tools))
    child.stdin.end()
    const [code] = await closed
    assert.equal(code, 0)
  } finally { child.kill(); lines.close(); await closed; isolated.restore() }
})

test('握手前 EOF 也会退出，错误的工作目录不输出协议外正文', { timeout: 5_000 }, async () => {
  const isolated = isolateEnv()
  try {
    for (const args of [[], ['--cwd', join(isolated.dir, 'missing')]]) {
      const child = spawn(process.execPath, [CLI, 'mcp', ...args], { cwd: isolated.dir, env: { HOME: isolated.dir } })
      const closed = once(child, 'close')
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      child.stdin.end()
      const [code] = await closed
      assert.equal(stdout, '')
      assert.equal(code, args.length ? 2 : 0, stderr)
    }
  } finally { isolated.restore() }
})

test('实际安装入口可通过 MCP 导入 TXT、CSV、JSONL 后按 record 查询', { timeout: 10_000 }, async () => {
  const isolated = isolateEnv()
  const mapping = { platform: 'unknown', collections: [{ kind: 'record', path: '$.rows', fields: { id: 'column_1', text: 'column_2' } }] }
  const server = await startMockServer((request, response) => {
    const body = request.body as { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string } }> }
    if (body.messages.some((m) => m.role === 'tool')) return sendJson(response, 200, completion('完成'))
    return sendJson(response, 200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'mapping', type: 'function', function: { name: 'submit_mapping', arguments: JSON.stringify(mapping) } }] }, finish_reason: 'tool_calls' }] })
  })
  const project = join(isolated.dir, 'project')
  await mkdir(join(project, '.ugc-lens'), { recursive: true })
  await writeFile(join(project, '.ugc-lens', 'config.json'), JSON.stringify({ llm: { provider: 'custom', model: 'mock-model', base_url: server.baseUrl, max_retries: 0 } }))
  await writeFile(join(project, 'survey.csv'), '编号,回答\n001,希望增加售后支持\n002,价格偏高')
  await writeFile(join(project, 'notes.txt'), '客服回复慢\n\n希望改善售后')
  await writeFile(join(project, 'answers.ndjson'), '"交付速度快"\n"希望改善售后"')
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--cwd', project], cwd: isolated.dir, env: { HOME: isolated.dir }, stderr: 'pipe' })
  const client = new Client({ name: 'formats-test', version: '1' })
  try {
    await client.connect(transport)
    for (const file of ['survey.csv', 'notes.txt', 'answers.ndjson']) {
      const imported = await client.callTool({ name: 'load_dataset', arguments: { file } })
      assert.equal(Boolean(imported.isError), false, JSON.stringify(imported))
      const block = imported.content.find((b) => b.type === 'text')!
      assert.equal(block.type, 'text')
      const { dataset_id } = JSON.parse(block.text)
      const result = await client.callTool({ name: 'search_feedback', arguments: { dataset_id, kinds: ['record'], query: '售后' } })
      assert.match(JSON.stringify(result), /售后/)
      assert.equal(Boolean(result.isError), false)
    }
    assert.ok(server.requests.length > 0, 'CSV 走真实 HTTP 路径识别列')
  } finally { await client.close(); await server.close(); isolated.restore() }
})
