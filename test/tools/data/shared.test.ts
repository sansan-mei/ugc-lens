import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatasetStore } from '../../../src/dataset/store.ts'
import { resolveDataset } from '../../../src/tools/data/shared.ts'
import { makeDataset } from '../../helpers/dataset.ts'

test('resolveDataset：只有一个数据集时可以不填 ID', () => {
  const only = makeDataset([], { id: 'only' })
  assert.equal(resolveDataset(createDatasetStore([only]), undefined), only)
})

test('resolveDataset：多个数据集不填 ID、ID 不存在、没有数据集时报错并列出可用 ID', () => {
  const store = createDatasetStore([makeDataset([], { id: 'a' }), makeDataset([], { id: 'b' })])
  assert.equal(resolveDataset(store, 'b').id, 'b')
  assert.throws(() => resolveDataset(store, undefined), /有 2 个数据集.*a, b/)
  assert.throws(() => resolveDataset(store, 'c'), /找不到数据集 c.*a, b/)
  assert.throws(() => resolveDataset(createDatasetStore([]), undefined), /还没有导入任何数据集/)
})
