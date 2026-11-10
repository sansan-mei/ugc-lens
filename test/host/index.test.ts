import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { checkReport, describeSource, hostChunkText, submitMapping } from '../../src/host/index.ts'
import { prepareHostRun } from '../../src/host/prepare.ts'
import { loadDataset } from '../../src/ingest/index.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import { BV_FIXTURE } from '../helpers/fixtures.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const dir = mkdtempSync(join(tmpdir(), 'ugc-lens-host-'))
const cacheDir = join(dir, 'mappings')
after(() => rmSync(dir, { recursive: true, force: true }))

const forum = join(dir, 'forum.json')
writeFileSync(forum, JSON.stringify({ posts: [
  { pid: 'p1', body: '价格太贵了，续费还涨价', city: '上海', replies: [{ pid: 'p2', body: '同感，去年更便宜' }] },
  { pid: 'p3', body: '客服回复很快', city: '北京', replies: [] },
] }))

test('describeSource：未知结构返回结构摘要；内置格式直接可导入', async () => {
  const unknown = await describeSource(forum, cacheDir)
  assert.equal(unknown.mapped, false)
  assert.match(unknown.shape!, /posts/)
  assert.match(unknown.shape!, /body/)

  const known = await describeSource(BV_FIXTURE, cacheDir)
  assert.deepEqual([known.mapped, known.source], [true, 'builtin'])
})

test('submitMapping：格式错误或导入为空时拒绝且不写缓存；通过后无需模型即可导入', async () => {
  const bad = await submitMapping(forum, { platform: 'forum', collections: [{ kind: 'comment', path: 'posts', fields: { text: 'body' } }] }, cacheDir)
  assert.equal(bad.ok, false)
  assert.match(bad.report, /collections\.0\.path/)

  const empty = await submitMapping(forum, { platform: 'forum', collections: [{ kind: 'comment', path: '$.posts', fields: { text: 'missing' } }] }, cacheDir)
  assert.equal(empty.ok, false)
  assert.equal((await describeSource(forum, cacheDir)).mapped, false)

  const rule = { platform: 'unknown', collections: [{ kind: 'comment', path: '$.posts', fields: { id: 'pid', text: 'body', author_location: 'city' }, children: [{ kind: 'reply', path: 'replies' }] }] }
  const good = await submitMapping(forum, rule, cacheDir)
  assert.equal(good.ok, true, good.report)
  const dataset = await loadDataset(forum, { cacheDir })
  assert.deepEqual(dataset.items.map((item) => [item.id, item.kind, item.parent_id]), [['p1', 'comment', undefined], ['p2', 'reply', 'p1'], ['p3', 'comment', undefined]])
  assert.deepEqual(await describeSource(forum, cacheDir), { file: dataset.file_path, mapped: true, source: 'cache' })
})

test('hostChunkText：块内编号全部换回原 ID，每个 ID 都出现在块中', async () => {
  const dataset = await loadDataset(BV_FIXTURE, { cacheDir })
  const plan = planChunks(dataset)
  assert.ok(plan.chunks.length > 0)
  for (const chunk of plan.chunks) {
    const text = hostChunkText(chunk, plan.chunks.length)
    for (const id of chunk.ids) assert.ok(text.includes(`[${id}]`), `块 ${chunk.index + 1} 缺少 [${id}]`)
    for (const line of text.split('\n').slice(2).filter(Boolean)) {
      const label = /^\s*↳?\[([^\]]+)\]/.exec(line)?.[1]
      if (label) assert.ok(chunk.ids.includes(label), `行首编号 ${label} 不是原 ID`)
    }
  }
})

test('checkReport：ID 与摘句都要能回到原文；表情方括号和回复前缀不误报', () => {
  const dataset = makeDataset([
    makeItem({ id: '101', text: '[doge]今年能更新第二次真的小看你了' }),
    makeItem({ id: '102', kind: 'reply', parent_id: '101', text: '回复 @某人 :哈哈哈哈哈哈哈哈哈哈 太真实了' }),
  ])
  const ok = checkReport('- "[doge]今年能更新第二次" [101]\n- “太真实了” [102]，另见 [101]\n', dataset)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.quotes_checked, 2)

  const bad = checkReport('- "今年更新了三次" [101]\n- 不存在 [999]\n', dataset)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.invalid_ids, ['999'])
  assert.deepEqual(bad.quote_mismatches.map((m) => [m.id, m.line]), [['101', 1]])

  assert.equal(checkReport('没有任何引用', dataset).ok, false)
})

test('prepareHostRun：写出事实、说明、分块和清单，分块覆盖与清单一致，不调用模型', async () => {
  const out = join(dir, 'prepared')
  const manifest = await prepareHostRun({ file: BV_FIXTURE, outDir: out, cacheDir, directions: ['价格', '体验'], memory: { cwd: dir, homeDir: dir } })
  assert.deepEqual(manifest.directions, ['价格', '体验'])
  assert.ok(manifest.chunks.length > 0)
  const facts = readFileSync(join(out, 'facts.md'), 'utf8')
  assert.match(facts, /## 概况/)
  assert.doesNotMatch(facts, /核心结论/)
  const guide = readFileSync(join(out, 'guide.md'), 'utf8')
  assert.match(guide, /1\. 价格\n2\. 体验/)
  assert.match(guide, /ugc-lens host verify/)
  const included = manifest.chunks.filter((c) => c.kind === 'threads').reduce((sum, c) => sum + c.items, 0)
  assert.equal(included, manifest.coverage.items_included)
  for (const chunk of manifest.chunks) assert.match(readFileSync(join(out, chunk.file), 'utf8'), /^# 第 \d+\/\d+ 块/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).chunks, manifest.chunks)
})
