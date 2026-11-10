import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { exportLabels, importLabels } from '../../src/host/labels.ts'
import { sentimentStats } from '../../src/sentiment/index.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-labels-'))
after(() => rmSync(root, { recursive: true, force: true }))

const dataset = makeDataset([
  makeItem({ id: 'c1', text: '价格太贵了，续费还涨价' }),
  makeItem({ id: 'c2', text: '客服回复很快，体验不错' }),
  makeItem({ id: 'r1', kind: 'reply', parent_id: 'c1', text: '同感' }),
  makeItem({ id: 'c3', text: '一般般吧，能用' }),
  makeItem({ id: 'd1', kind: 'danmaku', text: '哈哈哈' }),
])
const answers = (dir: string, name: string, rows: unknown[]) => writeFileSync(join(dir, 'answers', name), rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n')

test('label-export：按范围分批导出原文，规则改写为写文件的说法，且不含工具名', async () => {
  const dir = join(root, 'export')
  const manifest = await exportLabels({ dataset, task: { type: 'sentiment', target: '价格' }, outDir: dir, kinds: ['comment', 'reply'], batchSize: 2 })
  assert.deepEqual(manifest.batches.map((b) => b.ids), [['c1', 'c2'], ['r1', 'c3']])
  assert.equal(manifest.scope.in_scope, 4)
  const first = readFileSync(join(dir, manifest.batches[0]!.file), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(first.map((row) => [row.id, row.text]), [['c1', '价格太贵了，续费还涨价'], ['c2', '客服回复很快，体验不错']])
  const rules = readFileSync(join(dir, 'task.md'), 'utf8')
  assert.match(rules, /评价对象："价格"/)
  assert.match(rules, /"score"/)
  assert.doesNotMatch(rules, /submit_/)
})

test('label-import：情感逐行校验，错误、批外、重复和遗漏分别计数，汇总与完整流水线同一口径', async () => {
  const dir = join(root, 'sentiment')
  await exportLabels({ dataset, task: { type: 'sentiment', target: '文本整体表达的情绪' }, outDir: dir, kinds: ['comment', 'reply'] })
  answers(dir, '001.jsonl', [
    { id: 'c1', score: -0.8, reason: '嫌贵' },
    { id: 'c2', score: 0.7, reason: '夸客服' },
    { id: 'r1', score: 2, reason: '越界' },
    { id: 'd1', score: 0, reason: '批外' },
    { id: 'c2', score: 0.1, reason: '重复' },
    'not json',
  ])
  const bad = await importLabels(dataset, dir)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.counts, { exported: 4, processed: 1, invalid: 2, missing: 1, skipped_long: 0, in_scope: 4 })
  assert.equal(bad.errors.length, 4)

  answers(dir, '001.jsonl', [
    { id: 'c1', score: -0.8, reason: '嫌贵' },
    { id: 'c2', score: 0.7, reason: '夸客服' },
    { id: 'r1', score: null, reason: '指代不明' },
    { id: 'c3', score: 0.1, reason: '一般', mixed: true },
  ])
  const good = await importLabels(dataset, dir)
  assert.equal(good.ok, true, JSON.stringify(good.errors))
  const summary = good.summary as { summary: ReturnType<typeof sentimentStats>; by_kind: Record<string, unknown> }
  assert.deepEqual(summary.summary.counts, { positive: 1, neutral: 0, negative: 1, mixed: 1, uncertain: 1, failed: 0, skipped: 0 })
  assert.equal(summary.summary.evaluated, 4)
  assert.ok(summary.by_kind.reply)
  assert.equal(JSON.parse(readFileSync(good.path, 'utf8')).ok, true)
})

test('label-import：主题只接受已定义的主题 ID，占比按成功归类条数计算', async () => {
  const dir = join(root, 'topics')
  const topics = [{ id: 'price', title: '价格', criteria: '提到价格或涨价' }, { id: 'service', title: '客服', criteria: '提到客服' }]
  await exportLabels({ dataset, task: { type: 'topics', topics }, outDir: dir, kinds: ['comment'] })
  answers(dir, '001.jsonl', [
    { id: 'c1', topic_ids: ['price'], uncertain: false, reason: '涨价' },
    { id: 'c2', topic_ids: ['shipping'], uncertain: false, reason: '未定义' },
    { id: 'c3', topic_ids: [], uncertain: true, reason: '不确定' },
  ])
  const result = await importLabels(dataset, dir)
  assert.equal(result.ok, false)
  assert.match(result.errors[0]!.error, /无效主题/)
  const summary = result.summary as { topics: Array<{ id: string; count: number; share: number | null }>; uncertain: number }
  assert.deepEqual(summary.topics.map((t) => [t.id, t.count, t.share]), [['price', 1, 0.5], ['service', 0, 0]])
  assert.equal(summary.uncertain, 1)
})

test('label-import：商业机会的摘句必须是原文子串，按优先级排序', async () => {
  const dir = join(root, 'business')
  await exportLabels({ dataset, task: { type: 'business', goal: '找付费机会' }, outDir: dir, kinds: ['comment'] })
  const base = { problem: '续费贵', hypothesis: '年付折扣能留存', validation: '做 A/B', effort: '低' }
  answers(dir, '001.jsonl', [
    { id: 'c1', opportunities: [{ ...base, title: '年付折扣', quote: '续费还涨价', priority: 'low' }] },
    { id: 'c2', opportunities: [{ ...base, title: '客服卖点', quote: '客服很好', priority: 'high' }] },
    { id: 'c3', opportunities: [{ ...base, title: '基础版', quote: '能用', priority: 'high' }] },
  ])
  const result = await importLabels(dataset, dir)
  assert.deepEqual(result.errors.map((e) => [e.id, e.error]), [['c2', '商业证据摘句不是原文子串']])
  const ranked = (result.summary as { opportunities: Array<{ title: string; refs: string[] }> }).opportunities
  assert.deepEqual(ranked.map((o) => [o.title, o.refs[0]]), [['基础版', 'c3'], ['年付折扣', 'c1']])
})

test('label-export：抽样可复现并在结果中注明；数据集不一致时拒绝导入', async () => {
  const a = await exportLabels({ dataset, task: { type: 'sentiment', target: 'x' }, outDir: join(root, 's1'), sample: 2, seed: 7 })
  const b = await exportLabels({ dataset, task: { type: 'sentiment', target: 'x' }, outDir: join(root, 's2'), sample: 2, seed: 7 })
  assert.deepEqual(a.batches, b.batches)
  assert.equal(a.batches.flatMap((x) => x.ids).length, 2)
  assert.match(readFileSync(join(root, 's1', 'task.md'), 'utf8'), /随机抽取 2 条/)
  const result = await importLabels(dataset, join(root, 's1'))
  assert.match((result.summary as { scope_note: string }).scope_note, /随机样本/)
  assert.equal(result.counts.missing, 2)

  await assert.rejects(importLabels(makeDataset([], { id: 'other' }), join(root, 's1')), /不一致/)
})
