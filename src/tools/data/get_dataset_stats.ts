import * as z from 'zod'
import { searchFeedback } from '../../dataset/query.ts'
import { computeStats } from '../../dataset/stats.ts'
import type { DatasetStore } from '../../dataset/store.ts'
import type { ContentInfo, Dataset } from '../../dataset/types.ts'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'
import { formatItem, hasManyContents, takeLines } from './format.ts'
import { DEFAULT_MAX_OUTPUT_CHARS, datasetIdParam, resolveDataset, type DataToolOptions } from './shared.ts'

const MAX_CONTENTS = 10
const SUMMARY_CHARS = 300
const SNIPPET_CHARS = 80

function describeContent(content: ContentInfo, itemCount: number | undefined): string[] {
  const lines = [`- [内容 ${content.id}] ${content.title ?? '（无标题）'}${itemCount === undefined ? '' : `，${itemCount} 条互动内容`}`]
  const meta = [content.author && `作者 ${content.author}`, content.published_at && `发布 ${content.published_at.slice(0, 10)}`]
    .filter(Boolean)
    .join('，')
  if (meta) lines.push(`  ${meta}`)
  if (content.stats) lines.push(`  平台数据：${Object.entries(content.stats).map(([k, v]) => `${k} ${v}`).join('，')}`)
  if (content.summary) {
    const summary = content.summary.length > SUMMARY_CHARS ? `${content.summary.slice(0, SUMMARY_CHARS)}…` : content.summary
    lines.push(`  平台摘要：${summary}`)
  }
  if (content.transcript?.length) lines.push(`  有字幕 ${content.transcript.length} 行`)
  return lines
}

export function formatDatasetStats(dataset: Dataset, maxChars: number): string {
  const stats = computeStats(dataset)
  const lines = [`数据集 ${dataset.id}（${dataset.platform}）`]

  const perContent = new Map<string, number>()
  for (const item of dataset.items) perContent.set(item.content_id, (perContent.get(item.content_id) ?? 0) + 1)
  const contents = [...dataset.contents].sort((a, b) => (perContent.get(b.id) ?? 0) - (perContent.get(a.id) ?? 0))
  lines.push(`\n内容（${contents.length} 个）：`)
  for (const content of contents.slice(0, MAX_CONTENTS)) {
    lines.push(...describeContent(content, hasManyContents(dataset) ? perContent.get(content.id) ?? 0 : undefined))
  }
  if (contents.length > MAX_CONTENTS) lines.push(`……另有 ${contents.length - MAX_CONTENTS} 个内容未列出`)

  const counts = Object.entries(stats.items)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`)
  lines.push(`\n互动内容：${counts.join('，') || '无'}`)
  const { reported, collected } = stats.replies
  if (reported > 0) {
    lines.push(`回复：平台显示 ${reported} 条，实际搜集到 ${collected} 条（${((collected / reported) * 100).toFixed(0)}%），回复是不完整的样本`)
  }
  if (stats.time_range) lines.push(`发布时间：${stats.time_range.from.slice(0, 10)} ~ ${stats.time_range.to.slice(0, 10)}`)
  if (stats.with_location > 0) {
    lines.push(`IP 属地（${stats.with_location} 条有属地）：${stats.locations.map((l) => `${l.name} ${l.count}`).join('，')}`)
  }

  const top = searchFeedback(dataset, { kinds: ['comment', 'answer'], sort: 'likes', limit: 5 })
  if (top.items.length > 0 && top.items[0]?.likes !== undefined) {
    lines.push('\n点赞最多的评论：')
    for (const item of top.items) lines.push(formatItem(item, { maxChars: SNIPPET_CHARS, showContent: hasManyContents(dataset) }))
  }
  lines.push('\n要查看具体内容，用 search_feedback 筛选，或用 get_feedback 按 ID 读取。')

  const { shown, omitted } = takeLines(lines, maxChars)
  return omitted > 0 ? `${shown.join('\n')}\n（结果过长，省略了 ${omitted} 行）` : shown.join('\n')
}

export function createGetDatasetStatsTool(store: DatasetStore, options: DataToolOptions = {}): AgentTool {
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  return defineTool({
    name: 'get_dataset_stats',
    description:
      '数据集概况：被评论的内容（标题、平台数据、平台摘要）、各类互动内容数量、回复搜集比例、时间范围、IP 属地分布、点赞最多的评论。' +
      '分析一个数据集时先调用它。',
    parameters: z.object({ dataset_id: datasetIdParam }),
    async execute({ dataset_id }) {
      return formatDatasetStats(resolveDataset(store, dataset_id), maxChars)
    },
  })
}
