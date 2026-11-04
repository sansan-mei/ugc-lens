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

  test('带工具时发送 tools 和 tool_choice，并解析返回的 tool_calls', async () => {
    server = await startMockServer((_req, res) =>
      sendJson(res, 200, {
        model: 'mock-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    const tools = [{ type: 'function' as const, function: { name: 'echo', description: 'd', parameters: { type: 'object' } } }]
    const result = await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }], {
      tools,
      toolChoice: 'none',
    })

    const body = server.requests[0]?.body as Record<string, unknown>
    assert.deepEqual(body.tools, tools)
    assert.equal(body.tool_choice, 'none')
    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(result.message.content, null)
    assert.deepEqual(result.message.tool_calls, [
      { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } },
    ])
  })

  test('没有工具时请求里不带 tools 和 tool_choice，回答里也没有 tool_calls 字段', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    const result = await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }], {
      tools: [],
      toolChoice: 'auto',
    })
    const body = server.requests[0]?.body as Record<string, unknown>
    assert.equal('tools' in body, false)
    assert.equal('tool_choice' in body, false)
    assert.equal('tool_calls' in result.message, false)
  })

  test('补全缺失的 tool_call id，arguments 是对象时转成 JSON 字符串', async () => {
    server = await startMockServer((_req, res) =>
      sendJson(res, 200, {
        model: 'mock-model',
        choices: [
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { text: 'x' } } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    const result = await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }])
    const call = result.message.tool_calls?.[0]
    assert.ok(call?.id)
    assert.equal(call.type, 'function')
    assert.deepEqual(JSON.parse(call.function.arguments), { text: 'x' })
  })

  test('listModels 返回排序后的模型 ID', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { data: [{ id: 'b' }, { id: 'a' }] }))
    assert.deepEqual(await createChatClient(configFor(server.baseUrl)).listModels(), ['a', 'b'])
    assert.equal(server.requests[0]?.url, '/v1/models')
  })
})
