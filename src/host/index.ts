import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { compactRepeats, oneLine } from '../tools/data/format.ts'
import { stripReplyPrefix } from '../analysis/text.ts'
import { getEvidence } from '../dataset/evidence.ts'
import { findCitations } from '../dataset/query.ts'
import type { Dataset } from '../dataset/types.ts'
import { applyMapping, formatReport } from '../ingest/apply.ts'
import { addCacheRule } from '../ingest/cache.ts'
import { readInput } from '../ingest/formats.ts'
import { ImportError, loadDataset } from '../ingest/index.ts'
import { mappingSchema } from '../ingest/mapping.ts'
import { describeShape, type Shape } from '../ingest/shape.ts'
import type { Chunk } from '../pipeline/chunk.ts'

/**
 * 宿主模型模式：需要模型判断的步骤（结构识别、分块总结、合并成报告）交给 Claude Code、Codex 等宿主自己的模型，
 * 这里只做确定性的部分，全程不读取 ugc-lens 的模型配置。设计见 docs/architecture.md 第 2.9 节。
 */

/** 与 loadDataset 相同的指纹规则：表格的表头参与指纹 */
async function inputShape(file: string): Promise<{ data: unknown; shape: Shape; builtin: boolean; tabular: boolean }> {
  const input = await readInput(resolve(file))
  let shape = describeShape(input.data)
  const tabular = input.format === 'csv' || input.format === 'tsv'
  if (tabular) shape = { ...shape, fingerprint: createHash('sha256').update(shape.fingerprint + JSON.stringify((input.data as { columns: unknown }).columns)).digest('hex').slice(0, 16) }
  return { data: input.data, shape, builtin: input.builtin !== undefined, tabular }
}

export interface SourceDescription {
  file: string
  /** 不需要模型即可导入：内置格式、内置规则或已有缓存规则 */
  mapped: boolean
  source?: 'builtin' | 'cache'
  /** 未映射时，交给宿主写规则的结构摘要 */
  shape?: string
  tabular?: boolean
}

/** 判断文件能否不经模型直接导入；不能时返回结构摘要，供宿主按 mappingSchema 写规则 */
export async function describeSource(file: string, cacheDir: string): Promise<SourceDescription> {
  try {
    const dataset = await loadDataset(file, { cacheDir })
    return { file: dataset.file_path, mapped: true, source: dataset.mapping.builtin ? 'builtin' : 'cache' }
  } catch (error) {
    if (!(error instanceof ImportError) || error.code !== 'no_model') throw error
  }
  const { shape, tabular } = await inputShape(file)
  return { file: resolve(file), mapped: false, shape: shape.text, tabular }
}

export interface MappingSubmission { ok: boolean; report: string }

/** 校验宿主写的规则并试转换全部数据；通过后写入映射缓存，之后导入同结构文件不再需要模型 */
export async function submitMapping(file: string, rule: unknown, cacheDir: string): Promise<MappingSubmission> {
  const parsed = mappingSchema.safeParse(rule)
  if (!parsed.success) {
    return { ok: false, report: `规则不符合格式：\n${parsed.error.issues.map((issue) => `- ${issue.path.join('.') || '(根)'}：${issue.message}`).join('\n')}` }
  }
  const absolute = resolve(file)
  const { data, shape } = await inputShape(absolute)
  const result = applyMapping(data, parsed.data, { file_path: absolute, arrays: shape.arrays })
  const report = formatReport(result.report)
  if (result.report.errors.length || result.items.length === 0 && !result.contents.some((c) => c.transcript?.length)) {
    return { ok: false, report: result.report.errors.length ? report : `${report}\n没有导入任何文本，请检查 collections 的路径和 text 字段` }
  }
  await addCacheRule(cacheDir, shape.fingerprint, { created_at: new Date().toISOString(), file_name: basename(absolute), outcome: { type: 'mapping', mapping: parsed.data } })
  return { ok: true, report }
}

