import { basename } from 'node:path'
import type { DanmakuSummary } from '../analysis/danmaku.ts'
import type { TermStat } from '../analysis/keywords.ts'
import { dedupeKey, stripReplyPrefix } from '../analysis/text.ts'
import { getFeedback } from '../dataset/query.ts'
import type { DatasetStats } from '../dataset/stats.ts'
import type { Dataset, FeedbackItem } from '../dataset/types.ts'
import type { Usage } from '../llm/types.ts'
import { clock, compactRepeats, oneLine, sliceText } from '../tools/data/format.ts'
import type { ChunkPlan } from './chunk.ts'
import type { Theme } from './merge.ts'

export interface ReportRunInfo {
  playbook?: { version: number; hash: string }
  generated_at: Date
  duration_ms: number
  calls: number
  usage: Required<Usage>
  model?: string
  total_chunks: number
  /** 失败或被跳过的块数，大于 0 时报告里说明覆盖不完整 */
  incomplete_chunks: number
}

export interface ReportInput {
  dataset: Dataset
  stats: DatasetStats
  coverage: ChunkPlan['coverage']
  keywords: readonly TermStat[]
  danmaku?: DanmakuSummary
  themes: readonly Theme[]
  directions: readonly string[]
  run: ReportRunInfo
}

const QUOTE_CHARS = 120
const QUOTES_PER_THEME = 3
const QUOTES_PER_CHILD = 2

const n = (value: number) => value.toLocaleString('zh-CN')
const percent = (part: number, total: number) => `${total > 0 ? Math.round((part / total) * 100) : 0}%`

function reportTitle(dataset: Dataset): string {
  const titles = dataset.contents.map((c) => c.title).filter((t): t is string => Boolean(t))
  if (titles.length === 1) return `《${titles[0]}》分析报告`
  if (titles.length > 1) return `${titles.length} 个内容的分析报告`
  return `${basename(dataset.file_path)} 分析报告`
}

/** 复读的内容只显示一条，后面注明有多少条按 dedupeKey 算是同一句的 */
function repeatCounter(dataset: Dataset): (item: FeedbackItem) => number {
  const counts = new Map<string, number>()
  const keyOf = (item: FeedbackItem) => `${item.kind === 'danmaku' ? 'd' : 'c'}:${dedupeKey(item.text)}`
  for (const item of dataset.items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1)
  return (item) => counts.get(keyOf(item)) ?? 1
}

function inline(text: string, max: number): string {
  const value = compactRepeats(oneLine(stripReplyPrefix(text))).trim()
  return value.length > max ? `${sliceText(value, max)}…` : value
}

function quoteLine(ref: Theme['refs'][number], dataset: Dataset, repeats: (item: FeedbackItem) => number, indent: string): string | undefined {
  const item = getFeedback(dataset, ref.id)
  if (!item) return undefined
  const meta = [
    item.author?.name,
    item.author?.location,
    item.likes ? `赞 ${n(item.likes)}` : undefined,
    item.kind === 'danmaku' && item.video_time_sec !== undefined ? `弹幕 ${clock(item.video_time_sec)}` : undefined,
  ].filter(Boolean)
  const count = repeats(item)
  const same = count > 1 ? `（类似内容 ${n(count)} 条）` : ''
  const text = ref.quote ? `……${ref.quote}……` : inline(item.text, QUOTE_CHARS)
  return `${indent}> ${text}${same}${meta.length > 0 ? ` —— ${meta.join(' · ')}` : ''} \`${item.id}\``
}

function topRefs(theme: Theme, dataset: Dataset, limit: number): Theme['refs'] {
  return [...theme.refs]
    .sort((a, b) => (getFeedback(dataset, b.id)?.likes ?? 0) - (getFeedback(dataset, a.id)?.likes ?? 0))
    .slice(0, limit)
}

function overview(input: ReportInput): string[] {
  const { stats, coverage: c, danmaku } = input
  const lines = ['## 概况', '']
  const kinds = [
    stats.items.comment ? `评论 ${n(stats.items.comment)} 条` : '',
    stats.items.answer ? `回答 ${n(stats.items.answer)} 条` : '',
    stats.items.reply ? `回复 ${n(stats.items.reply)} 条` : '',
    stats.items.danmaku ? `弹幕 ${n(stats.items.danmaku)} 条` : '',
  ].filter(Boolean)
  lines.push(`- 互动内容：${kinds.join('、') || '无'}`)
  if (stats.replies.reported > stats.replies.collected) {
    lines.push(`- 回复：平台显示 ${n(stats.replies.reported)} 条，搜集到 ${n(stats.replies.collected)} 条`)
  }
  if (stats.time_range) lines.push(`- 发布时间：${stats.time_range.from.slice(0, 10)} ~ ${stats.time_range.to.slice(0, 10)}`)
  if (c.items_total > 0) {
    const notes = [
      c.sampled ? '内容较多，按热度保留一部分、其余随机抽样' : '',
      c.threads_merged > 0 ? `内容相同的一级评论合并了 ${n(c.threads_merged)} 条` : '',
      c.low_info > 0 ? `很短的内容（如“哈哈”“666”）${n(c.low_info)} 条只计数` : '',
    ].filter(Boolean)
    lines.push(`- 分析范围：评论和回复 ${n(c.items_included)}/${n(c.items_total)} 条（${percent(c.items_included, c.items_total)}）${notes.length > 0 ? `；${notes.join('；')}` : ''}`)
  }
  if (danmaku && danmaku.total > 0) {
    lines.push(`- 弹幕：去重后 ${n(c.danmaku_unique)} 种，分析了重复最多的 ${n(c.danmaku_groups_included)} 种，代表 ${n(c.danmaku_represented)} 条（${percent(c.danmaku_represented, c.danmaku_total)}）`)
  }
  if (stats.with_location > 0 && stats.locations.length > 0) {
    const top = stats.locations.slice(0, 8).map((l) => `${l.name} ${percent(l.count, stats.with_location)}`)
    lines.push(`- IP 属地（${n(stats.with_location)} 条有属地）：${top.join('、')}`)
  }
  return lines
}

