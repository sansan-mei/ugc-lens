import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { createFakeModel, type FakeReply } from '../../src/agent/fake_model.ts'
import type { AgentModel, AgentModelRequest } from '../../src/agent/model.ts'
import type { FeedbackItem } from '../../src/dataset/types.ts'
import { planChunks, type Chunk } from '../../src/pipeline/chunk.ts'
import { DEFAULT_DIRECTIONS, estimateSummarize, parseFindings, summarizeChunks } from '../../src/pipeline/summarize.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const LONG = '这个价格真的劝退，同样的配置别家便宜三百块，售后还要自己寄回去等两周，体验很差，下次不会再买了，大家慎重考虑一下吧，不然后悔都来不及，真心建议多比较'

function comments(n: number): FeedbackItem[] {
  return Array.from({ length: n }, (_, i) => makeItem({ id: `id${1000 + i}`, text: `第${i}条评论，内容编号${i * 7919}`, likes: n - i }))
}

function chunkIndex(request: AgentModelRequest): number {
  const user = request.messages.find((m) => m.role === 'user')?.content ?? ''
  return Number(user.match(/^第 (\d+)\//)?.[1]) - 1
}

function submit(findings: unknown[]): FakeReply {
  return { tool_calls: [{ name: 'submit_findings', args: { findings } }] }
}

const finding = (refs: unknown[], extra: Record<string, unknown> = {}) => ({
  direction: 1, title: '结论', criteria: '标准', refs, support: 3, ...extra,
})

describe('parseFindings', () => {
  const dataset = makeDataset([makeItem({ id: 'a', text: LONG }), makeItem({ id: 'b', text: '太贵了，不值' }), makeItem({ id: 'c', text: '还行' , likes: 1 })])
  const chunk: Chunk = { index: 0, kind: 'threads', lines: [], ids: ['a', 'b', 'c'], chars: 0, represents: 3 }
  const parse = (findings: unknown[], max = 8) => parseFindings({ findings }, chunk, dataset, DEFAULT_DIRECTIONS, max)

  test('编号换回原 ID：去重，接受 "2" 和 "[3]"，块外编号丢掉，超过 5 个截断', () => {
    const { findings, dropped } = parse([finding([1, 1, '2', '[3]', 9, 0])])
    assert.deepEqual(findings[0]?.refs.map((r) => r.id), ['a', 'b', 'c'])
    assert.equal(dropped.unknown_ref, 2)
    const many = { ...chunk, ids: ['a', 'b', 'c', 'a2', 'a3', 'a4', 'a5'] }
    const result = parseFindings({ findings: [finding([1, 2, 3, 4, 5, 6, 7])] }, many, dataset, DEFAULT_DIRECTIONS, 8)
    assert.equal(result.findings[0]?.refs.length, 5)
    assert.equal(result.dropped.over_limit, 2)
  })

  test('摘句必须是原文子串（忽略空白）且对应的编号在 refs 里', () => {
    const quotes = [
      { ref: 1, text: '同样的配置 别家便宜三百块' },
      { ref: 1, text: '编造的摘句' },
      { ref: 2, text: '太贵了' },
      { ref: 3, text: '还行' },
    ]
    const { findings, dropped } = parse([finding([1, 2], { quotes })])
    assert.equal(findings[0]?.refs[0]?.quote, '同样的配置 别家便宜三百块')
    assert.equal(findings[0]?.refs[1]?.quote, '太贵了')
    assert.equal(dropped.bad_quote, 2)
  })

  test('方向编号不存在、缺字段的观点丢掉；引用全不合格的丢掉；超过条数上限的丢掉', () => {
    const { findings, dropped } = parse(
      [finding([1], { direction: 9 }), finding([1], { title: '' }), finding([7]), finding([1]), finding([2]), finding([3])],
      2,
    )
    assert.equal(findings.length, 2)
    assert.deepEqual(dropped, { invalid_finding: 2, unknown_ref: 1, bad_quote: 0, no_valid_refs: 1, over_limit: 1 })
    assert.equal(findings[0]?.direction, DEFAULT_DIRECTIONS[0])
  })

  test('支持条数不少于有效引用数；没有 findings 数组时报错', () => {
    assert.equal(parse([finding([1, 2], { support: 0 })]).findings[0]?.support, 2)
    assert.throws(() => parseFindings({}, chunk, dataset, DEFAULT_DIRECTIONS, 8), /findings/)
  })
})

describe('summarizeChunks', () => {
  const dataset = makeDataset(comments(40))
  const plan = planChunks(dataset, { maxChunkChars: 300 })

  test('每块调用一次，指定 submit_findings；各块 system prompt 相同，user 消息是块内容', async () => {
    assert.ok(plan.chunks.length >= 3)
    const model = createFakeModel(() => submit([finding([1, 2])]))
    const result = await summarizeChunks({ model, dataset, plan })

    assert.equal(model.requests.length, plan.chunks.length)
    assert.equal(result.calls, plan.chunks.length)
    assert.equal(new Set(model.requests.map((r) => r.messages[0]?.content)).size, 1)
    for (const request of model.requests) {
      assert.deepEqual(request.toolChoice, { type: 'function', function: { name: 'submit_findings' } })
      assert.deepEqual(request.tools.map((t) => t.function.name), ['submit_findings'])
      assert.equal(request.messages.length, 2)
    }
    for (const [i, chunk] of plan.chunks.entries()) {
      const user = model.requests.map((r) => String(r.messages[1]?.content)).find((c) => c.startsWith(`第 ${i + 1}/`))
      assert.ok(user?.endsWith(chunk.lines.join('\n')))
    }
    assert.deepEqual(result.chunks.map((c) => c.chunk), plan.chunks.map((c) => c.index))
    for (const f of result.findings) assert.deepEqual(f.refs.map((r) => r.id), plan.chunks[f.chunk]!.ids.slice(0, 2))
    assert.equal(result.usage.input_tokens, result.chunks.reduce((s, c) => s + (c.usage?.input_tokens ?? 0), 0))
    // 假模型不返回缓存字段：汇总不能报成命中 0
    assert.equal(result.usage.cached_input_tokens, undefined)
    assert.equal(result.usage.cached_unreported_calls, result.calls)
  })

  test('提示词里没有原 ID；传入方向时只用这些方向', async () => {
    const model = createFakeModel(() => submit([finding([1], { direction: 2 })]))
    const result = await summarizeChunks({ model, dataset, plan, directions: ['价格', '售后'] })
    const sent = JSON.stringify(model.requests.map((r) => r.messages))
    assert.ok(!sent.includes('id1000'))
    assert.match(String(model.requests[0]!.messages[0]!.content), /1\. 价格\n2\. 售后/)
    assert.ok(result.findings.every((f) => f.direction === '售后'))
  })

  test('一块失败不影响其他块：格式错误、没有调用工具都记为失败', async () => {
    const model: AgentModel = {
      async complete(request) {
        const i = chunkIndex(request)
        const fake = createFakeModel([
          i === 0 ? { tool_calls: [{ name: 'submit_findings', raw_arguments: '{"findings": [' }] } : submit([finding([1])]),
        ])
        if (i === 1) throw new Error('网络错误（已重试 3 次）')
        return fake.complete(request)
      },
    }
    const result = await summarizeChunks({ model, dataset, plan })
    assert.equal(result.chunks[0]?.status, 'failed')
    assert.match(result.chunks[0]?.error ?? '', /JSON/)
    assert.match(result.chunks[1]?.error ?? '', /网络错误/)
    assert.ok(result.chunks.slice(2).every((c) => c.status === 'ok'))
    assert.equal(result.findings.length, plan.chunks.length - 2)
  })

  test('提供商拒绝指定工具的 tool_choice 时，改用 auto 重发，之后的块直接用 auto', async () => {
    const choices: unknown[] = []
    const model: AgentModel = {
      async complete(request) {
        choices.push(request.toolChoice)
        if (typeof request.toolChoice === 'object') {
          throw Object.assign(new Error('HTTP 400: Thinking mode does not support this tool_choice'), { status: 400 })
        }
        return createFakeModel([submit([finding([1])])]).complete(request)
      },
    }
    const result = await summarizeChunks({ model, dataset, plan, concurrency: 1 })
    assert.ok(result.chunks.every((c) => c.status === 'ok'))
    assert.equal(choices.filter((c) => typeof c === 'object').length, 1)
    assert.equal(choices.length, plan.chunks.length + 1)
  })

  test('同时进行的调用不超过 concurrency', async () => {
    let active = 0
    let peak = 0
    const model: AgentModel = {
      async complete(request) {
        active++
        peak = Math.max(peak, active)
        await sleep(5)
        active--
        return createFakeModel([submit([])]).complete(request)
      },
    }
    const done: number[] = []
    await summarizeChunks({ model, dataset, plan, concurrency: 2, onChunk: (s) => done.push(s.chunk) })
    assert.equal(peak, 2)
    assert.equal(done.length, plan.chunks.length)
  })

  test('已用 token 达到预算后，剩下的块跳过；取消后也跳过', async () => {
    const model = createFakeModel(() => submit([]))
    const result = await summarizeChunks({ model, dataset, plan, concurrency: 1, tokenBudget: 1 })
    assert.equal(result.calls, 1)
    assert.ok(result.chunks.slice(1).every((c) => c.status === 'skipped' && /预算/.test(c.error ?? '')))

    const controller = new AbortController()
    controller.abort()
    const cancelled = await summarizeChunks({ model, dataset, plan, signal: controller.signal })
    assert.equal(cancelled.calls, 0)
    assert.ok(cancelled.chunks.every((c) => c.status === 'skipped'))
  })
})

test('estimateSummarize：每块一次调用，内容越多估算的输入越多', () => {
  const small = makeDataset(comments(10))
  const large = makeDataset(comments(200))
  const a = estimateSummarize({ dataset: small, plan: planChunks(small) })
  const b = estimateSummarize({ dataset: large, plan: planChunks(large) })
  assert.equal(a.calls, planChunks(small).chunks.length)
  assert.ok(b.input_tokens > a.input_tokens)
  assert.ok(a.output_tokens > 0)
})