const LABEL = /^(\s*↳?)\[(\d+)\]/
const SAME_AS = /同文于\[(\d+)\]/g

/** 分块里的块内编号 [1]、[2]… 换回原 ID，宿主写报告时直接引用原 ID */
export function hostChunkText(chunk: Chunk, total: number): string {
  const real = (n: string) => chunk.ids[Number(n) - 1] ?? n
  const kind = chunk.kind === 'danmaku' ? '弹幕' : chunk.kind === 'transcript' ? '源内容字幕' : '评论与回复'
  const lines = chunk.lines.map((line) => line.replace(LABEL, (_, prefix: string, n: string) => `${prefix}[${real(n)}]`).replace(SAME_AS, (_, n: string) => `同文于[${real(n)}]`))
  return `# 第 ${chunk.index + 1}/${total} 块（${kind}，${chunk.ids.length} 条，代表 ${chunk.represents} 条原始内容）\n\n${lines.join('\n')}\n`
}

const QUOTE_PAIRS: Record<string, string> = { '"': '"', '“': '”', '「': '」', '『': '』' }
const CITATION = /\[([^[\]\s]{1,64})\](?!\()/g

const normalize = (text: string) => text.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

/** 摘句可用 … 或 ... 省略中间部分，各段须按顺序出现在原文（或分块里显示的压缩文本）中 */
function quoteFound(quote: string, text: string): boolean {
  return [text, compactRepeats(oneLine(stripReplyPrefix(text)))].some((candidate) => {
    const source = normalize(candidate)
    let from = 0
    for (const fragment of normalize(quote).split(/\s*(?:…|\.\.\.)\s*/).filter(Boolean)) {
      const at = source.indexOf(fragment, from)
      if (at < 0) return false
      from = at + fragment.length
    }
    return true
  })
}

function quoteBefore(prefix: string): string | undefined {
  const trimmed = prefix.trimEnd()
  const close = trimmed.at(-1)
  const open = Object.entries(QUOTE_PAIRS).find(([, c]) => c === close)?.[0]
  if (!open) return undefined
  const start = trimmed.lastIndexOf(open, trimmed.length - 2)
  return start < 0 ? undefined : trimmed.slice(start + 1, -1)
}

function quoteSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (let i = 0; i < line.length; i++) {
    const close = QUOTE_PAIRS[line[i]!]
    if (!close) continue
    const end = line.indexOf(close, i + 1)
    if (end < 0) break
    spans.push([i, end])
    i = end
  }
  return spans
}

export interface ReportCheck {
  ok: boolean
  /** 报告中出现、数据里存在的 ID */
  cited: number
  invalid_ids: string[]
  quotes_checked: number
  quote_mismatches: Array<{ id: string; quote: string; line: number }>
}

/** 核对宿主写的报告：引用的 ID 必须存在，紧挨引用前的 "摘句" 必须出现在该条原文里 */
export function checkReport(markdown: string, dataset: Dataset): ReportCheck {
  const { valid, invalid } = findCitations(markdown, [dataset])
  const mismatches: ReportCheck['quote_mismatches'] = []
  let quotesChecked = 0
  for (const [i, line] of markdown.split(/\r\n|\n|\r/).entries()) {
    const spans = quoteSpans(line)
    for (const match of line.matchAll(CITATION)) {
      if (spans.some(([from, to]) => match.index > from && match.index < to)) continue
      const evidence = getEvidence(dataset, match[1]!)
      if (!evidence) continue
      const quote = quoteBefore(line.slice(0, match.index))
      if (quote === undefined) continue
      quotesChecked++
      if (!quoteFound(quote, evidence.text)) mismatches.push({ id: match[1]!, quote, line: i + 1 })
    }
  }
  return { ok: valid.length > 0 && invalid.length === 0 && mismatches.length === 0, cited: valid.length, invalid_ids: invalid, quotes_checked: quotesChecked, quote_mismatches: mismatches }
}
