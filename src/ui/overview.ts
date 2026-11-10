import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { summarizeDanmaku } from '../analysis/danmaku.ts'
import { countTerms, createTokenizerFor, topTerms } from '../analysis/keywords.ts'
import { searchFeedback } from '../dataset/query.ts'
import { computeStats } from '../dataset/stats.ts'
import type { Dataset, FeedbackItem } from '../dataset/types.ts'

/** 页面用的条目摘要：只给展示需要的字段 */
export function itemView(item: FeedbackItem) {
  return {
    id: item.id, kind: item.kind, text: item.text, parent_id: item.parent_id, content_id: item.content_id,
    likes: item.likes, reply_count: item.reply_count, created_at: item.created_at, video_time_sec: item.video_time_sec,
    author: item.author?.name, location: item.author?.location,
  }
}

/** 按天统计发布时间（评论、回复、回答、记录），弹幕没有发布时间 */
export function dailyCounts(dataset: Dataset): Array<{ day: string; count: number }> {
  const days = new Map<string, number>()
  for (const item of dataset.items) {
    if (!item.created_at || item.kind === 'danmaku') continue
    const day = item.created_at.slice(0, 10)
    days.set(day, (days.get(day) ?? 0) + 1)
  }
  return [...days].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day))
}

// 已有的宿主模式标注结果（labels-<任务>/result.json），只取汇总，不带逐条记录
export async function labelSummaries(cwd: string, datasetId: string): Promise<Array<{ task: string; dir: string; summary: unknown; counts: unknown; coverage: number }>> {
  const base = join(cwd, '.ugc-lens', 'host', datasetId)
  const names = await readdir(base).catch(() => [] as string[])
  const out = []
  for (const name of names.filter((n) => n.startsWith('labels-')).sort()) {
    const path = join(base, name, 'result.json')
    try {
      if (!(await stat(path)).isFile()) continue
      const result = JSON.parse(await readFile(path, 'utf8')) as { task: string; summary: { records?: unknown }; counts: unknown; coverage: number }
      const { records: _records, ...summary } = result.summary
      out.push({ task: result.task, dir: join(base, name), summary, counts: result.counts, coverage: result.coverage })
    } catch { /* 损坏或未完成的结果不展示 */ }
  }
  return out
}

export async function buildOverview(dataset: Dataset, cwd: string) {
  const stats = computeStats(dataset, { topLocations: 15 })
  const { tokenizer } = createTokenizerFor(dataset.items.map((item) => item.text))
  const keywords = topTerms(countTerms(dataset.items.filter((item) => item.kind !== 'danmaku'), tokenizer), 30)
  const danmaku = stats.items.danmaku > 0 ? summarizeDanmaku(dataset.items, tokenizer) : undefined
  const top = searchFeedback(dataset, { kinds: ['comment', 'answer', 'record'], sort: 'likes', limit: 8 }).items
  return {
    id: dataset.id,
    platform: dataset.platform,
    file: dataset.file_path,
    mapping: dataset.mapping.builtin ? 'builtin' : dataset.mapping.from_cache ? 'cache' : 'model',
    contents: dataset.contents.map((c) => ({ id: c.id, title: c.title, author: c.author, published_at: c.published_at, url: c.url, description: c.description, stats: c.stats, transcript_lines: c.transcript?.length ?? 0 })),
    stats,
    daily: dailyCounts(dataset),
    keywords,
    danmaku: danmaku && {
      total: danmaku.total, unique: danmaku.unique, bin_sec: danmaku.bin_sec, timeline: danmaku.timeline, terms: danmaku.terms.slice(0, 20),
      groups: danmaku.groups.slice(0, 12),
      peaks: danmaku.peaks.map((p) => ({ start_sec: p.start_sec, end_sec: p.end_sec, count: p.count, baseline: p.baseline, groups: p.groups.slice(0, 3), terms: p.terms.slice(0, 5) })),
    },
    top: top.map(itemView),
    // 宿主模式结果在运行 host 命令的目录下：启动目录和数据文件所在目录都找
    labels: [...new Set([cwd, dirname(dataset.file_path)])].length === 1
      ? await labelSummaries(cwd, dataset.id)
      : [...await labelSummaries(cwd, dataset.id), ...await labelSummaries(dirname(dataset.file_path), dataset.id)],
  }
}
