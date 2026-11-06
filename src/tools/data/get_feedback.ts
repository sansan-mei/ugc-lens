import { getEvidence } from '../../dataset/evidence.ts'
import * as z from 'zod'
import { getReplies } from '../../dataset/query.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'
import { formatItem, hasManyContents, takeLines } from './format.ts'
import { DEFAULT_MAX_OUTPUT_CHARS, datasetIdParam, resolveDataset, type DataToolOptions } from './shared.ts'

const FULL_TEXT_CHARS = 2_000
const CONTEXT_CHARS = 150

export function createGetFeedbackTool(store: DatasetStore, options: DataToolOptions = {}): AgentTool {
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  return defineTool({
    name: 'get_feedback',
    description: '按 ID 读取互动内容或字幕证据的全文，以及上下文：它回复的上一级、它下面的回复（按时间先后）。一次最多 10 个 ID。',
    parameters: z.object({
      dataset_id: datasetIdParam,
      ids: z.array(z.string().min(1)).min(1).max(10).describe('条目 ID，即结果中方括号里的部分，不含方括号'),
      reply_offset: z.number().int().min(0).default(0).describe('回复从第几条开始'),
      reply_limit: z.number().int().min(0).max(50).default(10).describe('每条最多显示多少条回复'),
    }),
    async execute({ dataset_id, ids, reply_offset, reply_limit }) {
      const dataset = resolveDataset(store, dataset_id)
      const showContent = hasManyContents(dataset)
      const missing = ids.filter((id) => !getEvidence(dataset, id))
      if (missing.length === ids.length) throw new Error(`找不到这些 ID：${missing.join(', ')}。ID 要和结果中方括号里的完全一致`)

      const blocks: string[] = []
      for (const id of ids) {
        const item = getEvidence(dataset, id)
        if (!item) continue
        const lines = [formatItem(item, { maxChars: FULL_TEXT_CHARS, showContent })]
        const parent = item.parent_id ? getEvidence(dataset, item.parent_id) : undefined
        if (parent) lines.push(`  上一级：${formatItem(parent, { maxChars: CONTEXT_CHARS })}`)
        else if (item.parent_id) lines.push(`  上一级 [${item.parent_id}] 不在数据里`)

        const replies = getReplies(dataset, id)
        const page = replies.slice(reply_offset, reply_offset + reply_limit)
        if (replies.length > 0) {
          lines.push(`  回复（搜集到 ${replies.length} 条${item.reply_count ? `，平台显示 ${item.reply_count} 条` : ''}）：`)
          for (const reply of page) lines.push(`  - ${formatItem(reply, { maxChars: CONTEXT_CHARS })}`)
          const end = reply_offset + page.length
          if (end < replies.length) lines.push(`  还有 ${replies.length - end} 条回复，用 reply_offset=${end} 继续`)
        } else if (item.reply_count) {
          lines.push(`  平台显示有 ${item.reply_count} 条回复，但没有搜集到`)
        }
        blocks.push(lines.join('\n'))
      }
      if (missing.length > 0) blocks.push(`找不到这些 ID：${missing.join(', ')}`)

      const { shown, omitted } = takeLines(blocks, maxChars)
      return omitted > 0 ? `${shown.join('\n\n')}\n\n（结果过长，省略了 ${omitted} 个条目，请分批读取）` : shown.join('\n\n')
    },
  })
}
