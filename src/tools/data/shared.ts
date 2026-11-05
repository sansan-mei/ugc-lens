import * as z from 'zod'
import type { AgentModel } from '../../agent/model.ts'
import type { Dataset } from '../../dataset/types.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import type { MemoryOptions } from '../../memory/playbook.ts'

export interface DataToolOptions {
  memory?: MemoryOptions
  sentimentModel?: AgentModel
  /** 每次工具结果的字符上限 */
  maxOutputChars?: number
}

export const DEFAULT_MAX_OUTPUT_CHARS = 8_000

export const datasetIdParam = z
  .string()
  .optional()
  .describe('数据集 ID，只有一个数据集时可以不填。不知道 ID 时先调用 list_datasets')

/** 只有一个数据集时可以不填 ID，省得模型每次都先查一遍 */
export function resolveDataset(store: DatasetStore, id: string | undefined): Dataset {
  if (id !== undefined) {
    const dataset = store.get(id)
    if (!dataset) throw new Error(`找不到数据集 ${id}。可用的数据集：${store.list().map((d) => d.id).join(', ') || '无'}`)
    return dataset
  }
  const all = store.list()
  if (all.length === 1) return all[0]!
  if (all.length === 0) throw new Error('还没有导入任何数据集')
  throw new Error(`有 ${all.length} 个数据集，请用 dataset_id 指定：${all.map((d) => d.id).join(', ')}`)
}
