import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { datasetId, ImportError, loadDataset } from '../../src/ingest/index.ts'
import { describeShape } from '../../src/ingest/shape.ts'
import { AV_FIXTURE, BILIBILI_MAPPING, BV_FIXTURE } from '../helpers/fixtures.ts'

let dir: string
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ugc-lens-ingest-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const failingModel: AgentModel = {
  async complete() {
    throw new Error('不应该调用模型')
  },
}

const submitting = () => createFakeModel([{ tool_calls: [{ name: 'submit_mapping', args: BILIBILI_MAPPING }] }, { content: '完成' }])

function isImportError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ImportError, String(error))
    assert.equal(error.code, code)
    return true
  }
}

test('loadDataset：第一次调用模型推断规则并写入缓存，第二次直接用缓存', async () => {
  const cacheDir = join(dir, 'cache-1')
  const first = await loadDataset(BV_FIXTURE, { model: submitting(), cacheDir })
  assert.equal(first.mapping.from_cache, false)
  assert.equal(first.platform, 'bilibili')
  assert.equal(first.id, datasetId(BV_FIXTURE))
  assert.equal(first.file_path, BV_FIXTURE)
  assert.deepEqual(await readdir(cacheDir), [`${first.mapping.fingerprint}.json`])

  const second = await loadDataset(BV_FIXTURE, { model: failingModel, cacheDir })
  assert.equal(second.mapping.from_cache, true)
  assert.deepEqual(second.items, first.items)
  assert.deepEqual(second.contents, first.contents)
})

test('loadDataset：useCache 为 false 时总是重新推断', async () => {
  const cacheDir = join(dir, 'cache-2')
  await loadDataset(BV_FIXTURE, { model: submitting(), cacheDir })
  const model = submitting()
  const again = await loadDataset(BV_FIXTURE, { model, cacheDir, useCache: false })
  assert.equal(again.mapping.from_cache, false)
  assert.equal(model.requests.length, 2)
})

const AV_MAPPING = { ...BILIBILI_MAPPING, content: { ...BILIBILI_MAPPING.content, id_from_path: '-(\\d+)/bilibili_all\\.json$' } }

test('loadDataset：已有规则在新文件上试转换出错时（路径里没有 BV 号），重新调用模型，两条规则都保留', async () => {
  const cacheDir = join(dir, 'cache-3')
  await loadDataset(BV_FIXTURE, { model: submitting(), cacheDir })

  const model = createFakeModel([{ tool_calls: [{ name: 'submit_mapping', args: AV_MAPPING }] }, { content: '完成' }])
  const dataset = await loadDataset(AV_FIXTURE, { model, cacheDir })
  assert.equal(dataset.mapping.from_cache, false)
  assert.equal(dataset.contents[0]?.id, '100000002')
  assert.equal(model.requests.length, 2)

  // 两个文件都不再调用模型
  assert.equal((await loadDataset(BV_FIXTURE, { model: failingModel, cacheDir })).contents[0]?.id, 'BV1xx411c7mD')
  assert.equal((await loadDataset(AV_FIXTURE, { model: failingModel, cacheDir })).contents[0]?.id, '100000002')
})

test('loadDataset：指纹不同但规则试转换通过时复用；有遗漏的数组时不复用', async () => {
  const cacheDir = join(dir, 'cache-6')
  await loadDataset(BV_FIXTURE, { model: submitting(), cacheDir })
  const raw = JSON.parse(await readFile(BV_FIXTURE, 'utf8'))
  const bvDir = join(dir, 'BV1aa411c7mD')
  await mkdir(bvDir, { recursive: true })

  const noDanmaku = join(bvDir, 'no_danmaku.json')
  await writeFile(noDanmaku, JSON.stringify({ ...raw, video_danmus: [], extra: null }))
  const reused = await loadDataset(noDanmaku, { model: failingModel, cacheDir })
  assert.notEqual(reused.mapping.fingerprint, describeShape(raw).fingerprint)
  assert.equal(reused.mapping.from_cache, true)
  assert.equal(reused.contents[0]?.id, 'BV1aa411c7mD')

  const extraList = join(bvDir, 'extra_list.json')
  await writeFile(extraList, JSON.stringify({ ...raw, gifts: Array.from({ length: 6 }, (_, i) => ({ text: `礼物${i}` })) }))
  const model = submitting()
  assert.equal((await loadDataset(extraList, { model, cacheDir })).mapping.from_cache, false)
})

test('loadDataset：模型拒绝的文件记入缓存，下次不再调用模型', async () => {
  const cacheDir = join(dir, 'cache-4')
  const file = join(dir, 'search.json')
  await writeFile(file, JSON.stringify([{ keyword: 'a', title: 'b' }]))
  const model = createFakeModel([{ tool_calls: [{ name: 'reject_file', args: { reason: '搜索结果列表' } }] }, { content: '完成' }])
  await assert.rejects(loadDataset(file, { model, cacheDir }), isImportError('not_feedback'))
  await assert.rejects(loadDataset(file, { model: failingModel, cacheDir }), isImportError('not_feedback'))
})

test('loadDataset：没有缓存也没有模型、模型给不出规则、不是 JSON、文件不存在', async () => {
  const cacheDir = join(dir, 'cache-5')
  await assert.rejects(loadDataset(BV_FIXTURE, { cacheDir }), isImportError('no_model'))
  await assert.rejects(loadDataset(BV_FIXTURE, { cacheDir, model: createFakeModel([{ content: '我不知道' }]) }), isImportError('inference_failed'))

  const text = join(dir, 'notes.txt')
  await writeFile(text, 'hello')
  await assert.rejects(loadDataset(text, { cacheDir }), isImportError('not_json'))
  await assert.rejects(loadDataset(join(dir, 'missing.json'), { cacheDir }), isImportError('read_failed'))
  await assert.rejects(loadDataset(dir, { cacheDir }), isImportError('read_failed'))
})

test('datasetId：同一文件得到同一 ID，相对路径与绝对路径等价', () => {
  assert.equal(datasetId(BV_FIXTURE), datasetId(BV_FIXTURE))
  assert.notEqual(datasetId(BV_FIXTURE), datasetId(AV_FIXTURE))
  assert.equal(datasetId(join(process.cwd(), 'a.json')), datasetId('a.json'))
})
