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

  test('多轮请求保持已有前缀和工具定义，缓存命中仍属于总输入', async () => {
    let call = 0
    server = await startMockServer((_req, res) => sendJson(res, 200, { ...completion('ok'), usage: {
      prompt_tokens: 100, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: call++ === 0 ? 0 : 80 },
    } }))
    const client = createChatClient(configFor(server.baseUrl))
    const messages = [{ role: 'system' as const, content: '固定分析规则' }, { role: 'user' as const, content: '先看价格争议' }]
    const tools = [{ type: 'function' as const, function: { name: 'query', description: '查询证据', parameters: { type: 'object', properties: {} } } }]
    const snapshot = structuredClone({ messages, tools })
    const first = await client.chat(messages, { tools })
    const next = [...messages, first.message, { role: 'user' as const, content: '再看购买意愿' }]
    const second = await client.chat(next, { tools })
    const bodies = server.requests.map((r) => r.body as { messages: unknown[]; tools: unknown })
    assert.deepEqual(bodies[1]!.messages.slice(0, messages.length), bodies[0]!.messages)
    assert.deepEqual(bodies[1]!.tools, bodies[0]!.tools)
    assert.deepEqual({ messages, tools }, snapshot)
    assert.equal(first.usage.cached_input_tokens, 0)
    assert.ok(second.usage.cached_input_tokens! > first.usage.cached_input_tokens!)
    assert.equal(second.usage.input_tokens, first.usage.input_tokens)
    assert.ok(second.usage.cached_input_tokens! <= second.usage.input_tokens)
    assert.equal(server.requests.length, 2)
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

  test('传入 onDelta 时流式请求：逐段回调正文，拼出工具调用和用量', async () => {
    const events = [
      { model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
      { model: 'mock-model', choices: [{ index: 0, delta: { content: '好，' } }] },
      { model: 'mock-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '' } }] } }] },
      { model: 'mock-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { model: 'mock-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"价格"}' } }, { index: 1, id: 'call_b', function: { name: 'stats', arguments: '{}' } }] } }] },
      { model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { model: 'mock-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } } },
    ]
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
    server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 按任意字节边界切开，验证跨块的行能正确拼接
      const bytes = Buffer.from(body)
      for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await new Promise((r) => setImmediate(r)) }
      res.end()
    })
    const deltas: string[] = []
    const result = await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }], { onDelta: (text) => deltas.push(text) })

    const request = server.requests[0]!.body as Record<string, unknown>
    assert.equal(request.stream, true)
    assert.deepEqual(request.stream_options, { include_usage: true })
    assert.deepEqual(deltas, ['你', '好，'])
    assert.equal(result.message.content, '你好，')
    assert.deepEqual(result.message.tool_calls, [
      { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":"价格"}' } },
      { id: 'call_b', type: 'function', function: { name: 'stats', arguments: '{}' } },
    ])
    assert.equal(result.finishReason, 'tool_calls')
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4, cached_input_tokens: 8 })
    assert.equal(result.usageReported, true)
    assert.equal(result.model, 'mock-model')
  })

  test('流式响应不带用量时标记为未返回，不当成 0', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    const result = await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    assert.equal(result.message.content, 'ok')
    assert.equal(result.usageReported, false)
  })

  test('流式响应中途返回错误事件时报 LlmError', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ error: { message: 'upstream overloaded' } })}\n\n`)
    })
    await assert.rejects(
      createChatClient({ ...configFor(server.baseUrl), maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }], { onDelta: () => {} }),
      (error: unknown) => error instanceof LlmError && /upstream overloaded/.test(error.message),
    )
  })

  test('不传 onDelta 时请求体不带 stream 字段', async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, completion('ok')))
    await createChatClient(configFor(server.baseUrl)).chat([{ role: 'user', content: 'hi' }])
    const request = server.requests[0]!.body as Record<string, unknown>
    assert.equal('stream' in request, false)
  })
})
