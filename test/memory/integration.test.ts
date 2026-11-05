import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { askDataset } from '../../src/ask/index.ts'
import { createSession } from '../../src/chat/session.ts'
import { searchLearnings } from '../../src/memory/learnings.ts'
import { DEFAULT_PLAYBOOK, initPlaybook, loadPlaybook, proposePlaybook, reviewPlaybook } from '../../src/memory/playbook.ts'
import { estimateSummarize } from '../../src/pipeline/summarize.ts'
import { analyzeDataset } from '../../src/pipeline/analyze.ts'
import { fixtureDataset, makeDataset, makeItem } from '../helpers/dataset.ts'
function sandbox() {
  const cwd = mkdtempSync(join(tmpdir(), 'ugc-rules-'))
  return { memory: { cwd, homeDir: cwd }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

test('回归样本：规则改变进入真实流水线提示词并改变报告；运行中冻结，下一次才重新读取', async () => {
  const { memory, cleanup } = sandbox()
  try {
    const dataset = await fixtureDataset()
    const path = initPlaybook(memory)
    const baseline = loadPlaybook(memory)
    const changed = baseline.text.replace('版本：1', '版本：2').replace('## 共同规则\n', '## 共同规则\n- 优先突出价格争议。\n')
    const run = async (editDuringRun: boolean) => {
      const model = createFakeModel((request, call) => {
        if (editDuringRun && call === 1) writeFileSync(path, changed)
        const title = request.messages[0]?.content?.includes('优先突出价格争议') ? '价格争议' : '主要观点'
        const tool = request.tools[0]!.function.name
        if (tool === 'submit_findings') return { tool_calls: [{ name: tool, args: { findings: [{ direction: 1, title, criteria: '同一观点', refs: [1, 2, 99999], support: 4 }] } }] }
        const total = String(request.messages[1]?.content).split('\n').length
        return { tool_calls: [{ name: tool, args: { themes: [{ direction: 1, title, findings: Array.from({ length: total }, (_, i) => i + 1) }] } }] }
      })
      return { model, result: await analyzeDataset({ model, dataset, memory, cwd: memory.cwd, maxTotalChars: 2000 }) }
    }
    const first = await run(true)
    assert.ok(first.result.plan.chunks.length > 1)
    assert.ok(first.model.requests.every((r) => !r.messages[0]?.content?.includes('优先突出价格争议')))
    assert.deepEqual(first.result.playbook, { version: baseline.version, hash: baseline.hash })
    assert.match(first.result.markdown, /### 1\. 主要观点/)
    assert.match(first.result.markdown, new RegExp(baseline.hash))
    const second = await run(false)
    assert.ok(second.model.requests.every((r) => r.messages[0]?.content?.includes('优先突出价格争议')))
    assert.match(second.result.markdown, /### 1\. 价格争议/)
    assert.equal(second.result.playbook.hash, loadPlaybook(memory).hash)
    assert.deepEqual(second.result.summary.estimate, estimateSummarize({ dataset, plan: second.result.plan, playbook: loadPlaybook(memory) }))
    const records = (await searchLearnings(memory)).entries
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((e) => e.playbook?.hash), [first.result.playbook.hash, second.result.playbook.hash])
    assert.ok(records.every((e) => Number(e.observations.unknown_refs) > 0))
    assert.ok(!JSON.stringify(records).includes('###'))
  } finally { cleanup() }
})

test('ask 追问保持原 system prompt；新对话读取应用后的规则，learnings 不自动注入', async () => {
  const { memory, cleanup } = sandbox()
  try {
    initPlaybook(memory)
    const dataset = makeDataset([makeItem({ id: 'c1', text: '价格太贵' })])
    const model = createFakeModel([{ content: '价格高 [c1] [missing]' }, { content: '接着说 [c1]' }, { content: '新对话 [c1]' }])
    const first = await askDataset({ model, datasets: [dataset], question: '完整的私人问题不会保存', memory })
    const p = proposePlaybook(memory, { operation: 'add', section: 'ask', text: '- 先说明适用范围。' })
    reviewPlaybook(memory, p.id, true)
    const second = await askDataset({ model, datasets: [dataset], question: '继续', history: first.run.messages, memory })
    await askDataset({ model, datasets: [dataset], question: '新问题', memory })
    assert.deepEqual(model.requests[0]?.messages[0], model.requests[1]?.messages[0])
    assert.deepEqual(first.playbook, second.playbook)
    assert.match(model.requests[2]?.messages[0]?.content ?? '', /先说明适用范围/)
    assert.doesNotMatch(model.requests[2]?.messages[0]?.content ?? '', /完整的私人问题|invalid_citations/)
    assert.ok(model.requests[0]?.tools.some((t) => t.function.name === 'search_learnings'))
    const saved = readFileSync(join(memory.cwd, '.ugc-lens', 'learnings.md'), 'utf8')
    assert.doesNotMatch(saved, /完整的私人问题|价格高/)
    const records = (await searchLearnings(memory)).entries
    assert.equal(records[0]?.observations.invalid_citations, 1)
  } finally { cleanup() }
})

test('持续对话冻结规则；模型只能提出待审修改，工具错误后仍能继续', async () => {
  const { memory, cleanup } = sandbox()
  try {
    const path = initPlaybook(memory)
    const model = createFakeModel([
      { tool_calls: [{ name: 'playbook_update', args: { operation: 'patch', section: 'ask', match: '不存在', text: '新规则' } }] },
      { content: '定位失败' },
      { tool_calls: [{ name: 'playbook_update', args: { operation: 'add', section: 'ask', text: '- 回答先列证据。' } }] },
      { content: '已提出待审修改' },
    ])
    const session = createSession({ model, memory, cwd: memory.cwd })
    try {
      await session.ask('改规则')
      writeFileSync(path, DEFAULT_PLAYBOOK.text.replace('使用中文', '使用简体中文'))
      await session.ask('提出建议')
      assert.ok(model.requests[1]?.messages.some((m) => m.role === 'tool' && m.content?.includes('恰好匹配一次')))
      assert.ok(model.requests.every((r) => r.messages[0]?.content === model.requests[0]?.messages[0]?.content))
      assert.doesNotMatch(loadPlaybook(memory).text, /回答先列证据/)
      assert.ok(!model.requests[0]?.tools.some((t) => t.function.name === 'playbook_apply'))
    } finally { await session.close() }
  } finally { cleanup() }
})

test('记录失败时保留问答结果；代码 API 默认不读项目规则且不写经验', async () => {
  const { memory, cleanup } = sandbox()
  try {
    writeFileSync(join(memory.cwd, '.ugc-lens'), 'blocked')
    const dataset = makeDataset([makeItem({ id: 'c1', text: '测试' })])
    const model = createFakeModel([{ content: '结果 [c1]' }, { content: '仍有结果 [c1]' }])
    const direct = await askDataset({ model, datasets: [dataset], question: 'q' })
    assert.equal(direct.memory_warning, undefined)
    assert.ok(!model.requests[0]?.tools.some((t) => t.function.name === 'record_learning'))
    // 用显式快照隔离“规则读取失败”和“经验写入失败”两个不同阶段。
    const enabled = await askDataset({ model, datasets: [dataset], question: 'q', memory, playbook: DEFAULT_PLAYBOOK })
    assert.equal(enabled.answer, '仍有结果 [c1]')
    assert.match(enabled.memory_warning!, /记录失败/)
  } finally { cleanup() }
})

test('分析结果和已保存报告不会被经验写入失败吞掉', async () => {
  const { memory, cleanup } = sandbox()
  try {
    const dataset = await fixtureDataset()
    writeFileSync(join(memory.cwd, '.ugc-lens'), 'blocked')
    const model = createFakeModel((request) => ({ tool_calls: [{ name: request.tools[0]!.function.name, args: { findings: [] } }] }))
    const result = await analyzeDataset({ model, dataset, memory, playbook: DEFAULT_PLAYBOOK, outDir: join(memory.cwd, 'reports') })
    assert.match(result.memory_warning!, /记录失败/)
    assert.equal(readFileSync(result.path!, 'utf8'), result.markdown)
    assert.match(result.markdown, /分析手册/)
  } finally { cleanup() }
})

test('被取消的问答不追加经验；历史本身保持原样', async () => {
  const { memory, cleanup } = sandbox()
  try {
    const dataset = makeDataset([makeItem({ id: 'c1', text: '测试' })])
    const controller = new AbortController()
    controller.abort()
    const model = createFakeModel([])
    const result = await askDataset({ model, datasets: [dataset], question: 'q', memory, signal: controller.signal })
    assert.equal(result.run.stop_reason, 'aborted')
    assert.deepEqual((await searchLearnings(memory)).entries, [])
  } finally { cleanup() }
})

test('固定回归集：评论、回复和弹幕都使用相同的可替换规则，证据仍通过代码校验', async () => {
  const { playbookCases } = await import('../helpers/playbook_cases.ts')
  const { parsePlaybook } = await import('../../src/memory/playbook.ts')
  const changed = parsePlaybook(DEFAULT_PLAYBOOK.text.replace('## 分块总结\n', '## 分块总结\n- 优先突出价格争议。\n'))
  for (const dataset of playbookCases) {
    const reports = []
    for (const playbook of [DEFAULT_PLAYBOOK, changed]) {
      const model = createFakeModel((request) => ({ tool_calls: [{ name: 'submit_findings', args: { findings: [{
        direction: 1, title: request.messages[0]?.content?.includes('优先突出价格争议') ? '价格争议' : '综合反馈', criteria: '提到价格', refs: [1, 2], support: 2,
      }] } }] }))
      const result = await analyzeDataset({ model, dataset, playbook, outDir: false })
      assert.equal(result.summary.chunks.filter((c) => c.status === 'failed').length, 0, dataset.id)
      assert.ok(result.themes[0]?.refs.every((ref) => dataset.items.some((item) => item.id === ref.id)), dataset.id)
      reports.push(result.markdown)
    }
    assert.match(reports[0]!, /### 1\. 综合反馈/, dataset.id)
    assert.match(reports[1]!, /### 1\. 价格争议/, dataset.id)
  }
})
