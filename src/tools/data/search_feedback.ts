import * as z from 'zod'
import { searchFeedback, type FeedbackSort } from '../../dataset/query.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import { FEEDBACK_KINDS } from '../../dataset/types.ts'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'
import { formatItem, hasManyContents, takeLines } from './format.ts'
import { DEFAULT_MAX_OUTPUT_CHARS, datasetIdParam, resolveDataset, type DataToolOptions } from './shared.ts'

const SORTS = ['likes', 'replies', 'newest', 'oldest', 'video_time'] as const satisfies readonly FeedbackSort[]
const MAX_LIMIT = 50
const SNIPPET_CHARS = 150

export function createSearchFeedbackTool(store: DatasetStore, options: DataToolOptions = {}): AgentTool {
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  return defineTool({
    name: 'search_feedback',
    description:
      '按条件筛选互动内容（评论、回复、弹幕、回答），分页返回，每条前面是 [ID]。' +
      `正文超过 ${SNIPPET_CHARS} 字会截断，用 get_feedback 看全文和回复链。` +
      '返回结果末尾会说明共有多少条、下一页的 offset。',
    parameters: z.object({
      dataset_id: datasetIdParam,
      query: z
        .string()
        .optional()
        .describe('关键词，不区分大小写。空格分隔的词都要出现；一个词里用 | 分隔表示任意一个出现即可，如 "退钱|骗 标题"'),
      kinds: z.array(z.enum(FEEDBACK_KINDS)).optional().describe('只看这些类型，不填表示全部'),
      content_id: z.string().optional().describe('只看某个内容下的'),
      parent_id: z.string().optional().describe('只看某一条的直接回复'),
      min_likes: z.number().int().min(0).optional(),
      location: z.string().optional().describe('IP 属地，如 广东'),
      since: z.string().optional().describe('发布时间不早于，如 2024-05-01；弹幕没有发布时间，会被排除'),
      until: z.string().optional().describe('发布时间不晚于'),
      sort: z.enum(SORTS).default('likes').describe('likes 点赞多的在前，replies 回复多的在前，newest/oldest 按发布时间，video_time 按弹幕在视频中的时间'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(20),
    }),
    async execute({ dataset_id, ...query }) {
      const dataset = resolveDataset(store, dataset_id)
      const page = searchFeedback(dataset, query)
      if (page.total === 0) return '没有符合条件的内容。可以换个关键词，或放宽条件。'
      if (page.items.length === 0) return `共 ${page.total} 条，offset=${page.offset} 已超出范围。`

      const lines = page.items.map((item) => formatItem(item, { maxChars: SNIPPET_CHARS, showContent: hasManyContents(dataset) }))
      const { shown } = takeLines(lines, maxChars)
      const end = page.offset + shown.length
      const footer =
        end < page.total ? `共 ${page.total} 条，显示第 ${page.offset + 1}-${end} 条；用 offset=${end} 查看下一页。` : `共 ${page.total} 条，已全部显示。`
      return `${shown.join('\n')}\n${footer}`
    },
  })
}
