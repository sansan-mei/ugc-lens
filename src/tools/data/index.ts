import type { DatasetStore } from '../../dataset/store.ts'
import type { AgentTool } from '../types.ts'
import { createGetDatasetStatsTool } from './get_dataset_stats.ts'
import { createGetFeedbackTool } from './get_feedback.ts'
import { createListDatasetsTool } from './list_datasets.ts'
import { createSearchFeedbackTool } from './search_feedback.ts'
import type { DataToolOptions } from './shared.ts'

export { createGetDatasetStatsTool, createGetFeedbackTool, createListDatasetsTool, createSearchFeedbackTool }
export type { DataToolOptions }

/** 查询数据集的工具，全部只读，不需要确认 */
export function createDataTools(store: DatasetStore, options: DataToolOptions = {}): AgentTool[] {
  return [
    createListDatasetsTool(store),
    createGetDatasetStatsTool(store, options),
    createSearchFeedbackTool(store, options),
    createGetFeedbackTool(store, options),
  ]
}
