import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as z from 'zod'
import { evaluateBatches } from '../../src/analysis/batches.ts'
import { createLlmModel } from '../../src/agent/llm_model.ts'
import { createChatClient } from '../../src/llm/client.ts'
import { makeItem } from '../helpers/dataset.ts'
import { sendJson, startMockServer } from '../helpers/mock_server.ts'

test('分批执行器走真实 fetch，强制调用拒绝后 auto，遗漏和超长分别统计', async () => {
  const server = await startMockServer((request, response) => {
    const body = request.body as { tool_choice: unknown; messages: { content: string }[] }
    if (body.tool_choice !== 'auto') { sendJson(response, 400, { error: 'tool_choice unsupported' }); return }
    const rows = JSON.parse(body.messages[1]!.content) as { id: string }[]
    sendJson(response, 200, { model: 'mock', choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_evaluations', arguments: JSON.stringify({ rows: [{ id: rows[0]!.id, label: 'yes' }] }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
  })
  try {
    const client = createChatClient({ provider: 'custom', baseUrl: server.baseUrl, model: 'mock', timeoutMs: 1000 }, { retry: { maxRetries: 0 } })
    const result = await evaluateBatches({ model: createLlmModel(client), system: '分类', row: z.object({ id: z.string(), label: z.string() }), maxChars: 500, items: [makeItem({ id: 'a', text: 'a' }), makeItem({ id: 'b', text: 'b' }), makeItem({ id: 'long', text: '长'.repeat(1000) })] })
    assert.equal(result.counts.processed, 1)
    assert.equal(result.counts.failed, 1)
    assert.equal(result.counts.skipped, 1)
    assert.equal(result.calls, server.requests.length)
    assert.equal(result.usage.input_tokens, 5)
    assert.equal(result.usage.cached_input_tokens, undefined)
  } finally { await server.close() }
})
