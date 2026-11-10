import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as z from 'zod'
import { seededRandom } from '../analysis/text.ts'
import { BUSINESS_NOTE, businessInstructions, businessRow, rankOpportunities, validateBusinessRow, type BusinessRow } from '../analysis/business.ts'
import { parseTopics, summarizeTopics, topicInstructions, topicRow, topicSchema, validateTopicRow, type TopicDefinition, type TopicRow } from '../analysis/topics.ts'
import type { Dataset, FeedbackItem, FeedbackKind } from '../dataset/types.ts'
import { DEFAULT_SENTIMENT_TARGET, sentimentInstructions, sentimentRow, sentimentStats, type SentimentRecord } from '../sentiment/index.ts'

/**
 * 宿主模型模式的逐条标注：ugc-lens 导出分批原文和规则，宿主逐条写结果，ugc-lens 校验并用与完整流水线相同的代码汇总。
 * 规则文本、行格式、校验和汇总都复用 sentiment / topics / business 模块，两种模式口径一致。
 */

export type LabelTask =
  | { type: 'sentiment'; target: string }
  | { type: 'topics'; topics: TopicDefinition[] }
  | { type: 'business'; goal?: string; background?: string }

const taskFileSchema = z.object({
  version: z.literal(1),
  dataset_id: z.string(),
  file: z.string(),
  task: z.discriminatedUnion('type', [
    z.object({ type: z.literal('sentiment'), target: z.string() }),
    z.object({ type: z.literal('topics'), topics: z.array(topicSchema) }),
    z.object({ type: z.literal('business'), goal: z.string().optional(), background: z.string().optional() }),
  ]),
  scope: z.object({ kinds: z.array(z.string()).nullable(), content_id: z.string().nullable(), sample: z.number().nullable(), seed: z.number(), in_scope: z.number() }),
  batches: z.array(z.object({ file: z.string(), ids: z.array(z.string()) })),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
})
export type LabelTaskFile = z.output<typeof taskFileSchema>

const ROW_FORMATS: Record<LabelTask['type'], string> = {
  sentiment: '{"id":"原ID","score":-1 到 1 的数字或 null,"reason":"依据，200 字以内","mixed":false,"sarcasm":"no|yes|unknown","target":"实际评价对象，可为空"}',
  topics: '{"id":"原ID","topic_ids":["主题ID"],"uncertain":false,"reason":"160 字以内"}',
  business: '{"id":"原ID","opportunities":[{"title":"","problem":"","quote":"原文中逐字出现的摘句","hypothesis":"","validation":"","effort":"","priority":"high|medium|low"}]}（没有信号时 opportunities 为 []，每条最多 2 个）',
}

/** 规则原文面向工具调用，换成写文件的说法；规则本身不改 */
function hostRules(text: string): string {
  return text.replace('调用 submit_sentiment 提交本批全部 ID。', '每批逐条写出全部 ID。').replace('调用 submit_evaluations，所有 ID 必须提交；', '每批所有 ID 都要写一行；').replace('每个 ID 提交一次 submit_evaluations。', '每个 ID 写一行。')
}

function instructions(task: LabelTask): string {
  if (task.type === 'sentiment') return sentimentInstructions(task.target)
  if (task.type === 'topics') return topicInstructions(task.topics)
  return businessInstructions(task.goal, task.background)
}

export interface ExportOptions {
  dataset: Dataset
  task: LabelTask
  outDir: string
  kinds?: readonly FeedbackKind[]
  contentId?: string
  /** 只标注随机抽取的 N 条；用于数据很大时估计比例，结果会注明是样本 */
  sample?: number
  seed?: number
  batchSize?: number
  maxBatchChars?: number
}

const inputRow = (item: FeedbackItem) => ({ id: item.id, kind: item.kind, text: item.text, parent_id: item.parent_id, content_id: item.content_id })

