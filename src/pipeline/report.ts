import type { TaskUsage } from '../agent/usage.ts'
import { basename } from 'node:path'
import type { DanmakuSummary } from '../analysis/danmaku.ts'
import type { TermStat } from '../analysis/keywords.ts'
import { dedupeKey, stripReplyPrefix } from '../analysis/text.ts'
import { getEvidence } from '../dataset/evidence.ts'
import type { DatasetStats } from '../dataset/stats.ts'
import type { Dataset, FeedbackItem } from '../dataset/types.ts'
import type { Usage } from '../llm/types.ts'
import { clock, compactRepeats, oneLine, sliceText } from '../tools/data/format.ts'
import type { ChunkPlan } from './chunk.ts'
import type { InsightsResult } from './insights.ts'
import type { RecheckResult } from './recheck.ts'
import type { Theme } from './merge.ts'
import type { analysisCoverage } from '../analysis/coverage.ts'
import { contentTimeline, contentTimelineRows } from '../analysis/content_timeline.ts'
import { formatCachedTokens } from '../llm/usage.ts'

export interface ReportRunInfo {
  task_usage?: TaskUsage
  playbook?: { version: number; hash: string }
  generated_at: Date
  duration_ms: number
  calls: number
  usage: Usage
  model?: string
  total_chunks: number
  /** 失败或被跳过的块数，大于 0 时报告里说明覆盖不完整 */
  incomplete_chunks: number
}

