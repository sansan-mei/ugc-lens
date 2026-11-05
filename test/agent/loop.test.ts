import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { RunEvent } from '../../src/agent/events.ts'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { finalizeNotice, runAgent } from '../../src/agent/loop.ts'
import type { ChatMessage } from '../../src/llm/types.ts'
import * as z from 'zod'
import { defineTool } from '../../src/tools/define.ts'
import type { AgentTool } from '../../src/tools/types.ts'

const initial: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'question' },
]

const echo: AgentTool = {
  name: 'echo',
  description: '原样返回参数',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => `echo:${String(args.text ?? '')}`,
}

const broken: AgentTool = {
  name: 'broken',
  description: '总是失败',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('boom')
  },
}

/** 每条带 tool_calls 的 assistant 消息后面，必须紧跟对应 ID 的 tool 消息 */
function assertToolPairing(messages: ChatMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || !message.tool_calls) continue
    const following = messages.slice(index + 1, index + 1 + message.tool_calls.length)
    assert.deepEqual(
      following.map((m) => (m.role === 'tool' ? m.tool_call_id : `<${m.role}>`)),
      message.tool_calls.map((c) => c.id),
    )
  }
}

describe('runAgent', () => {
  test('模型不请求工具时直接结束', async () => {
    const model = createFakeModel([{ content: '答案' }])
    const result = await runAgent({ model, messages: initial, tools: [echo] })

    assert.equal(result.stop_reason, 'completed')
    assert.equal(result.answer, '答案')
    assert.equal(result.steps.length, 1)
    assert.equal(model.requests.length, 1)
    assert.equal(model.requests[0]?.toolChoice, 'auto')
    assert.equal(model.requests[0]?.tools[0]?.function.name, 'echo')
  })

  test('执行工具并把结果交回模型，直到模型给出回答', async () => {
    const model = createFakeModel([
      { tool_calls: [{ name: 'echo', args: { text: 'a' } }] },
      { tool_calls: [{ name: 'echo', args: { text: 'b' } }, { name: 'echo', args: { text: 'c' } }] },
      { content: '完成' },
    ])
    const result = await runAgent({ model, messages: initial, tools: [echo] })

    assert.equal(result.stop_reason, 'completed')
    assert.equal(result.answer, '完成')
    assert.deepEqual(
      result.steps.flatMap((s) => s.tool_calls.map((c) => c.result)),
      ['echo:a', 'echo:b', 'echo:c'],
    )
    assertToolPairing(result.messages)
    // 第 3 次调用时，模型能看到前面所有的工具结果
    const lastRequest = model.requests[2]
    assert.ok(lastRequest)
    assert.deepEqual(
      lastRequest.messages.filter((m) => m.role === 'tool').map((m) => m.content),
      ['echo:a', 'echo:b', 'echo:c'],
    )
  })

  test('不修改传入的初始消息', async () => {
    const messages = structuredClone(initial)
    await runAgent({ model: createFakeModel([{ tool_calls: [{ name: 'echo' }] }, { content: 'ok' }]), messages, tools: [echo] })
    assert.deepEqual(messages, initial)
  })

  test('达到 max_steps 后做收尾调用：tool_choice 为 none，说明附加在最后一条工具结果上', async () => {
    const model = createFakeModel((request) =>
      request.toolChoice === 'none' ? { content: '收尾回答' } : { tool_calls: [{ name: 'echo', args: { text: 'x' } }] },
    )
    const result = await runAgent({ model, messages: initial, tools: [echo], limits: { maxSteps: 3 } })

    assert.equal(result.stop_reason, 'max_steps')
    assert.equal(result.answer, '收尾回答')
    assert.equal(result.steps.filter((s) => !s.final).length, 3)
    assert.equal(result.steps.at(-1)?.final, true)

    const finalRequest = model.requests.at(-1)
    assert.ok(finalRequest)
    assert.equal(finalRequest.toolChoice, 'none')
    assert.equal(finalRequest.tools.length, 1, '收尾调用仍要带工具定义')
    const lastSent = finalRequest.messages.at(-1)
    assert.equal(lastSent?.role, 'tool')
    assert.ok(lastSent?.content?.endsWith(finalizeNotice('max_steps')))

    // 不伪造 user 消息，system prompt 不变
    assert.equal(result.messages.filter((m) => m.role === 'user').length, 1)
    for (const request of model.requests) assert.deepEqual(request.messages[0], initial[0])
    assertToolPairing(result.messages)
  })

  test('收尾说明只附加在还没发出的消息上，已发出的历史不被修改', async () => {
    const model = createFakeModel((request) =>
      request.toolChoice === 'none' ? { content: 'end' } : { tool_calls: [{ name: 'echo', args: { text: 'x' } }] },
    )
    await runAgent({ model, messages: initial, tools: [echo], limits: { maxSteps: 2 } })
    const [, second, final] = model.requests
    assert.ok(second && final)
    // 第 2 次请求发出的消息，在收尾请求里应保持原样
    assert.deepEqual(final.messages.slice(0, second.messages.length), second.messages)
  })

  test('工具出错不抛异常，错误作为工具结果交给模型', async () => {
    const model = createFakeModel([{ tool_calls: [{ name: 'broken' }] }, { content: '换个办法' }])
    const result = await runAgent({ model, messages: initial, tools: [broken] })

    assert.equal(result.stop_reason, 'completed')
    const call = result.steps[0]?.tool_calls[0]
    assert.equal(call?.ok, false)
    assert.match(call?.result ?? '', /boom/)
  })

  test('不存在的工具和不合法的参数都返回错误结果', async () => {
    const model = createFakeModel([
      { tool_calls: [{ name: 'missing' }, { name: 'echo', raw_arguments: '{not json' }, { name: 'echo', raw_arguments: '[1]' }] },
      { content: 'ok' },
    ])
    const result = await runAgent({ model, messages: initial, tools: [echo] })
    const results = result.steps[0]?.tool_calls.map((c) => c.result) ?? []

    assert.match(results[0] ?? '', /不存在名为 "missing" 的工具.*echo/)
    assert.match(results[1] ?? '', /不是合法的 JSON/)
    assert.match(results[2] ?? '', /必须是 JSON 对象/)
    assertToolPairing(result.messages)
  })

  test('连续多步的工具调用全部失败时以 tool_errors 停止', async () => {
    const model = createFakeModel((request) =>
      request.toolChoice === 'none' ? { content: '放弃' } : { tool_calls: [{ name: 'broken' }] },
    )
    const result = await runAgent({ model, messages: initial, tools: [broken], limits: { maxConsecutiveToolErrors: 2 } })

    assert.equal(result.stop_reason, 'tool_errors')
    assert.equal(result.steps.filter((s) => !s.final).length, 2)
    assert.equal(result.answer, '放弃')
  })

  test('有一个工具成功就重新计数', async () => {
    let call = 0
    const model = createFakeModel((request) => {
      call++
      if (request.toolChoice === 'none' || call > 5) return { content: 'done' }
      return { tool_calls: [{ name: call % 2 === 0 ? 'echo' : 'broken' }] }
    })
    const result = await runAgent({ model, messages: initial, tools: [echo, broken], limits: { maxConsecutiveToolErrors: 2 } })
    assert.equal(result.stop_reason, 'completed')
  })

  test('累计 token 达到预算时以 token_budget 停止', async () => {
    const model = createFakeModel((request) =>
      request.toolChoice === 'none' ? { content: '预算用完' } : { tool_calls: [{ name: 'echo' }] },
    )
    const result = await runAgent({ model, messages: initial, tools: [echo], limits: { tokenBudget: 200 } })

    assert.equal(result.stop_reason, 'token_budget')
    assert.equal(result.answer, '预算用完')
    assert.ok(result.usage.input_tokens + result.usage.output_tokens >= 200)
  })

  test('用户取消时以 aborted 停止，不做收尾调用', async () => {
    const controller = new AbortController()
    const model = createFakeModel([{ content: 'never' }], { delayMs: 1_000 })
    setTimeout(() => controller.abort(), 20)

    const result = await runAgent({ model, messages: initial, signal: controller.signal })
    assert.equal(result.stop_reason, 'aborted')
    assert.equal(result.answer, '')
    assert.equal(model.requests.length, 1)
  })

  test('超过 timeoutMs 时以 timeout 停止，不做收尾调用', async () => {
    const model = createFakeModel([{ content: 'never' }], { delayMs: 1_000 })
    const result = await runAgent({ model, messages: initial, limits: { timeoutMs: 30 } })
    assert.equal(result.stop_reason, 'timeout')
    assert.equal(model.requests.length, 1)
  })

  test('模型接口出错且不是取消或超时时，错误向上抛出', async () => {
    const model = { complete: async () => Promise.reject(new Error('HTTP 500')) }
    await assert.rejects(runAgent({ model, messages: initial }), /HTTP 500/)
  })

  test('工具拿到 cwd 和确认函数；没有提供确认函数时一律拒绝', async () => {
    const seen: Array<{ cwd: string; approved: boolean }> = []
    const probe: AgentTool = {
      name: 'probe',
      description: '记录上下文',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        seen.push({ cwd: ctx.cwd, approved: await ctx.approve({ kind: 'run_command', command: 'x', cwd: ctx.cwd }) })
        return 'ok'
      },
    }
    const script = () => createFakeModel([{ tool_calls: [{ name: 'probe' }] }, { content: 'done' }])

    await runAgent({ model: script(), messages: initial, tools: [probe] })
    await runAgent({ model: script(), messages: initial, tools: [probe], cwd: '/work', approve: async () => true })

    assert.deepEqual(seen, [
      { cwd: process.cwd(), approved: false },
      { cwd: '/work', approved: true },
    ])
  })

  test('参数错误和执行失败返回不同的提示，模型能据此修正参数', async () => {
    const strict = defineTool({
      name: 'strict',
      description: '需要整数参数',
      parameters: z.object({ n: z.number().int() }),
      execute: async ({ n }) => `n=${n}`,
    })
    const model = createFakeModel([
      { tool_calls: [{ name: 'strict', args: { n: '3' } }] },
      { tool_calls: [{ name: 'strict', args: { n: 3 } }] },
      { content: 'ok' },
    ])
    const result = await runAgent({ model, messages: initial, tools: [strict, broken] })
    const [first, second] = result.steps.flatMap((s) => s.tool_calls)

    assert.equal(first?.ok, false)
    assert.match(first?.result ?? '', /^错误：工具 strict 的参数不正确。\n- n：.*（收到："3"）/)
    assert.equal(second?.ok, true)
    assert.equal(second?.result, 'n=3')
  })

  test('事件顺序：run_start 开头、run_end 结尾，工具事件成对出现', async () => {
    const events: RunEvent[] = []
    const model = createFakeModel([{ tool_calls: [{ name: 'echo' }, { name: 'missing' }] }, { content: 'ok' }])
    const result = await runAgent({ model, messages: initial, tools: [echo], onEvent: (e) => events.push(e) })

    assert.deepEqual(
      events.map((e) => e.type),
      ['run_start', 'model_start', 'model_end', 'tool_start', 'tool_end', 'tool_start', 'tool_end', 'model_start', 'model_end', 'run_end'],
    )
    assert.ok(events.every((e) => e.run_id === result.run_id))
    const toolEnds = events.filter((e) => e.type === 'tool_end')
    assert.deepEqual(toolEnds.map((e) => e.ok), [true, false])
    const end = events.at(-1)
    assert.equal(end?.type === 'run_end' && end.stop_reason, 'completed')
  })
})

describe('createFakeModel', () => {
  test('剧本用完时报错', async () => {
    const model = createFakeModel([])
    await assert.rejects(runAgent({ model, messages: initial }), /剧本已用完/)
  })

  test('tool_choice 为 none 时返回工具调用视为剧本错误', async () => {
    const model = createFakeModel(() => ({ tool_calls: [{ name: 'echo' }] }))
    await assert.rejects(runAgent({ model, messages: initial, tools: [echo], limits: { maxSteps: 1 } }), /剧本错误/)
  })
})
