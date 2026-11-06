import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import type { FakeReply } from '../../src/agent/fake_model.ts'
import type { Usage } from '../../src/llm/types.ts'
import { runAgent } from '../../src/agent/loop.ts'
import { completeTracked, currentTask, withTask } from '../../src/agent/usage.ts'
import { defineTool } from '../../src/tools/define.ts'
import * as z from 'zod'

function metered(replies: Array<FakeReply & { usage: Usage }>) {
  const model = createFakeModel(replies)
  let i = 0
  return { requests: model.requests, async complete(req: Parameters<typeof model.complete>[0]) { const result = await model.complete(req); return { ...result, usage: replies[i++]!.usage } } }
}

const request = { messages: [{ role: 'user' as const, content: '测试' }], tools: [], toolChoice: 'auto' as const, signal: new AbortController().signal }

test('内层用量计入任务预算，仅允许一次明确标注的收尾超支', async () => {
  const inner = metered([{ content: '内层完成', usage: { input_tokens: 80, output_tokens: 30 } }])
  const outer = metered([{ tool_calls: [{ name: 'inner', args: {} }], usage: { input_tokens: 1, output_tokens: 1 } }, { content: '预算收尾', usage: { input_tokens: 2, output_tokens: 2 } }])
  const tool = defineTool({ name: 'inner', description: '内部分析', parameters: z.object({}), async execute() { await completeTracked(inner, request, 'analysis'); return '完成' } })
  const result = await runAgent({ model: outer, messages: request.messages, tools: [tool], limits: { tokenBudget: 100 } })
  assert.equal(result.stop_reason, 'token_budget')
  assert.equal(outer.requests.at(-1)?.toolChoice, 'none')
  assert.equal(result.task_usage.known_tokens, 116)
  assert.equal(result.task_usage.calls.length, 3)
  assert.equal(result.task_usage.calls.filter((c) => c.final).length, 1)
})

test('共享账本在失败、未知用量、取消与并发任务中隔离并保留已知数', async () => {
  const one = withTask(async () => {
    await completeTracked(metered([{ content: 'ok', usage: { input_tokens: 4, output_tokens: 3 } }]), request, 'import')
    await assert.rejects(completeTracked({ async complete() { throw new Error('模拟失败') } }, request, 'analysis'), /模拟失败/)
    const snapshot = currentTask()!.snapshot()
    assert.equal(snapshot.known_tokens, 7)
    assert.equal(snapshot.unknown_calls, 1)
    assert.equal(snapshot.calls.length, 2)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(completeTracked(createFakeModel([]), { ...request, signal: controller.signal }, 'cancelled'))
    assert.equal(currentTask()!.snapshot().calls.length, 2)
    return snapshot.task_id
  })
  const two = withTask(async () => {
    assert.equal(currentTask()!.snapshot().known_tokens, 0)
    return currentTask()!.snapshot().task_id
  })
  const ids = await Promise.all([one, two]); assert.notEqual(ids[0], ids[1])
})

test('未知响应保留未知状态，估算单独累计；触顶后拒绝新调用', async () => {
  await withTask(async () => {
    const result = { message: { role: 'assistant' as const, content: '未知用量' }, finishReason: 'stop', model: 'mock', usage: { input_tokens: 0, output_tokens: 0 }, usageReported: false }
    await completeTracked({ async complete() { return result } }, request, 'unknown')
    const snapshot = currentTask()!.snapshot()
    assert.equal(snapshot.known_tokens, 0)
    assert.equal(snapshot.unknown_calls, 1)
    assert.equal(snapshot.calls[0]?.input_tokens, null)
    assert.ok(snapshot.unknown_estimated_tokens > 0)
    let called = false
    await assert.rejects(completeTracked({ async complete() { called = true; return result } }, request, 'blocked'), /预算/)
    assert.equal(called, false)
  }, 1)
})

test('并发在途调用全部记账，触顶后不启动新的请求', async () => {
  await withTask(async () => {
    const pending: Array<() => void> = []
    const model = { async complete() { await new Promise<void>((resolve) => pending.push(resolve)); return { message: { role: 'assistant' as const, content: 'ok' }, finishReason: 'stop', model: 'mock', usage: { input_tokens: 5, output_tokens: 2 } } } }
    const first = completeTracked(model, request, 'parallel')
    const second = completeTracked(model, request, 'parallel')
    assert.equal(currentTask()!.snapshot().calls.length, 2)
    pending.forEach((finish) => finish())
    await Promise.all([first, second])
    const usage = currentTask()!.snapshot()
    assert.equal(usage.known_tokens, usage.calls.reduce((n, c) => n + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0))
    await assert.rejects(completeTracked(model, request, 'blocked'), /预算/)
  }, 5)
})

test('重试触顶只记录实际失败尝试，不虚增未启动的下一次请求', async () => {
  await withTask(async () => {
    const model = { async complete(req: typeof request & { onRetry?: Parameters<import('../../src/agent/model.ts').AgentModel['complete']>[0]['onRetry'] }) {
      req.onRetry?.({ attempt: 1, delayMs: 0, error: Object.assign(new Error('模拟失败'), { retryable: true }) })
      throw new Error('不应进入重试')
    } }
    await assert.rejects(completeTracked(model, request, 'retry'), /预算/)
    const usage = currentTask()!.snapshot()
    assert.equal(usage.calls.length, 1)
    assert.equal(usage.unknown_calls, 1)
    assert.equal(usage.calls[0]?.status, 'failed')
  }, 1)
})

test('真实 HTTP 客户端缺失 usage 时保留未知，不能冒充免费调用', async () => {
  const { startMockServer, sendJson, completion } = await import('../helpers/mock_server.ts')
  const { createChatClient } = await import('../../src/llm/client.ts')
  const { createLlmModel } = await import('../../src/agent/llm_model.ts')
  const server = await startMockServer((_req, response) => {
    const { usage: _unused, ...body } = completion('没有用量字段')
    sendJson(response, 200, body)
  })
  try {
    await withTask(async () => {
      const model = createLlmModel(createChatClient({ provider: 'custom', model: 'mock', baseUrl: server.baseUrl, timeoutMs: 1000, maxRetries: 0 }))
      await completeTracked(model, request, 'http')
      const usage = currentTask()!.snapshot()
      assert.equal(usage.unknown_calls, server.requests.length)
      assert.equal(usage.calls[0]?.input_tokens, null)
      assert.ok(usage.unknown_estimated_tokens > 0)
    })
  } finally { await server.close() }
})

test('异常退出对调用方保留已知账本', async () => {
  await assert.rejects(withTask(async () => {
    await completeTracked(metered([{ content: '已完成', usage: { input_tokens: 2, output_tokens: 3 } }]), request, 'known')
    throw new Error('后续取消或失败')
  }), (error: unknown) => {
    const snapshot = (error as { task_usage: ReturnType<NonNullable<ReturnType<typeof currentTask>>['snapshot']> }).task_usage
    assert.ok(snapshot.known_tokens > 0)
    assert.equal(snapshot.calls.length, 1)
    return true
  })
})
