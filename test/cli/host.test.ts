import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { runHost } from '../../src/cli/host.ts'
import { UsageError } from '../../src/cli/common.ts'
import { BV_FIXTURE } from '../helpers/fixtures.ts'

const cwd = mkdtempSync(join(tmpdir(), 'ugc-lens-cli-host-'))
after(() => rmSync(cwd, { recursive: true, force: true }))

async function capture(t: TestContext, argv: string[]): Promise<{ json: any; exitCode: number | undefined }> {
  let output = ''
  t.mock.method(console, 'error', () => {})
  const before = process.exitCode
  process.exitCode = undefined
  try {
    await runHost(argv, { cwd, write: (text) => { output += text } })
    return { json: JSON.parse(output), exitCode: process.exitCode as number | undefined }
  } finally {
    t.mock.restoreAll()
    process.exitCode = before
  }
}

test('host CLI：参数错误给出用法错误', async () => {
  await assert.rejects(runHost([], { cwd }), UsageError)
  await assert.rejects(runHost(['explode', BV_FIXTURE], { cwd }), /未知操作/)
  await assert.rejects(runHost(['search', BV_FIXTURE], { cwd }), /检索词/)
  await assert.rejects(runHost(['search', BV_FIXTURE, 'x', '--kinds', 'tweet'], { cwd }), /未知类型/)
})

test('host CLI：prepare 默认写到当前目录 .ugc-lens/host/<数据集ID>', async (t) => {
  const { json } = await capture(t, ['prepare', BV_FIXTURE])
  assert.equal(json.out, join(cwd, '.ugc-lens', 'host', json.dataset_id))
  assert.ok(existsSync(join(json.out, 'manifest.json')))
  assert.ok(existsSync(join(json.out, json.chunks[0].file)))
})

test('host CLI：search 返回真实总数，get 返回原文和回复，verify 有问题时退出码 1', async (t) => {
  const all = await capture(t, ['search', BV_FIXTURE, '', '--limit', '1'])
  assert.equal(all.json.total, all.json.items_total)
  assert.equal(all.json.items.length, 1)
  const first = all.json.items[0]

  const got = await capture(t, ['get', BV_FIXTURE, first.id])
  assert.equal(got.json.item.id, first.id)
  assert.ok(Array.isArray(got.json.replies))

  const report = join(cwd, 'report.md')
  writeFileSync(report, `- "${first.text.slice(0, 6)}" [${first.id}]\n`)
  const ok = await capture(t, ['verify', BV_FIXTURE, report])
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json))
  assert.equal(ok.exitCode, undefined)

  writeFileSync(report, `- "完全不存在的话" [${first.id}] [no_such_id]\n`)
  const bad = await capture(t, ['verify', BV_FIXTURE, report])
  assert.equal(bad.json.ok, false)
  assert.equal(bad.exitCode, 1)
})

test('host CLI：未知结构提示先 describe 再提交 mapping', async () => {
  const file = join(cwd, 'unknown.json')
  writeFileSync(file, JSON.stringify({ posts: [{ body: 'a' }, { body: 'b' }] }))
  await assert.rejects(runHost(['search', file, 'a'], { cwd }), /host describe/)
})

test('host CLI：label-export 与 label-import 往返，遗漏时退出码 1', async (t) => {
  await assert.rejects(runHost(['label-export', BV_FIXTURE, 'mood'], { cwd }), /sentiment、topics 或 business/)
  await assert.rejects(runHost(['label-export', BV_FIXTURE, 'topics'], { cwd }), /--topics/)
  const exported = await capture(t, ['label-export', BV_FIXTURE, 'sentiment', '--kinds', 'comment', '--sample', '3'])
  assert.equal(exported.json.items, 3)
  assert.ok(exported.json.out.startsWith(join(cwd, '.ugc-lens', 'host')) && exported.json.out.endsWith('labels-sentiment'))
  const ids = readFileSync(join(exported.json.out, exported.json.batches[0].file), 'utf8').trim().split('\n').map((line) => JSON.parse(line).id as string)

  const partial = await capture(t, ['label-import', BV_FIXTURE, exported.json.out])
  assert.equal(partial.exitCode, 1)
  assert.equal(partial.json.counts.missing, 3)
  assert.equal(partial.json.summary.records, undefined, 'CLI 输出不含逐条记录')

  writeFileSync(join(exported.json.out, 'answers', '001.jsonl'), ids.map((id, i) => JSON.stringify({ id, score: i === 0 ? -0.5 : 0.5, reason: '测试' })).join('\n'))
  const done = await capture(t, ['label-import', BV_FIXTURE, exported.json.out])
  assert.equal(done.exitCode, undefined)
  assert.deepEqual([done.json.ok, done.json.summary.summary.counts.positive, done.json.summary.summary.counts.negative], [true, 2, 1])
})

test('host CLI：recheck 排除已引用 ID；propose 写入待审修改并校验参数', async (t) => {
  const all = await capture(t, ['search', BV_FIXTURE, '', '--kinds', 'comment', '--limit', '2'])
  const [first, second] = all.json.items
  const word = (first.text as string).slice(0, 2)
  const result = await capture(t, ['recheck', BV_FIXTURE, '--query', word, '--exclude', first.id])
  assert.ok(result.json.candidates.every((c: { id: string }) => c.id !== first.id))
  assert.ok(result.json.matched >= 1)
  assert.ok(second)
  await assert.rejects(runHost(['recheck', BV_FIXTURE], { cwd }), /--query/)

  await assert.rejects(runHost(['propose', 'nope', 'add', '--text', 'x'], { cwd }), /章节/)
  const proposal = await capture(t, ['propose', 'summarize', 'add', '--text=- 区分广告植入与真实体验。'])
  assert.match(proposal.json.apply, /ugc-lens playbook --apply /)
  assert.ok(existsSync(join(cwd, '.ugc-lens', 'playbook.pending.json')))
})
