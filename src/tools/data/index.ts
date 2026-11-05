import type { DatasetStore } from '../../dataset/store.ts'
import type { AgentTool } from '../types.ts'
import { createGetDatasetStatsTool } from './get_dataset_stats.ts'
import { createGetFeedbackTool } from './get_feedback.ts'
import { createListDatasetsTool } from './list_datasets.ts'
import { createSearchFeedbackTool } from './search_feedback.ts'
import type { DataToolOptions } from './shared.ts'
import { createAnalyzeSentimentTool } from './analyze_sentiment.ts'

export { createGetDatasetStatsTool, createGetFeedbackTool, createListDatasetsTool, createSearchFeedbackTool }
export type { DataToolOptions }

/** 数据查询及可选的分批情感分析工具。 */
export function createDataTools(store: DatasetStore, options: DataToolOptions = {}): AgentTool[] {
  return [
    createListDatasetsTool(store),
    createGetDatasetStatsTool(store, options),
    createSearchFeedbackTool(store, options),
    createGetFeedbackTool(store, options),
    ...(options.sentimentModel ? [createAnalyzeSentimentTool(store, options.sentimentModel)] : []),
  ]
}
