import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { ConfigError, globalConfigPath } from '../../src/config.ts'
import { loadDataset } from '../../src/ingest/index.ts'
import { createAnalysisRunner, describeAnalysisSettings, parseAnalysisSettings, saveAnalysisSettings } from '../../src/ui/analysis.ts'
import { HttpError } from '../../src/ui/http.ts'
import { createUiServer } from '../../src/ui/server.ts'
import { isolateEnv } from '../helpers/env.ts'
import { BV_FIXTURE } from '../helpers/fixtures.ts'

const env = isolateEnv()
const home = env.home
const cwd = join(env.dir, 'project')
mkdirSync(join(cwd, 'data'), { recursive: true })
mkdirSync(join(home, '.ugc-lens'), { recursive: true })
copyFileSync(BV_FIXTURE, join(cwd, 'data', 'bilibili_all.json'))
after(() => env.restore())
beforeEach(() => writeFileSync(globalConfigPath(home), JSON.stringify({ llm: { provider: 'deepseek', model: 'm' } })))

/** 情感评分的假模型：按请求里的 ID 逐条给分，记录调用次数 */
function scorer() {
  let calls = 0
  const model = createFakeModel((request) => {
    calls++
    const rows = JSON.parse(String(request.messages.at(-1)!.content)) as Array<{ id: string }>
    return { tool_calls: [{ name: 'submit_sentiment', args: { scores: rows.map((r, i) => ({ id: r.id, score: i % 2 ? 0.8 : -0.6, reason: '依据' })) } }] }
  })
  return { model: model as AgentModel, calls: () => calls }
}

test('分析设置：默认开启；保存到全局配置 ui 字段，保留模型配置；明确关闭后保持关闭；预算必须在范围内', () => {
  assert.deepEqual(describeAnalysisSettings(home), { auto_sentiment: true, auto_topics: true, token_budget: 30_000 })
  saveAnalysisSettings(parseAnalysisSettings({ auto_sentiment: false, auto_topics: false }), home)
  assert.deepEqual(describeAnalysisSettings(home), { auto_sentiment: false, auto_topics: false, token_budget: 30_000 })
  saveAnalysisSettings(parseAnalysisSettings({ auto_sentiment: true, auto_topics: false, token_budget: 50_000 }), home)
  const file = JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))
  assert.deepEqual(file.llm, { provider: 'deepseek', model: 'm' })
  assert.deepEqual(file.ui, { auto_sentiment: true, auto_topics: false, analysis_token_budget: 50_000 })
  assert.deepEqual(describeAnalysisSettings(home), { auto_sentiment: true, auto_topics: false, token_budget: 50_000 })
  assert.throws(() => parseAnalysisSettings({ token_budget: 0 }), HttpError)
  assert.throws(() => parseAnalysisSettings({ token_budget: 10_000_000 }), HttpError)
})

test('后台情感分析：逐条评分后结果写入启动目录，概况可读到汇总；同一任务不会同时跑两份', async () => {
  const dataset = await loadDataset(join(cwd, 'data', 'bilibili_all.json'), { cacheDir: join(env.dir, 'cache') })
  const s = scorer()
  const runner = createAnalysisRunner({ cwd, homeDir: home, model: () => s.model })
  assert.equal(runner.status(dataset).sentiment.state, 'idle')
  assert.equal(runner.start(dataset, 'sentiment'), 'started')
  assert.equal(runner.start(dataset, 'sentiment'), 'running')
  assert.equal(runner.status(dataset).sentiment.state, 'running')
  await runner.idle()
  assert.equal(runner.status(dataset).sentiment.state, 'done')
  const results = await runner.results(dataset)
  const sentiment = results.find((r) => r.task === 'sentiment')!
  assert.equal(sentiment.source, 'model')
  const summary = sentiment.summary as { summary: { evaluated: number; total: number } }
  assert.ok(summary.summary.total > 0)
  assert.equal(summary.summary.evaluated, summary.summary.total)
  assert.ok(existsSync(join(home, '.ugc-lens', 'ui', 'analysis', dataset.content_digest!, 'sentiment.json')))
  // 已有结果时不再自动重跑，手动开始才会重跑
  const callsAfter = s.calls()
  assert.equal(runner.start(dataset, 'sentiment', { onlyIfMissing: true }), 'exists')
  assert.equal(s.calls(), callsAfter)
  await runner.close()
})

test('后台分析：没有模型配置时状态为错误并给出原因；关闭时取消进行中的分析', async () => {
  const dataset = await loadDataset(join(cwd, 'data', 'bilibili_all.json'), { cacheDir: join(env.dir, 'cache') })
  const runner = createAnalysisRunner({ cwd: join(env.dir, 'other'), homeDir: home, model: () => { throw new ConfigError('没有配置模型') } })
  runner.start(dataset, 'sentiment')
  await runner.idle()
  const status = runner.status(dataset).sentiment
  assert.equal(status.state, 'error')
  assert.match(status.error ?? '', /没有配置模型/)

  let aborted = false
  const slow: AgentModel = { complete: (request) => new Promise((_resolve, reject) => request.signal?.addEventListener('abort', () => { aborted = true; reject(request.signal!.reason) })) }
  const runner2 = createAnalysisRunner({ cwd: join(env.dir, 'other2'), homeDir: home, model: () => slow })
  runner2.start(dataset, 'sentiment')
  await runner2.close()
  assert.equal(aborted, true)
})

