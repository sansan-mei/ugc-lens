import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { createSession } from '../../src/chat/session.ts'
import { runChatFlow } from '../../src/cli/chat.ts'

async function* lines(values: string[]) { yield* values }

test('持续输入、空行、帮助和退出；退出清理会话且不发送控制命令', async () => {
  const model = createFakeModel([{ content: '你好' }, { content: '记得上一句' }])
  const session = createSession({ model })
  const output: string[] = []
  let prompts = 0
  await runChatFlow(session, { lines: lines([' ', '/help', '你好', '上一句呢', '/exit', '不应发送']), print: (s) => output.push(s), prompt: () => { prompts++ } })
  assert.equal(model.requests.length, 2)
  assert.deepEqual(model.requests[1]?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['你好', '上一句呢'])
  assert.ok(output.includes('记得上一句'))
  assert.equal(prompts, 5)
  await assert.rejects(session.ask('你好'), /关闭/)
})

test('单轮模型请求失败后仍可继续；EOF 清理会话', async () => {
  const fake = createFakeModel([{ content: '恢复成功' }])
  let fail = true
  const session = createSession({ model: { complete(request) {
    if (fail) { fail = false; return Promise.reject(new Error('请求失败')) }
    return fake.complete(request)
  } } })
  const output: string[] = []
  await runChatFlow(session, { lines: lines(['第一个问题', '再试一次']), print: (s) => output.push(s), prompt() {} })
  assert.ok(output.some((s) => s.includes('请求失败')))
  assert.ok(output.includes('恢复成功'))
  await assert.rejects(session.ask('你好'), /关闭/)
})

test('取消后不再发送后续输入，清理会话', async () => {
  const controller = new AbortController()
  const session = createSession({ model: createFakeModel([{ content: '不应调用' }]) })
  controller.abort()
  await runChatFlow(session, { lines: lines(['你好']), print() {}, prompt() {} }, controller.signal)
  await assert.rejects(session.ask('你好'), /关闭/)
})

test('默认终端入口经过真实 HTTP 客户端连续对话，粘贴的多行输入不丢失', async () => {
  const { spawn } = await import('node:child_process')
  const { isolateEnv } = await import('../helpers/env.ts')
  const { completion, sendJson, startMockServer } = await import('../helpers/mock_server.ts')
  const isolated = isolateEnv()
  const server = await startMockServer((request, response) => {
    const body = request.body as { messages: Array<{ role: string }> }
    const turn = body.messages.filter((m) => m.role === 'user').length
    sendJson(response, 200, completion(`第 ${turn} 轮回答`))
  })
  try {
    const cli = new URL('../../src/cli/index.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `Object.defineProperty(process.stdin, 'isTTY', { value: true }); await import(${JSON.stringify(cli)})`], {
      cwd: isolated.dir,
      env: { PATH: process.env.PATH, HOME: isolated.dir, UGC_LENS_PROVIDER: 'custom', UGC_LENS_MODEL: 'mock-model', UGC_LENS_BASE_URL: server.baseUrl },
      timeout: 5_000,
    })
    let output = ''
    let errors = ''
    let sent = false
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (!sent && output.includes('你 >')) { sent = true; child.stdin.write('你好\n再问一句\n/exit\n') }
    })
    child.stderr.on('data', (data: Buffer) => { errors += data.toString() })
    const code = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('close', done) })
    assert.equal(code, 0, errors)
    assert.match(output, /第 1 轮回答/)
    assert.match(output, /第 2 轮回答/)
    assert.equal(server.requests.length, 2)
    const body = server.requests[1]!.body as { messages: Array<{ role: string; content: string }> }
    assert.deepEqual(body.messages.filter((m) => m.role === 'user').map((m) => m.content), ['你好', '再问一句'])
  } finally { await server.close(); isolated.restore() }
})