export interface ReportInput {
  insights?: InsightsResult
  recheck?: RecheckResult
  scenario?: { id: string; title: string; hash: string }
  ledger?: ReturnType<typeof analysisCoverage>
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
const cell = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')

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

function inline(text: string, max: number, stripPrefix = true): string {
  const value = compactRepeats(oneLine(stripPrefix ? stripReplyPrefix(text) : text)).trim()
  return value.length > max ? `${sliceText(value, max)}…` : value
}

function quoteLine(ref: Theme['refs'][number], dataset: Dataset, repeats: (item: FeedbackItem) => number, indent: string): string | undefined {
  const item = getEvidence(dataset, ref.id)
  if (!item) return undefined
  const meta = [
    item.author?.name,
    item.author?.location,
    item.likes ? `赞 ${n(item.likes)}` : undefined,
    item.kind === 'danmaku' && item.video_time_sec !== undefined ? `弹幕 ${clock(item.video_time_sec)}` : undefined,
  ].filter(Boolean)
  const count = item.kind === 'transcript' ? 1 : repeats({ ...item, kind: item.kind })
  const same = count > 1 ? `（类似内容 ${n(count)} 条）` : ''
  const text = ref.quote ? `……${ref.quote}……` : inline(item.text, QUOTE_CHARS, item.kind !== 'record')
  return `${indent}> ${text}${same}${meta.length > 0 ? ` —— ${meta.join(' · ')}` : ''} \`${item.id}\``
}

function topRefs(theme: Theme, dataset: Dataset, limit: number): Theme['refs'] {
  return [...theme.refs]
    .sort((a, b) => (getEvidence(dataset, b.id)?.likes ?? 0) - (getEvidence(dataset, a.id)?.likes ?? 0))
    .slice(0, limit)
}

function overview(input: Pick<ReportInput, 'stats' | 'coverage' | 'danmaku'>): string[] {
  const { stats, coverage: c, danmaku } = input
  const lines = ['## 概况', '']
  const kinds = [
    stats.items.record ? `记录 ${n(stats.items.record)} 条` : '',
    stats.items.comment ? `评论 ${n(stats.items.comment)} 条` : '',
    stats.items.answer ? `回答 ${n(stats.items.answer)} 条` : '',
    stats.items.reply ? `回复 ${n(stats.items.reply)} 条` : '',
    stats.items.danmaku ? `弹幕 ${n(stats.items.danmaku)} 条` : '',
  ].filter(Boolean)
  const generic = (stats.items.record ?? 0) > 0
  lines.push(`- ${generic ? '文本记录' : '互动内容'}：${kinds.join('、') || '无'}`)
  if (stats.replies.reported > 0 || stats.replies.collected > 0) {
    lines.push(`- 已采集主评论下标注的回复数合计 ${n(stats.replies.reported)} 条，本次导入回复 ${n(stats.replies.collected)} 条；不代表全视频回复覆盖率，导入回复可能含孤立回复。`)
  }
  if (stats.time_range) lines.push(`- 发布时间：${stats.time_range.from.slice(0, 10)} ~ ${stats.time_range.to.slice(0, 10)}`)
  if (c.items_total > 0) {
    const notes = [
      c.sampled ? '内容较多，按热度保留一部分、其余随机抽样' : '',
      c.threads_merged > 0 ? `内容相同的${generic ? '记录' : '一级评论'}合并了 ${n(c.threads_merged)} 条` : '',
      c.low_info > 0 ? `很短的内容（如“哈哈”“666”）${n(c.low_info)} 条只计数` : '',
    ].filter(Boolean)
    lines.push(`- 分析范围：${generic ? '文本记录' : '评论和回复'} ${n(c.items_included)}/${n(c.items_total)} 条（${percent(c.items_included, c.items_total)}）${notes.length > 0 ? `；${notes.join('；')}` : ''}`)
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

function keywordSection(keywords: readonly TermStat[], danmaku: DanmakuSummary | undefined, generic = false): string[] {
  const lines: string[] = []
  const format = (terms: readonly TermStat[]) => terms.map((t) => `${t.word}（${n(t.docs)}）`).join('、')
  if (keywords.length > 0) lines.push(`- ${generic ? '文本记录' : '评论'}：${format(keywords)}`)
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
      lines.push(`### ${i + 1}. ${theme.title}（模型估计涉及约 ${n(theme.support)} 条，非逐条分类结果）`, '')
      for (const ref of topRefs(theme, dataset, QUOTES_PER_THEME)) {
        const line = quoteLine(ref, dataset, repeats, '')
        if (line) lines.push(line, '')
      }
      for (const child of theme.children) {
        lines.push(`- **${child.title}**（模型估计涉及约 ${n(child.support)} 条，非逐条分类结果）`, '')
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
    `- token：输入 ${n(u.input_tokens)}（缓存命中 ${formatCachedTokens(u)}），输出 ${n(u.output_tokens)}`,
  ]
  if (run.task_usage) lines.push(`- 本任务内部调用 ${run.task_usage.calls.length} 次，已知 token ${run.task_usage.known_tokens}，用量未知 ${run.task_usage.unknown_calls} 次；软预算 ${run.task_usage.token_budget}，在途请求和最多一次收尾可能超出；不含 MCP 宿主用量。`)
  if (run.incomplete_chunks > 0) {
    lines.push(`- ${run.total_chunks} 块里有 ${run.incomplete_chunks} 块没有完成，上面的观点只基于其余部分`)
  }
  lines.push(`- 支持条数是模型按块估计后相加的，只表示大致规模`)
  return lines
}

function recheckLines(recheck: RecheckResult | undefined, index: number, dataset: Dataset, repeats: (item: FeedbackItem) => number): string[] {
  if (!recheck) return []
  const item = recheck.items.find((i) => i.index === index)
  if (!item) return []
  const terms = item.queries.map((q) => `「${q}」`).join('')
  if (!item.queries.length) return ['**补查**：模型未给出补查关键词，未补查。', '']
  if (item.status === 'no_candidates') {
    return [item.matched
      ? `**补查**：用 ${terms} 在评论、回复和记录中检索到 ${n(item.matched)} 条，均已在本发现中引用，没有其他可核对的原文。`
      : `**补查**：用 ${terms} 在评论、回复和记录中未检索到原文（放宽为任一词出现后仍无结果），关键词可能过窄，未能补查。`, '']
  }
  const scope = `用 ${terms}${item.relaxed ? '（原条件可核对原文不足，已补充任一词出现的结果）' : ''} 在评论、回复和记录中检索到 ${n(item.matched)} 条`
  if (item.status === 'failed') return [`**补查**：${scope}，补查未完成（${recheck.error ?? '未知原因'}），以上发现未经补查。`, '']
  const found = item.contradicts.length + item.qualifies.length
  const lines = [`**补查**：${scope}，按点赞核对其中 ${n(item.candidates)} 条未引用原文：反例 ${item.contradicts.length} 条、限定 ${item.qualifies.length} 条、支持 ${item.supports} 条${found ? '。' : '；这些关键词的检索范围内未发现反例或限定，不代表不存在。'}`, '']
  for (const [label, refs] of [['反例', item.contradicts], ['限定', item.qualifies]] as const) {
    for (const ref of refs) {
      const line = quoteLine({ id: ref.id, quote: ref.quote }, dataset, repeats, '')
      if (line) lines.push(`${label}${ref.note ? `（${ref.note}）` : ''}：`, '', line, '')
    }
  }
  return lines
}

function headerLines(input: Pick<ReportInput, 'dataset' | 'scenario' | 'directions'>, title = reportTitle(input.dataset)): string[] {
  const { dataset } = input
  const header = [`# ${title}`, '']
  const content = dataset.contents.length === 1 ? dataset.contents[0] : undefined
  const meta = [dataset.platform, content?.author, content?.published_at?.slice(0, 10), content?.url].filter(Boolean)
  if (meta.length > 0) header.push(meta.join(' · '), '')
  if (input.scenario) header.push(`分析场景：${input.scenario.title}（场景手册 ${input.scenario.id}，指纹 ${input.scenario.hash}）`, '')
  if (input.directions.length) header.push(`分析方向：${input.directions.join('、')}`, '')
  return header
}

function timelineSections(dataset: Dataset): { timelineLines: string[]; fullTimeline: string[] } {
  const timeline = contentTimeline(dataset, { limit: 12, selection: 'key' })
  const timelineRow = (row: (typeof timeline.rows)[number]) => `| ${cell(row.title ?? row.content_id)} | ${row.start_sec}–${row.end_sec}${row.peak ? '（高峰）' : ''} | ${row.count} | ${row.transcript.length ? row.transcript.map((t) => `${cell(t.text)} [${cell(t.ref)}]`).join('；') : '未提供对应字幕，不猜测内容'} | ${row.feedback.map((f) => `${cell(f.text)} [${cell(f.id)}]`).join('；')} |`
  const table = ['| 内容 | 视频秒数 | 弹幕数 | 字幕原文及位置 | 观众反应及 ID |', '|---|---|---:|---|---|']
  const timelineLines = timeline.rows.length ? ['## 字幕与观众反应时间轴', '', '优先选择高峰和弹幕较多的关键窗口，再按内容和时间展示；时间对齐不代表因果关系，也不代表已观看视频画面。', '', ...table, ...timeline.rows.map(timelineRow), '', '每窗最多摘录 10 段字幕与 5 条弹幕，每条最多 500 字；未在此展示的窗口见完整时间轴附录，原文可按 ID 查询。', ''] : []
  const fullTimeline: string[] = []
  if (timeline.next_offset !== null) {
    fullTimeline.push('## 附录：完整时间轴', '', '全部窗口按内容和时间排列；每窗证据仍为摘录。', '', ...table)
    fullTimeline.push(...contentTimelineRows(dataset).map(timelineRow))
    fullTimeline.push('')
  }
  return { timelineLines, fullTimeline }
}

export type FactsInput = Pick<ReportInput, 'dataset' | 'stats' | 'coverage' | 'keywords' | 'danmaku' | 'directions' | 'scenario'>

/** 宿主模型模式的“事实”部分：只含代码算出的统计、关键词、弹幕高峰和时间轴，不含任何模型结论 */
export function renderFacts(input: FactsInput): string {
  const { timelineLines, fullTimeline } = timelineSections(input.dataset)
  const content = input.dataset.contents.map((c) => [c.title ? `- 标题：${c.title}（${c.id}）` : `- 内容 ${c.id}`, c.description ? `  - 简介：${inline(c.description, 300, false)}` : '', c.summary ? `  - 平台摘要：${inline(c.summary, 500, false)}` : ''].filter(Boolean)).flat()
  const sections = [content.length ? ['## 内容信息', '', ...content] : [], overview(input), keywordSection(input.keywords, input.danmaku, (input.stats.items.record ?? 0) > 0), peakSection(input.danmaku), timelineLines, fullTimeline]
  return [...headerLines(input, `${reportTitle(input.dataset).replace(/分析报告$/, '')}数据概况`), ...sections.filter((s) => s.length > 0).flatMap((s) => [...s, ''])].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export function renderReport(input: ReportInput): string {
  const { dataset } = input
  const header = headerLines(input)
  const ledger = input.ledger ? ['## 处理覆盖记录', '', '| 类型 | 导入 | 重复正文信号 | 成功块内 | 失败块内 | 跳过块内 | 未选择 |', '|---|---:|---:|---:|---:|---:|---:|', ...input.ledger.kinds.map((r) => `| ${r.kind} | ${r.imported} | ${r.duplicate_texts} | ${r.processed} | ${r.failed} | ${r.skipped} | ${r.not_selected} |`), '', '成功块内表示原文进入已完成的总结块，不代表已逐条分类；重复计数不参与总数相加。导入路径跳过数：' + input.ledger.collections.reduce((s, r) => s + r.skipped, 0), ''] : []
  if (input.ledger) ledger.push('### 正文字幕覆盖', '', '| 内容 | 源/转换状态 | 源段数 | 转换失败 | 已导入 | 已提交模型 | 成功块内 | 失败块内 | 跳过 | 未选择 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...input.ledger.transcripts.map((r) => `| ${cell(r.content_id)} | ${r.source_status} | ${r.source_elements ?? '未知'} | ${r.conversion_failed ?? '未知'} | ${r.imported} | ${r.submitted} | ${r.processed} | ${r.failed} | ${r.skipped} | ${r.not_selected} |`), '', '未配置字幕映射且无导入片段时，源状态为未知，不能据此声称源中没有字幕。', '')
  const { timelineLines, fullTimeline } = timelineSections(dataset)
  const conclusions = ['## 核心结论', '']
  const insights = input.insights?.insights ?? []
  if (!insights.length) conclusions.push('本次未形成通过引用校验的核心发现；附录保留分块主题，尚未完成综合核对。', '')
  else {
    conclusions.push('以下为基于候选主题所附原文的模型综合判断，未覆盖全量逐条分类；意义属于分析推断，待验证事项不代表已证实。', '')
    for (const [i, insight] of insights.entries()) conclusions.push(`${i + 1}. **${insight.finding}**`, '')
    const repeats = repeatCounter(dataset)
    for (const [i, insight] of insights.entries()) {
      conclusions.push(`### 发现 ${i + 1}：${insight.finding}`, '')
      for (const [label, groups] of [['证据', insight.evidence], ['反例/分歧', insight.counterevidence]] as const) {
        conclusions.push(`**${label}**${groups.length ? '' : '：当前展示证据中未发现，不代表不存在。'}`, '')
        for (const group of groups) {
          conclusions.push(group.point, '')
          for (const ref of group.refs) {
            const line = quoteLine(ref, dataset, repeats, '')
            if (line) conclusions.push(line, '')
          }
        }
      }
      conclusions.push(`**证据强弱与边界**：${insight.boundary}`, '', `**意义（分析推断）**：${insight.meaning}`, '', `**待验证事项**：${insight.verify}`, '')
      conclusions.push(...recheckLines(input.recheck, i, dataset, repeats))
    }
  }
  const sections = [conclusions, timelineLines, ['## 附录：统计与处理范围', ''], overview(input), ledger, keywordSection(input.keywords, input.danmaku, (input.stats.items.record ?? 0) > 0), peakSection(input.danmaku), ...(insights.length ? [] : [['## 附录：分块主题（未综合核对）', ''], themeSections(input)]), fullTimeline, runSection(input.run)]
  return [...header, ...sections.filter((s) => s.length > 0).flatMap((s) => [...s, ''])].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
