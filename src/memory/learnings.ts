import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { getFeedback } from '../dataset/query.ts'
import type { Dataset } from '../dataset/types.ts'
import type { MemoryOptions, PlaybookInfo } from './playbook.ts'
import { validateMemoryText } from './playbook.ts'

export interface Learning {
  id: string
  created_at: string
  kind: 'analysis' | 'ask' | 'candidate'
  dataset_ids: string[]
  platforms: string[]
  playbook?: PlaybookInfo
  observations: Record<string, number | string | boolean>
  note?: string
  evidence_ids?: string[]
}
export const learningsPath = (memory: MemoryOptions): string => join(memory.cwd, '.ugc-lens', 'learnings.md')
export async function recordLearning(memory: MemoryOptions, datasets: readonly Dataset[], entry: Pick<Learning, 'kind' | 'observations' | 'playbook' | 'note' | 'evidence_ids'>): Promise<Learning> {
  if (!datasets.length) throw new Error('经验必须关联数据集')
  if (entry.kind === 'candidate' && (datasets.length !== 1 || !entry.evidence_ids?.length || entry.evidence_ids.some((id) => !getFeedback(datasets[0]!, id)))) throw new Error('候选经验必须绑定单个数据集并提供有效证据 ID')
  if (entry.note !== undefined) {
    if (!entry.note.trim() || entry.note.length > 1500) throw new Error('经验内容需要 1～1500 字符')
    validateMemoryText(entry.note)
  }
  const record: Learning = { ...entry, id: randomUUID(), created_at: new Date().toISOString(), dataset_ids: datasets.map((d) => d.id), platforms: [...new Set(datasets.map((d) => d.platform))] }
  const serialized = JSON.stringify(record)
  if (serialized.length > 7000) throw new Error('经验记录超过单条 7000 字符上限')
  const dir = join(memory.cwd, '.ugc-lens')
  await mkdir(dir, { recursive: true })
  // JSON 单行可以无损检索原记录，避免笔记中的 Markdown 改变记录边界。
  await appendFile(learningsPath(memory), `\n## ${record.kind} ${record.id}\n\n\`\`\`json\n${serialized}\n\`\`\`\n`, { mode: 0o600 })
  return record
}
export async function recordOutcome(memory: MemoryOptions | undefined, datasets: readonly Dataset[], entry: Parameters<typeof recordLearning>[2]): Promise<string | undefined> {
  if (!memory || !datasets.length) return undefined
  try { await recordLearning(memory, datasets, entry) } catch {
    const warning = '经验记录失败；本次回答或报告已保留，请检查 .ugc-lens 目录权限'
    try { memory.onWarning?.(warning) } catch { /* 通知失败不能掩盖分析结果。 */ }
    return warning
  }
  return undefined
}
export async function searchLearnings(memory: MemoryOptions, query = '', datasetId?: string, offset = 0, limit = 10): Promise<{ entries: Learning[]; next_offset: number | null }> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('无效分页参数')
  let file
  try { file = await open(learningsPath(memory), 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], next_offset: null }
    throw error
  }
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const entries: Learning[] = []
  let matched = 0
  let chars = 0
  try {
    for await (const line of file.readLines()) {
      if (!line.startsWith('{') || line.length > 7000) continue
      let entry: Learning
      try { entry = JSON.parse(line) as Learning } catch { continue }
      if (!Array.isArray(entry.dataset_ids) || typeof entry.id !== 'string') continue
      if (datasetId && !entry.dataset_ids.includes(datasetId)) continue
      if (!terms.every((term) => line.toLocaleLowerCase().includes(term))) continue
      if (matched++ < offset) continue
      if (entries.length >= limit || (entries.length > 0 && chars + line.length > 8000)) return { entries, next_offset: offset + entries.length }
      chars += line.length
      entries.push(entry)
    }
    return { entries, next_offset: null }
  } finally { await file.close() }
}