test('打开数据：开启自动分析时后台开始，状态接口可查，完成后概况带上结果；未开启时只能手动开始', async () => {
  const s = scorer()
  const ui = createUiServer({ cwd, token: 't', homeDir: home, staticDir: cwd, analysisModel: () => s.model, picker: { available: false, pick: async () => undefined } })
  await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done))
  const port = (ui.server.address() as AddressInfo).port
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, { ...init, headers: { 'x-ugc-lens-token': 't', 'content-type': 'application/json' } })
    return { status: res.status, json: await res.json() as any }
  }
  try {
    // 先关闭自动分析，验证只能手动开始；分析结果按内容复用，所以用一份没分析过的内容
    assert.equal((await call('settings/analysis', { method: 'PUT', body: JSON.stringify({ auto_sentiment: false, auto_topics: false }) })).status, 200)
    writeFileSync(join(cwd, 'data', 'manual.json'), JSON.stringify({ ...JSON.parse(readFileSync(BV_FIXTURE, 'utf8')), manual_marker: 1 }))
    const opened = await call('open', { method: 'POST', body: JSON.stringify({ path: 'data/manual.json' }) })
    assert.equal(opened.status, 200)
    const id = opened.json.id as string
    const idle = await call(`datasets/${id}/analysis`)
    assert.equal(idle.json.sentiment.state, 'idle')
    assert.equal(idle.json.settings.auto_sentiment, false)
    assert.equal(s.calls(), 0)

    const started = await call(`datasets/${id}/analysis/sentiment`, { method: 'POST', body: '{}' })
    assert.equal(started.status, 200)
    assert.match(started.json.sentiment.state, /running|done/)
    await ui.analysis.idle()
    const overview = await call(`datasets/${id}/overview`)
    assert.ok(overview.json.labels.some((l: any) => l.task === 'sentiment' && l.source === 'model'))
    assert.equal((await call(`datasets/${id}/analysis/nope`, { method: 'POST', body: '{}' })).status, 404)

    // 开启自动情感分析后，打开另一份没有结果的数据会自动开始
    const saved = await call('settings/analysis', { method: 'PUT', body: JSON.stringify({ auto_sentiment: true, auto_topics: false }) })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.analysis.auto_sentiment, true)
    copyFileSync(BV_FIXTURE, join(cwd, 'data', 'copy.json'))
    const other = JSON.parse(readFileSync(join(cwd, 'data', 'copy.json'), 'utf8'))
    other.extra_marker = 1
    writeFileSync(join(cwd, 'data', 'copy.json'), JSON.stringify(other))
    const before = s.calls()
    const opened2 = await call('open', { method: 'POST', body: JSON.stringify({ path: 'data/copy.json' }) })
    assert.equal(opened2.status, 200)
    await ui.analysis.idle()
    if (opened2.json.id !== id) assert.ok(s.calls() > before)
    assert.equal((await call(`datasets/${opened2.json.id}/analysis`)).json.sentiment.state, 'done')
  } finally {
    await ui.close()
    ui.server.closeAllConnections()
    await new Promise((done) => ui.server.close(done))
  }
})

test('打开数据：没有设置过时默认自动开始情感分析和主题统计', async () => {
  const s = scorer()
  const ui = createUiServer({ cwd: join(env.dir, 'defaults'), token: 't', homeDir: home, staticDir: cwd, analysisModel: () => s.model, picker: { available: false, pick: async () => undefined } })
  mkdirSync(join(env.dir, 'defaults'), { recursive: true })
  copyFileSync(BV_FIXTURE, join(env.dir, 'defaults', 'bilibili_all.json'))
  await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done))
  const port = (ui.server.address() as AddressInfo).port
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, { ...init, headers: { 'x-ugc-lens-token': 't', 'content-type': 'application/json' } })
    return { status: res.status, json: await res.json() as any }
  }
  try {
    const opened = await call('open', { method: 'POST', body: JSON.stringify({ path: 'bilibili_all.json' }) })
    assert.equal(opened.status, 200)
    const status = await call(`datasets/${opened.json.id}/analysis`)
    assert.equal(status.json.settings.auto_sentiment, true)
    assert.equal(status.json.settings.auto_topics, true)
    assert.notEqual(status.json.sentiment.state, 'idle')
    assert.notEqual(status.json.topics.state, 'idle')
    await ui.analysis.idle()
    assert.equal((await call(`datasets/${opened.json.id}/analysis`)).json.sentiment.state, 'done')
  } finally {
    await ui.close()
    ui.server.closeAllConnections()
    await new Promise((done) => ui.server.close(done))
  }
})

test('后台分析：同样内容的文件不管放在哪、从哪个目录打开，都先用已有结果，不再调用模型', async () => {
  const first = await loadDataset(join(cwd, 'data', 'bilibili_all.json'), { cacheDir: join(env.dir, 'cache') })
  const s = scorer()
  const a = createAnalysisRunner({ cwd: join(env.dir, 'proj-a'), homeDir: home, model: () => s.model })
  a.start(first, 'sentiment')
  await a.idle()
  const calls = s.calls()
  assert.ok(calls > 0)

  // 复制到另一个目录、换一个启动目录打开
  const elsewhere = join(env.dir, 'elsewhere', 'copy.json')
  mkdirSync(join(env.dir, 'elsewhere'), { recursive: true })
  copyFileSync(join(cwd, 'data', 'bilibili_all.json'), elsewhere)
  const second = await loadDataset(elsewhere, { cacheDir: join(env.dir, 'cache') })
  assert.notEqual(second.id, first.id)
  const b = createAnalysisRunner({ cwd: join(env.dir, 'proj-b'), homeDir: home, model: () => s.model })
  assert.equal(b.status(second).sentiment.state, 'done')
  assert.equal(b.start(second, 'sentiment', { onlyIfMissing: true }), 'exists')
  assert.equal(s.calls(), calls)
  const results = await b.results(second)
  assert.equal(results.find((r) => r.task === 'sentiment')?.source, 'model')
})
