import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeModel, type FakeReply } from '../../src/agent/fake_model.ts'
import type { AgentModelRequest } from '../../src/agent/model.ts'
import { analyzeDataset, type AnalyzeProgress } from '../../src/pipeline/analyze.ts'
import { fixtureDataset } from '../helpers/dataset.ts'
import { loadScenario } from '../../src/analysis/scenarios.ts'

function script(request: AgentModelRequest): FakeReply {
  const tool = request.tools[0]!.function.name
  if (tool === 'submit_insights') {
    const payload = JSON.parse(String(request.messages[1]?.content)) as { evidence: { id: string; text: string }[] }
    const ref = payload.evidence[0]!
    return { tool_calls: [{ name: tool, args: { insights: [{ finding: '展示证据中的受众反馈', evidence: [{ point: '原文线索', refs: [{ id: ref.id, quote: ref.text.slice(0, 40) }] }], counterevidence: [], boundary: '仅基于候选证据', meaning: '需要区分评价对象', verify: '核对其他反馈' }] } }] }
  }
  if (tool === 'submit_findings') {
    return { tool_calls: [{ name: tool, args: { findings: [{ direction: 1, title: '大家在聊视频', criteria: '提到视频内容', refs: [1, 2], support: 4 }] } }] }
  }
  const count = String(request.messages[1]?.content).split('\n').length
  const all = Array.from({ length: count }, (_, i) => i + 1)
  return { tool_calls: [{ name: tool, args: { themes: [{ direction: 1, title: '合并后的主题', findings: all }] } }] }
}

test('analyzeDataset：总结每块一次、合并和综合各一次，报告保存到 outDir，用量相加', async () => {
  const dataset = await fixtureDataset()
  const dir = await mkdtemp(join(tmpdir(), 'ugc-analyze-'))
  try {
    const model = createFakeModel(script)
    const events: AnalyzeProgress[] = []
    const result = await analyzeDataset({
      model,
      dataset,
      outDir: dir,
      maxTotalChars: 2_000,
      modelName: 'fake',
      now: () => new Date(2026, 10, 5, 9, 8, 7),
      onProgress: (e) => events.push(e),
    })

    const chunks = result.plan.chunks.length
    assert.ok(chunks >= 2, '样本需要分成多块才会调用合并')
    assert.equal(model.requests.length, chunks + 2)
    assert.equal(result.calls, chunks + 2)
    assert.equal(result.merge.called, true)
    assert.equal(result.insights.insights.length, 1)
    assert.equal(result.task_usage.calls.filter((c) => c.stage === 'insights').length, 1)
    assert.equal(result.usage.input_tokens, result.summary.usage.input_tokens + result.merge.usage!.input_tokens + result.insights.usage!.input_tokens)

    assert.deepEqual(events.map((e) => e.type), ['planned', ...Array(chunks).fill('chunk'), 'merged'])
    assert.equal(result.themes.length, 1)
    assert.equal(result.themes[0]?.support, 4 * chunks)

    assert.equal(result.path, join(dir, `${dataset.id}-20261105-090807.md`))
    assert.equal(await readFile(result.path!, 'utf8'), result.markdown)
    assert.match(result.markdown, /### 发现 1：展示证据中的受众反馈/)
    assert.ok(!result.markdown.includes('合并后的主题'))
    assert.match(result.markdown, new RegExp(`调用模型 ${chunks + 2} 次`))
    assert.match(result.markdown, /缓存命中 未知/)
    assert.equal(result.usage.cached_unreported_calls, chunks + 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('analyzeDataset：outDir 为 false 时不保存；传入关注点时只分析这些方向', async () => {
  const dataset = await fixtureDataset()
  const dir = await mkdtemp(join(tmpdir(), 'ugc-analyze-'))
  try {
    const model = createFakeModel(script)
    const result = await analyzeDataset({ model, dataset, outDir: false, cwd: dir, directions: ['价格'] })
    assert.equal(result.path, undefined)
    assert.deepEqual(await readdir(dir), [])
    assert.ok(result.themes.every((t) => t.direction === '价格'))
    assert.match(result.markdown, /分析方向：价格/)
    assert.ok(!result.markdown.includes('## 主要观点'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function recheckScript(request: AgentModelRequest): FakeReply {
  const tool = request.tools[0]!.function.name
  if (tool === 'submit_insights') {
    const reply = script(request)
    const args = reply.tool_calls![0]!.args as { insights: Record<string, unknown>[] }
    args.insights[0]!.recheck_queries = ['的']
    return reply
  }
  if (tool === 'submit_recheck') {
    const payload = JSON.parse(String(request.messages[1]?.content)) as { findings: { finding: number; candidates: { id: string; text: string }[] }[] }
    const first = payload.findings[0]!.candidates[0]!
    return { tool_calls: [{ name: tool, args: { results: [{ finding: 1, id: first.id, verdict: 'contradicts', quote: first.text.slice(0, 8), note: '相反说法' }] } }] }
  }
  return script(request)
}

test('analyzeDataset：场景手册的方向和规则进入各阶段提示词，报告标明场景', async () => {
  const dataset = await fixtureDataset()
  const scenario = loadScenario('reputation')
  const model = createFakeModel(recheckScript)
  const result = await analyzeDataset({ model, dataset, outDir: false, scenario: 'reputation' })
  const systems = model.requests.map((r) => String(r.messages[0]?.content))
  const summarize = systems.filter((_, i) => model.requests[i]!.tools[0]!.function.name === 'submit_findings')
  assert.ok(summarize.length > 0)
  for (const system of summarize) {
    assert.ok(system.includes(scenario.rules[0]!))
    assert.ok(system.includes(scenario.directions[0]!))
  }
  assert.ok(systems.some((system, i) => model.requests[i]!.tools[0]!.function.name === 'submit_insights' && system.includes(scenario.rules[0]!)))
  assert.match(result.markdown, /分析场景：危机与口碑/)
  assert.equal(result.scenario?.id, 'reputation')

  const focused = createFakeModel(recheckScript)
  const custom = await analyzeDataset({ model: focused, dataset, outDir: false, scenario: 'reputation', directions: ['价格'] })
  assert.match(custom.markdown, /分析方向：价格/)
  assert.ok(String(focused.requests[0]!.messages[0]!.content).includes(scenario.rules[0]!))
})

test('analyzeDataset：默认补查核心结论，报告列出关键词和反例；关闭后不产生额外调用', async () => {
  const dataset = await fixtureDataset()
  const model = createFakeModel(recheckScript)
  const result = await analyzeDataset({ model, dataset, outDir: false })
  const chunks = result.plan.chunks.length
  assert.equal(result.calls, chunks + 3)
  assert.equal(result.recheck?.called, true)
  const item = result.recheck!.items[0]!
  assert.equal(item.contradicts.length, 1)
  assert.match(result.markdown, /\*\*补查\*\*/)
  assert.match(result.markdown, /「的」/)
  assert.ok(result.markdown.includes(`\`${item.contradicts[0]!.id}\``))
  assert.equal(result.task_usage.calls.filter((c) => c.stage === 'recheck').length, 1)

  const off = createFakeModel(recheckScript)
  const skipped = await analyzeDataset({ model: off, dataset, outDir: false, recheck: false })
  assert.equal(skipped.calls, skipped.plan.chunks.length + 2)
  assert.ok(!off.requests.some((r) => r.tools[0]!.function.name === 'submit_recheck'))
  assert.equal(skipped.recheck, undefined)
})
