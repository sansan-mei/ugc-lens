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

  test('超过 timeoutMs 时中断请求，作为可重试的 LlmError', async () => {
    server = await startMockServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      sendJson(res, 200, completion('late'))
    })
    const client = createChatClient(configFor(server.baseUrl, { timeoutMs: 50, maxRetries: 1 }), { retry: { baseDelayMs: 1 } })
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.retryable, true)
      assert.match(error.message, /超过 50ms 未完成.*已重试 1 次/)
      return true
    })
    assert.equal(server.requests.length, 2)
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

  test('disableThinking：按提供商预设加上关闭思考的字段，没有预设的提供商不加', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    const hi = [{ role: 'user' as const, content: 'hi' }]
    await createChatClient(configFor(server.baseUrl, { provider: 'deepseek' })).chat(hi, { disableThinking: true })
    await createChatClient(configFor(server.baseUrl, { provider: 'deepseek' })).chat(hi)
    await createChatClient(configFor(server.baseUrl, { provider: 'openai' })).chat(hi, { disableThinking: true })
    const bodies = server.requests.map((r) => r.body as Record<string, unknown>)
    assert.deepEqual(bodies[0]?.thinking, { type: 'disabled' })
    assert.equal('thinking' in bodies[1]!, false)
    assert.deepEqual(Object.keys(bodies[2]!).sort(), ['messages', 'model'])
  })

  test('发送前把消息里的半个代理对换成 U+FFFD，否则部分提供商拒绝解析请求', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: '坏\ud83d字😰' }])
    const body = server.requests[0]?.body as { messages: Array<{ content: string }> }
    assert.equal(body.messages[0]?.content, '坏\ufffd字😰')
  })

  test('tool_choice 可以指定必须调用的工具', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    const tools = [{ type: 'function' as const, function: { name: 'echo', description: 'd', parameters: { type: 'object' } } }]
    const toolChoice = { type: 'function' as const, function: { name: 'echo' } }
    await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }], { tools, toolChoice })
    assert.deepEqual((server.requests[0]?.body as Record<string, unknown>).tool_choice, toolChoice)
  })

  test('解析提示词缓存命中的 token：DeepSeek 和 OpenAI 两种写法，没有时不带这个字段', async () => {
    const usages = [
      { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 },
      { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
      { prompt_tokens: 100, completion_tokens: 5 },
    ]
    let call = 0
    server = await startMockServer((_req, res) => sendJson(res, 200, { ...completion('ok'), usage: usages[call++] }))
    const client = createChatClient(configFor(server.baseUrl))
    const results = []
    for (let i = 0; i < usages.length; i++) results.push((await client.chat([{ role: 'user', content: 'hi' }])).usage)
    assert.deepEqual(results.map((u) => u.cached_input_tokens), [80, 64, undefined])
    assert.equal('cached_input_tokens' in results[2]!, false)
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

describe('createChatClient 重试', () => {
  const fastRetry = { retry: { baseDelayMs: 1, maxDelayMs: 2 } }

  test('503 两次后成功：共请求 3 次，每次重试都通知', async () => {
    let count = 0
    server = await startMockServer((_req, res) => {
      count++
      if (count <= 2) return sendJson(res, 503, { error: 'busy' })
      sendJson(res, 200, completion('ok'))
    })
    const retries: number[] = []
    const result = await createChatClient(configFor(server.baseUrl), fastRetry).chat([{ role: 'user', content: 'hi' }], {
      onRetry: (info) => retries.push(info.attempt),
    })
    assert.equal(result.message.content, 'ok')
    assert.equal(server.requests.length, 3)
    assert.deepEqual(retries, [1, 2])
  })

  test('429 带 retry-after-ms 时按它等待', async () => {
    let count = 0
    server = await startMockServer((_req, res) => {
      count++
      if (count === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after-ms': '30' })
        res.end('{"error":"rate limited"}')
        return
      }
      sendJson(res, 200, completion('ok'))
    })
    const delays: number[] = []
    await createChatClient(configFor(server.baseUrl), fastRetry).chat([{ role: 'user', content: 'hi' }], {
      onRetry: (info) => delays.push(info.delayMs),
    })
    assert.deepEqual(delays, [30])
  })

  test('400、401、402、404 不重试', async () => {
    for (const status of [400, 401, 402, 404]) {
      server = await startMockServer((_req, res) => sendJson(res, status, { error: 'no' }))
      await assert.rejects(createChatClient(configFor(server.baseUrl), fastRetry).chat([{ role: 'user', content: 'hi' }]), {
        name: 'LlmError',
      })
      assert.equal(server.requests.length, 1, String(status))
      await server.close()
    }
    server = undefined
  })

  test('重试用完后抛出 LlmError，注明重试次数和状态码', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 500, { error: 'down' }))
    const client = createChatClient({ ...configFor(server.baseUrl), maxRetries: 2 }, fastRetry)
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.status, 500)
      assert.match(error.message, /已重试 2 次/)
      return true
    })
    assert.equal(server.requests.length, 3)
  })

  test('连接失败属于网络错误，会重试', async () => {
    const closed = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    await closed.close()
    const retries: string[] = []
    const client = createChatClient({ ...configFor(closed.baseUrl), maxRetries: 1 }, fastRetry)
    await assert.rejects(
      client.chat([{ role: 'user', content: 'hi' }], { onRetry: (info) => retries.push(info.error.message) }),
      /网络错误.*已重试 1 次/,
    )
    assert.equal(retries.length, 1)
  })

  test('调用方取消时不重试，原样抛出取消错误', async () => {
    server = await startMockServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      sendJson(res, 200, completion('late'))
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(
      createChatClient(configFor(server.baseUrl), fastRetry).chat([{ role: 'user', content: 'hi' }], { signal: controller.signal }),
      { name: 'AbortError' },
    )
    assert.equal(server.requests.length, 1)
  })
})
