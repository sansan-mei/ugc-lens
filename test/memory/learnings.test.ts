import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDatasetStore } from '../../src/dataset/store.ts'
import { recordLearning, recordOutcome, searchLearnings } from '../../src/memory/learnings.ts'
import { createMemoryTools } from '../../src/memory/tools.ts'
import { denyAll } from '../../src/tools/approval.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'
const dataset = makeDataset([makeItem({ id: 'c1', text: '价格太贵' })])
function sandbox() {
  const cwd = mkdtempSync(join(tmpdir(), 'ugc-learning-'))
  return { memory: { cwd, homeDir: cwd }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}
test('learnings：并发追加保留所有原记录，按数据集和关键词分页，不自动总结', async () => {
  const { memory, cleanup } = sandbox()
  try {
    assert.deepEqual(await searchLearnings(memory), { entries: [], next_offset: null })
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) => recordLearning(memory, [{ ...dataset, id: i % 2 ? 'a' : 'b' }], { kind: 'candidate', note: `价格观察 ${i}`, observations: {}, evidence_ids: ['c1'] })))
    const all = await searchLearnings(memory)
    assert.deepEqual(new Set(all.entries.map((e) => e.id)), new Set(records.map((e) => e.id)))
    const first = await searchLearnings(memory, '价格', 'a', 0, 2)
    assert.equal(first.entries.length, 2)
    assert.equal(first.next_offset, 2)
    const second = await searchLearnings(memory, '价格', 'a', first.next_offset!, 2)
    assert.equal(second.entries.length, 2)
    assert.equal(second.next_offset, null)
    assert.ok(second.entries.every((e) => e.dataset_ids.includes('a') && e.note?.includes('价格观察')))
    assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.id)).size, 4)
    assert.deepEqual((await searchLearnings(memory, '不存在')).entries, [])
  } finally { cleanup() }
})
test('经验工具核对原文 ID，候选经验不改变规则，搜索返回原记录', async () => {
  const { memory, cleanup } = sandbox()
  try {
    const tools = createMemoryTools(createDatasetStore([dataset]), memory)
    const record = tools.find((t) => t.name === 'record_learning')!
    const ctx = { run_id: 'test', cwd: memory.cwd, signal: new AbortController().signal, approve: denyAll }
    await assert.rejects(record.execute({ note: '价格意见', evidence_ids: ['missing'] }, ctx), /证据 ID/)
    await assert.rejects(record.execute({ note: 'sk-' + 'X'.repeat(30), evidence_ids: ['c1'] }, ctx), /密钥/)
    const saved = JSON.parse(await record.execute({ note: '价格意见', evidence_ids: ['c1', 'c1'] }, ctx))
    assert.equal(saved.kind, 'candidate')
    assert.deepEqual(saved.evidence_ids, ['c1'])
    assert.deepEqual(saved.dataset_ids, [dataset.id])
    const search = tools.find((t) => t.name === 'search_learnings')!
    const found = JSON.parse(await search.execute({ query: '价格' }, ctx))
    assert.deepEqual(found.entries, [saved])
    assert.ok(!tools.some((t) => t.name.includes('apply')))
  } finally { cleanup() }
})
test('经验持久化失败返回警告，通知函数出错也不会掩盖结果', async () => {
  const { memory, cleanup } = sandbox()
  try {
    writeFileSync(join(memory.cwd, '.ugc-lens'), 'file')
    const warning = await recordOutcome({ ...memory, onWarning: () => { throw new Error('notification') } }, [dataset], { kind: 'ask', observations: {} })
    assert.match(warning!, /经验记录失败/)
  } finally { cleanup() }
})
