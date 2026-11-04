import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import type { LlmConfig } from '../../src/config.ts'
import { LlmError, createChatClient } from '../../src/llm/client.ts'
import { completion, sendJson, startMockServer } from '../helpers/mock_server.ts'

let server: Awaited<ReturnType<typeof startMockServer>> | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function configFor(baseUrl: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { provider: 'custom', model: 'test-model', baseUrl, apiKey: 'secret', timeoutMs: 5_000, ...overrides }
}

describe('createChatClient', () => {
  test('chat 发送 model、messages 和参数，并解析回答与 usage', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('你好', { prompt_tokens: 7, completion_tokens: 3 })))
    const client = createChatClient(configFor(server.baseUrl))

    const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.3, maxTokens: 50 })

    assert.equal(result.message.content, '你好')
    assert.equal(result.finishReason, 'stop')
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 })

    const request = server.requests[0]
    assert.ok(request)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer secret')
    assert.deepEqual(request.body, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      max_tokens: 50,
    })
  })

  test('没有 key 时不发送 Authorization', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    await createChatClient(configFor(server.baseUrl, { apiKey: undefined })).chat([{ role: 'user', content: 'hi' }])
    assert.equal(server.requests[0]?.headers.authorization, undefined)
  })

  test('HTTP 错误转成带状态码的 LlmError', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 401, { error: 'bad key' }))
    const client = createChatClient(configFor(server.baseUrl))
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.status, 401)
      return true
    })
  })

  test('返回不是 JSON 时报错', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end('<html>')
    })
    await assert.rejects(createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }]), /不是 JSON/)
  })

  test('未设置模型时不发请求', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    const client = createChatClient(configFor(server.baseUrl, { model: '' }))
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }]), /未设置模型/)
    assert.equal(server.requests.length, 0)
  })

  test('超过 timeoutMs 时中断请求', async () => {
    server = await startMockServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      sendJson(res, 200, completion('late'))
    })
    const client = createChatClient(configFor(server.baseUrl, { timeoutMs: 50 }))
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }]), { name: 'TimeoutError' })
  })

  test('listModels 返回排序后的模型 ID', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { data: [{ id: 'b' }, { id: 'a' }] }))
    assert.deepEqual(await createChatClient(configFor(server.baseUrl)).listModels(), ['a', 'b'])
    assert.equal(server.requests[0]?.url, '/v1/models')
  })
})
