import { transcriptId } from '../dataset/evidence.ts'
import { FEEDBACK_KINDS, type Dataset } from '../dataset/types.ts'
import type { ChunkPlan } from '../pipeline/chunk.ts'
import type { ChunkSummary } from '../pipeline/summarize.ts'
import { dedupeKey } from './text.ts'

export function analysisCoverage(dataset: Dataset, plan?: ChunkPlan, summaries?: readonly ChunkSummary[]) {
  const states = new Map<string, string>()
  for (const chunk of plan?.chunks ?? []) {
    const status = summaries?.find((s) => s.chunk === chunk.index)?.status
    for (const id of chunk.ids) states.set(id, status === 'ok' ? 'processed' : status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'selected')
  }
  const collections = dataset.report.collections.map((c) => ({ path: c.path, kind: c.kind, found: c.elements, imported: c.imported, skipped: c.skipped }))
  const kinds = FEEDBACK_KINDS.map((kind) => {
    const items = dataset.items.filter((i) => i.kind === kind)
    const counts = { imported: items.length, duplicate_texts: items.length - new Set(items.map((i) => `${i.content_id}:${dedupeKey(i.text)}`)).size, processed: 0, failed: 0, skipped: 0, selected: 0, not_selected: 0 }
    for (const item of items) counts[(states.get(item.id) ?? 'not_selected') as 'processed' | 'failed' | 'skipped' | 'selected' | 'not_selected']++
    return { kind, ...counts }
  }).filter((row) => row.imported > 0)
  const transcripts = dataset.contents.map((content) => {
    const source = dataset.report.transcripts?.find((r) => r.content_id === content.id)
    const ids = (content.transcript ?? []).map((_, i) => transcriptId(content.id, i))
    const count = (state: string) => ids.filter((id) => states.get(id) === state).length
    const processed = count('processed')
    const failed = count('failed')
    return { content_id: content.id, source_status: source?.status ?? (ids.length ? 'imported' : 'unknown'),
      source_elements: source?.elements ?? null, conversion_failed: source?.failed ?? null,
      imported: ids.length, submitted: processed + failed, processed, failed,
      selected: count('selected'), skipped: count('skipped'), not_selected: ids.filter((id) => !states.has(id)).length }
  })
  return { collections, kinds, transcripts, stage: summaries ? 'summarize' : plan ? 'planned' : 'import', notes: [
    '计数仅针对当前导入文件，搜集端采样与平台全量另行说明。',
    '重复正文只记录信号，不判定水军；逐条分类与情感分析仍按独立 ID 等权统计。',
    'processed 表示原文 ID 进入成功总结块，不表示主题或情感已逐条核验；弹幕复读代表数另见报告。',
    '各类型 imported = processed + failed + skipped + selected + not_selected，duplicate_texts 为额外特征，不参与相加。',
  ] }
}
