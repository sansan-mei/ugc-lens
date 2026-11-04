import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createLlmModel } from '../../src/agent/llm_model.ts'
import { runAgent } from '../../src/agent/loop.ts'
import { createChatClient } from '../../src/llm/client.ts'
import type { ChatMessage } from '../../src/llm/types.ts'
import type { AgentTool } from '../../src/tools/types.ts'
import { completion, sendJson, startMockServer } from '../helpers/mock_server.ts'

let server: Awaited<ReturnType<typeof startMockServer>> | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const echo: AgentTool = {
  name: 'echo',
  description: '原样返回',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => `echo:${String(args.text)}`,
}

test('真实客户端接入 Agent 循环：工具定义、tool_calls 和工具结果在请求中正确往返', async () => {
  server = await startMockServer((req, res) => {
    const body = req.body as { messages: ChatMessage[] }
    if (body.messages.some((m) => m.role === 'tool')) return sendJson(res, 200, completion('最终回答'))
    sendJson(res, 200, {
      model: 'mock-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } },
              { id: 'c2', type: 'function', function: { name: 'echo', arguments: '{"text":"b"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  })
  const client = createChatClient({ provider: 'custom', model: 'm', baseUrl: server.baseUrl, timeoutMs: 5_000 })

  const result = await runAgent({
    model: createLlmModel(client, { temperature: 0 }),
    messages: [{ role: 'user', content: 'q' }],
    tools: [echo],
  })

  assert.equal(result.stop_reason, 'completed')
  assert.equal(result.answer, '最终回答')
  assert.equal(server.requests.length, 2)

  const first = server.requests[0]?.body as Record<string, unknown>
  assert.equal(first.temperature, 0)
  assert.equal(first.tool_choice, 'auto')
  assert.deepEqual((first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), ['echo'])

  // 第二次请求：assistant 的 tool_calls 原样带回，后面紧跟两条对应 ID 的 tool 消息
  const second = (server.requests[1]?.body as { messages: ChatMessage[] }).messages
  const assistant = second[1]
  assert.equal(assistant?.role, 'assistant')
  assert.deepEqual(assistant?.role === 'assistant' && assistant.tool_calls?.map((c) => c.id), ['c1', 'c2'])
  assert.deepEqual(
    second.slice(2).map((m) => (m.role === 'tool' ? [m.tool_call_id, m.content] : m.role)),
    [
      ['c1', 'echo:a'],
      ['c2', 'echo:b'],
    ],
  )
})
