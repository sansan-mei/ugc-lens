import type { Dataset } from './types.ts'

/** 工具通过它找到数据集。第一版只在内存里，第 10 步监听目录时再持久化 */
export interface DatasetStore {
  list(): readonly Dataset[]
  get(id: string): Dataset | undefined
}

export function createDatasetStore(datasets: readonly Dataset[]): DatasetStore {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]))
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
  }
}