function keywordSection(keywords: readonly TermStat[], danmaku: DanmakuSummary | undefined): string[] {
  const lines: string[] = []
  const format = (terms: readonly TermStat[]) => terms.map((t) => `${t.word}（${n(t.docs)}）`).join('、')
  if (keywords.length > 0) lines.push(`- 评论：${format(keywords)}`)
  if (danmaku && danmaku.terms.length > 0) lines.push(`- 弹幕：${format(danmaku.terms)}`)
  return lines.length > 0 ? ['## 关键词', '', '括号里是包含这个词的条数。', '', ...lines] : []
}

function peakSection(danmaku: DanmakuSummary | undefined): string[] {
  if (!danmaku || danmaku.peaks.length === 0) return []
  const lines = ['## 弹幕高峰', '', '| 时段 | 弹幕数 | 平时每段 | 重复最多的弹幕 | 这段特有的词 |', '|---|---|---|---|---|']
  const cell = (text: string) => text.replace(/\|/g, '｜')
  for (const peak of [...danmaku.peaks].sort((a, b) => a.start_sec - b.start_sec)) {
    const groups = peak.groups.slice(0, 3).map((g) => `${inline(g.text, 20)}×${g.count}`).join('，')
    const terms = peak.terms.slice(0, 5).map((t) => t.word).join('、')
    lines.push(`| ${clock(peak.start_sec)}–${clock(peak.end_sec)} | ${n(peak.count)} | ${peak.baseline.toFixed(1)} | ${cell(groups)} | ${cell(terms) || '—'} |`)
  }
  return lines
}

function themeSections(input: ReportInput): string[] {
  const { dataset } = input
  const repeats = repeatCounter(dataset)
  const lines: string[] = []
  for (const direction of input.directions) {
    const themes = input.themes.filter((t) => t.direction === direction)
    if (themes.length === 0) continue
    lines.push(`## ${direction}`, '')
    themes.forEach((theme, i) => {
      lines.push(`### ${i + 1}. ${theme.title}（约 ${n(theme.support)} 条）`, '')
      for (const ref of topRefs(theme, dataset, QUOTES_PER_THEME)) {
        const line = quoteLine(ref, dataset, repeats, '')
        if (line) lines.push(line, '')
      }
      for (const child of theme.children) {
        lines.push(`- **${child.title}**（约 ${n(child.support)} 条）`, '')
        for (const ref of topRefs(child, dataset, QUOTES_PER_CHILD)) {
          const line = quoteLine(ref, dataset, repeats, '  ')
          if (line) lines.push(line, '')
        }
      }
    })
  }
  if (lines.length === 0) lines.push('## 观点', '', '没有找到有足够内容支持的观点。', '')
  return lines
}

function runSection(run: ReportRunInfo): string[] {
  const u = run.usage
  const lines = [
    '## 运行信息',
    '',
    ...(run.playbook ? [`- 分析手册：版本 ${run.playbook.version}，指纹 ${run.playbook.hash}`] : []),
    `- 生成时间：${run.generated_at.toLocaleString('zh-CN', { hour12: false })}${run.model ? `，模型 ${run.model}` : ''}`,
    `- 耗时 ${(run.duration_ms / 1000).toFixed(1)} 秒，调用模型 ${run.calls} 次`,
    `- token：输入 ${n(u.input_tokens)}（缓存命中 ${n(u.cached_input_tokens)}），输出 ${n(u.output_tokens)}`,
  ]
  if (run.incomplete_chunks > 0) {
    lines.push(`- ${run.total_chunks} 块里有 ${run.incomplete_chunks} 块没有完成，上面的观点只基于其余部分`)
  }
  lines.push(`- 支持条数是模型按块估计后相加的，只表示大致规模`)
  return lines
}

export function renderReport(input: ReportInput): string {
  const { dataset } = input
  const header = [`# ${reportTitle(dataset)}`, '']
  const content = dataset.contents.length === 1 ? dataset.contents[0] : undefined
  const meta = [dataset.platform, content?.author, content?.published_at?.slice(0, 10), content?.url].filter(Boolean)
  if (meta.length > 0) header.push(meta.join(' · '), '')
  const sections = [overview(input), keywordSection(input.keywords, input.danmaku), peakSection(input.danmaku), themeSections(input), runSection(input.run)]
  return [...header, ...sections.filter((s) => s.length > 0).flatMap((s) => [...s, ''])].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