/** 写出 task.md（规则与行格式）、task.json（批次清单）、batches/*.jsonl（待标注原文）和空的 answers/ */
export async function exportLabels(options: ExportOptions): Promise<LabelTaskFile> {
  const task: LabelTask = options.task.type === 'topics' ? { type: 'topics', topics: parseTopics(options.task.topics) } : options.task
  const batchSize = options.batchSize ?? 50
  const maxChars = options.maxBatchChars ?? 12_000
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('batch 必须为 1～200 的整数')
  const seed = options.seed ?? 42
  let items = options.dataset.items.filter((item) => (!options.kinds || options.kinds.includes(item.kind)) && (!options.contentId || item.content_id === options.contentId))
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('数据集存在重复 ID，无法可靠标注')
  const inScope = items.length
  if (options.sample !== undefined && options.sample < items.length) {
    const random = seededRandom(seed)
    const shuffled = [...items]
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(random() * (k + 1))
      ;[shuffled[k], shuffled[j]] = [shuffled[j]!, shuffled[k]!]
    }
    const chosen = new Set(shuffled.slice(0, options.sample).map((item) => item.id))
    items = items.filter((item) => chosen.has(item.id))
  }

  const outDir = resolve(options.outDir)
  await rm(join(outDir, 'batches'), { recursive: true, force: true })
  await mkdir(join(outDir, 'batches'), { recursive: true })
  await mkdir(join(outDir, 'answers'), { recursive: true })
  const skipped: LabelTaskFile['skipped'] = []
  const groups: FeedbackItem[][] = []
  let group: FeedbackItem[] = []
  let chars = 0
  for (const item of items) {
    const size = JSON.stringify(inputRow(item)).length + 1
    if (size > maxChars) { skipped.push({ id: item.id, reason: '原文超过单批字符上限，不截断标注' }); continue }
    if (group.length >= batchSize || chars + size > maxChars) { groups.push(group); group = []; chars = 0 }
    group.push(item)
    chars += size
  }
  if (group.length) groups.push(group)
  const width = Math.max(3, String(groups.length).length)
  const batches: LabelTaskFile['batches'] = []
  for (const [i, current] of groups.entries()) {
    const file = `batches/${String(i + 1).padStart(width, '0')}.jsonl`
    await writeFile(join(outDir, file), current.map((item) => JSON.stringify(inputRow(item))).join('\n') + '\n')
    batches.push({ file, ids: current.map((item) => item.id) })
  }
  const manifest: LabelTaskFile = {
    version: 1, dataset_id: options.dataset.id, file: options.dataset.file_path, task,
    scope: { kinds: options.kinds ? [...options.kinds] : null, content_id: options.contentId ?? null, sample: options.sample ?? null, seed, in_scope: inScope },
    batches, skipped,
  }
  await writeFile(join(outDir, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(outDir, 'task.md'), `# 逐条标注任务：${task.type}

由 ugc-lens 生成。逐个读取 batches/ 下的文件，每读完一批，把结果写到 answers/ 下同名文件（如 batches/001.jsonl → answers/001.jsonl），每行一个 JSON，覆盖该批全部 ID，不重复、不增加批外 ID。全部写完后运行 \`ugc-lens host label-import <数据文件> ${outDir}\`，按返回的 errors 修正后重新导入。

## 规则

${hostRules(instructions(task))}

## 每行格式

${ROW_FORMATS[task.type]}
${options.sample !== undefined && options.sample < inScope ? `\n## 抽样\n\n本任务从范围内 ${inScope} 条中随机抽取 ${items.length} 条（种子 ${seed}），结果只代表样本。\n` : ''}`)
  return manifest
}

type Status = 'processed' | 'failed' | 'skipped'
interface Labeled<T> { id: string; status: Status; value?: T; reason?: string }

export interface ImportResult {
  ok: boolean
  task: LabelTask['type']
  counts: { exported: number; processed: number; invalid: number; missing: number; skipped_long: number; in_scope: number }
  coverage: number
  errors: Array<{ file: string; line: number; id?: string; error: string }>
  summary: unknown
  path: string
}

/** 读回 answers/*.jsonl，逐行校验后按完整流水线相同的口径汇总，结果写到 result.json */
export async function importLabels(dataset: Dataset, dir: string): Promise<ImportResult> {
  const outDir = resolve(dir)
  const manifest = taskFileSchema.parse(JSON.parse(await readFile(join(outDir, 'task.json'), 'utf8')))
  if (manifest.dataset_id !== dataset.id) throw new Error(`标注任务属于数据集 ${manifest.dataset_id}，与当前文件 ${dataset.id} 不一致`)
  const task = manifest.task as LabelTask
  const exported = new Set(manifest.batches.flatMap((b) => b.ids))
  const byId = new Map(dataset.items.map((item) => [item.id, item]))
  const errors: ImportResult['errors'] = []
  const accepted = new Map<string, unknown>()
  const rejected = new Map<string, string>()
  const validateTopic = task.type === 'topics' ? validateTopicRow(task.topics) : undefined
  const row = task.type === 'sentiment' ? sentimentRow : task.type === 'topics' ? topicRow : businessRow

  const files = (await readdir(join(outDir, 'answers')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort()
  for (const name of files) {
    const lines = (await readFile(join(outDir, 'answers', name), 'utf8')).split(/\r?\n/)
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue
      const at = { file: `answers/${name}`, line: i + 1 }
      let value: unknown
      try { value = JSON.parse(line) } catch { errors.push({ ...at, error: '不是有效 JSON' }); continue }
      const id = (value as { id?: unknown } | null)?.id
      const parsed = row.safeParse(value)
      if (!parsed.success) {
        errors.push({ ...at, id: typeof id === 'string' ? id : undefined, error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') })
        if (typeof id === 'string' && exported.has(id)) rejected.set(id, '格式错误')
        continue
      }
      const data = parsed.data as { id: string }
      if (!exported.has(data.id)) { errors.push({ ...at, id: data.id, error: '不是本任务导出的 ID' }); continue }
      if (accepted.has(data.id) || rejected.has(data.id)) { errors.push({ ...at, id: data.id, error: 'ID 重复' }); rejected.set(data.id, 'ID 重复'); accepted.delete(data.id); continue }
      try {
        if (validateTopic) validateTopic(data as TopicRow)
        if (task.type === 'business') validateBusinessRow(data as BusinessRow, byId.get(data.id)!)
      } catch (error) {
        errors.push({ ...at, id: data.id, error: (error as Error).message })
        rejected.set(data.id, (error as Error).message)
        continue
      }
      accepted.set(data.id, data)
    }
  }

  const ordered: Array<Labeled<unknown>> = []
  for (const id of manifest.batches.flatMap((b) => b.ids)) {
    if (accepted.has(id)) ordered.push({ id, status: 'processed', value: accepted.get(id) })
    else if (rejected.has(id)) ordered.push({ id, status: 'failed', reason: rejected.get(id) })
    else ordered.push({ id, status: 'skipped', reason: '宿主未标注' })
  }
  for (const s of manifest.skipped) ordered.push({ id: s.id, status: 'skipped', reason: s.reason })

  const scopeNote = manifest.scope.sample !== null && manifest.scope.sample < manifest.scope.in_scope
    ? `随机样本：从范围内 ${manifest.scope.in_scope} 条中抽取 ${exported.size + manifest.skipped.length} 条（种子 ${manifest.scope.seed}），比例只代表样本。`
    : undefined
  let summary: unknown
  if (task.type === 'sentiment') {
    const records: SentimentRecord[] = ordered.map((r) => {
      const item = byId.get(r.id)!
      const v = r.value as z.output<typeof sentimentRow> | undefined
      if (r.status !== 'processed' || !v) return { id: r.id, kind: item.kind, content_id: item.content_id, status: r.status === 'failed' ? 'failed' : 'skipped', score: null, reason: r.reason ?? '' }
      return { id: r.id, kind: item.kind, content_id: item.content_id, status: v.score === null ? 'uncertain' : 'scored', score: v.score, reason: v.reason, mixed: v.mixed ?? false, sarcasm: v.sarcasm ?? 'unknown', target: v.target ?? '' }
    })
    const kinds = [...new Set(records.map((r) => r.kind))]
    summary = {
      target: task.target, thresholds: { positive_above: 0.2, negative_below: -0.2 }, summary: sentimentStats(records),
      by_kind: Object.fromEntries(kinds.map((kind) => [kind, sentimentStats(records.filter((r) => r.kind === kind))])),
      note: '每条记录等权；比例分母为已评估条数（包括无法判断），均值分母为有效数值条数。由宿主模型逐条评分，仅描述导入样本。', scope_note: scopeNote, records,
    }
  } else if (task.type === 'topics') {
    summary = { ...summarizeTopics(task.topics, ordered as Array<Labeled<TopicRow>>), scope_note: scopeNote, records: ordered }
  } else {
    summary = { opportunities: rankOpportunities(ordered as Array<Labeled<BusinessRow>>), note: BUSINESS_NOTE, scope_note: scopeNote, records: ordered }
  }

  const processed = ordered.filter((r) => r.status === 'processed').length
  const counts = { exported: exported.size, processed, invalid: rejected.size, missing: [...exported].filter((id) => !accepted.has(id) && !rejected.has(id)).length, skipped_long: manifest.skipped.length, in_scope: manifest.scope.in_scope }
  const path = join(outDir, 'result.json')
  const total = exported.size + manifest.skipped.length
  const result: ImportResult = { ok: errors.length === 0 && counts.missing === 0, task: task.type, counts, coverage: total ? processed / total : 0, errors, summary, path }
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** CLI 输出用：去掉逐条记录，只保留汇总 */
export function briefImport(result: ImportResult): unknown {
  const { records: _records, ...summary } = result.summary as { records?: unknown }
  return { ...result, errors: result.errors.slice(0, 20), errors_total: result.errors.length, summary }
}
