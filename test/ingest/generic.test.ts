import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { loadDataset } from '../../src/ingest/index.ts'
import { computeStats } from '../../src/dataset/stats.ts'
import { createDatasetStore } from '../../src/dataset/store.ts'
import { createDataTools } from '../../src/tools/data/index.ts'
import { analyzeDataset } from '../../src/pipeline/analyze.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import { denyAll } from '../../src/tools/approval.ts'
const mapping = (text: string, id: string, path = '$.rows') => ({ platform: 'unknown', collections: [{ kind: 'record', path, fields: { text, id } }] })
const submit = (text: string, id: string, path?: string) => createFakeModel([{ tool_calls: [{ name: 'submit_mapping', args: mapping(text, id, path) }] }, { content: '完成' }])

test('CSV：模型根据表头映射；同表头复用缓存，列顺序/名称变化不能误用旧规则', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-csv-'))
  const cacheDir = join(dir, 'cache')
  try {
    const firstFile = join(dir, 'a.csv')
    await writeFile(firstFile, '编号,回答\n001,价格太高\n002,内容很好')
    const firstModel = submit('column_2', 'column_1')
    const first = await loadDataset(firstFile, { model: firstModel, cacheDir })
    assert.deepEqual(first.items.map((i) => [i.id, i.text, i.kind]), [['001', '价格太高', 'record'], ['002', '内容很好', 'record']])
    assert.equal(first.source?.format, 'csv')
    assert.match(firstModel.requests[0]?.messages[1]?.content ?? '', /编号/)
    const cached = await loadDataset(firstFile, { cacheDir })
    assert.equal(cached.mapping.from_cache, true)
    const secondFile = join(dir, 'b.tsv')
    await writeFile(secondFile, '回答\t编号\n价格可以接受\t003\n售后响应慢\t004')
    const secondModel = submit('column_1', 'column_2')
    const second = await loadDataset(secondFile, { model: secondModel, cacheDir })
    assert.ok(secondModel.requests.length > 0)
    assert.notEqual(second.mapping.fingerprint, first.mapping.fingerprint)
    assert.equal(second.items[0]?.id, '003')
    assert.equal(second.items[0]?.text, '价格可以接受')
    const thirdFile = join(dir, 'c.csv')
    await writeFile(thirdFile, '回答,编号\n质量很好,005\n售后问题,006')
    const third = await loadDataset(thirdFile, { cacheDir })
    assert.equal(third.mapping.from_cache, true)
    assert.equal(third.items[0]?.id, '005')
    assert.equal((await readdir(cacheDir)).length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('JSONL 对象复用 JSON 的推断流程；NDJSON 可读取相同规则缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-jsonl-'))
  try {
    const first = join(dir, 'a.jsonl')
    const second = join(dir, 'b.ndjson')
    const rows = [{ id: 'a', body: { text: '需要增加搜索功能' } }, { id: 'b', body: { text: '希望优化打开速度' } }]
    await writeFile(first, rows.map((r) => JSON.stringify(r)).join('\n'))
    await writeFile(second, rows.map((r) => JSON.stringify(r)).join('\r\n'))
    const options = { cacheDir: join(dir, 'cache') }
    const data = await loadDataset(first, { ...options, model: submit('body.text', 'id', '$') })
    assert.equal(data.items.length, rows.length)
    assert.equal(data.items[0]?.text, rows[0]?.body.text)
    const cached = await loadDataset(second, options)
    assert.equal(cached.mapping.from_cache, true)
    assert.deepEqual(cached.items, data.items)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('TXT/Markdown/LOG 和字符串 JSON 无需模型和缓存，稳定 ID 可查询，短答案不被过滤', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-text-'))
  try {
    for (const [name, body] of [['a.txt', '好\n\n无\n需要优化速度'], ['a.md', '访谈第一段\n换行继续\n\n第二段'], ['a.log', '启动失败\n网络连接超时'], ['a.json', '["好","无"]'], ['a.jsonl', '"好"\n"无"']] as const) {
      const file = join(dir, name)
      await writeFile(file, body)
      const data = await loadDataset(file, { cacheDir: join(dir, 'unused') })
      assert.equal(data.mapping.builtin, true)
      assert.ok(data.items.every((item) => item.kind === 'record'))
      assert.equal(computeStats(data).items.record, data.items.length)
      const plan = planChunks(data)
      assert.equal(plan.coverage.low_info, 0)
      assert.equal(plan.coverage.items_included, data.items.length)
      const again = await loadDataset(file)
      assert.deepEqual(again.items.map((i) => i.id), data.items.map((i) => i.id))
      const get = createDataTools(createDatasetStore([data])).find((t) => t.name === 'get_feedback')!
      const result = await get.execute({ ids: [data.items[0]!.id] }, { cwd: dir, run_id: 'test', signal: new AbortController().signal, approve: denyAll })
      assert.ok(result.includes(data.items[0]!.text.split('\n')[0]!))
    }
    assert.ok(!(await readdir(dir)).includes('unused'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('非 UGC CSV 可直接分析并生成带原文引用的报告，使用通用方向和名称', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-record-report-'))
  try {
    const path = join(dir, 'survey.csv')
    await writeFile(path, '序号,开放题回答\n001,希望客服响应快一些\n002,售后处理速度需要优化')
    const dataset = await loadDataset(path, { model: submit('column_2', 'column_1'), cacheDir: join(dir, 'cache') })
    const model = createFakeModel([{ tool_calls: [{ name: 'submit_findings', args: { findings: [{ direction: 1, title: '希望更快的服务', criteria: '提到服务速度', support: 2, refs: [1, 2] }] } }] }])
    const result = await analyzeDataset({ model, dataset, outDir: join(dir, 'reports') })
    assert.match(result.markdown, /文本记录：记录 2 条/)
    assert.match(result.markdown, /## 主要主题/)
    assert.match(result.markdown, /希望客服响应快一些/)
    assert.match(result.markdown, /`001`/)
    assert.doesNotMatch(result.markdown, /评论|视频|弹幕/)
    assert.equal(await readFile(result.path!, 'utf8'), result.markdown)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('长通用记录不沿用评论的 500 字截断，超过总预算时如实报告未纳入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ugc-long-record-'))
  try {
    const file = join(dir, 'interview.txt')
    const text = '访谈内容关于产品改进。'.repeat(1000) + '末尾提出最重要的建议'
    await writeFile(file, text)
    const dataset = await loadDataset(file)
    const full = planChunks(dataset, { maxChunkChars: 1000, maxTotalChars: text.length + 1000 })
    assert.equal(full.coverage.items_included, 1)
    assert.ok(full.chunks.flatMap((c) => c.lines).join('\n').includes('末尾提出最重要的建议'))
    const limited = planChunks(dataset, { maxTotalChars: 1000 })
    assert.equal(limited.coverage.items_included, 0)
    assert.equal(limited.coverage.sampled, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
