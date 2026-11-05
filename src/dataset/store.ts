import type { Dataset } from './types.ts'

/** 工具通过它找到数据集。只在内存里：监听目录只需要持久化任务和报告，数据集每次从原文件导入 */
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
