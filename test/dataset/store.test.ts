import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatasetStore } from '../../src/dataset/store.ts'
import { makeDataset } from '../helpers/dataset.ts'

test('createDatasetStore：按 ID 查找，list 返回副本', () => {
  const a = makeDataset([], { id: 'a' })
  const b = makeDataset([], { id: 'b' })
  const store = createDatasetStore([a, b])
  assert.equal(store.get('b'), b)
  assert.equal(store.get('c'), undefined)
  const list = store.list() as unknown[]
  list.length = 0
  assert.equal(store.list().length, 2)
})
