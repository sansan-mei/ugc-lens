import { currentTask, withTask } from '../agent/usage.ts'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import type { RunEventListener } from '../agent/events.ts'
import type { AgentModel } from '../agent/model.ts'
import type { Dataset } from '../dataset/types.ts'
import { applyMapping, formatReport, type ApplyResult } from './apply.ts'
import { addCacheRule, listCache, readCache, type CacheEntry } from './cache.ts'
import { inferMapping } from './infer.ts'
import type { Mapping } from './mapping.ts'
import { describeShape, type Shape } from './shape.ts'
import { ImportError } from './errors.ts'
import { readInput } from './formats.ts'
import { PRESET_MAPPINGS } from './presets.ts'

import { homedir } from 'node:os'
import { sharedMappingsDir } from '../config.ts'
export { ImportError, MAX_FILE_BYTES, type ImportErrorCode } from './errors.ts'
export type { InputFormat } from './formats.ts'

export interface LoadDatasetOptions {
  /** 缓存里没有可用规则时，用它推断映射规则 */
  model?: AgentModel
  /** 默认 ~/.ugc-lens/mappings */
  cacheDir?: string
  /**
   * 额外的规则缓存目录：先查 cacheDir，再查这里；新规则两边都写。入口层不再使用（全部规则都在 ~/.ugc-lens/mappings），保留给库调用。
   */
  sharedCacheDir?: string
  /** false：不读缓存，总是重新推断（仍会写入缓存）；同时跳过内置规则 */
  useCache?: boolean
  /** false：不试内置的已知格式规则，默认 true */
  usePresets?: boolean
  signal?: AbortSignal
  onEvent?: RunEventListener
}

export function datasetId(filePath: string): string {
  return createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 12)
}

export function defaultCacheDir(homeDir: string = homedir()): string {
  return sharedMappingsDir(homeDir)
}

/** 最多试多少条其他指纹的规则，避免缓存很大时每次导入都很慢 */
const MAX_FALLBACK_RULES = 50

/**
 * 先试同一指纹的规则，再试其他指纹的规则。
 * 其他指纹的规则要求试转换没有错误，也没有遗漏的数组，避免把一个只有评论的规则用到带弹幕的文件上。
 */
async function findCachedMapping(
  data: unknown,
  filePath: string,
  shape: Shape,
  cacheDir: string,
  exact: CacheEntry | undefined,
  exactOnly = false,
): Promise<{ mapping: Mapping; result: ApplyResult } | undefined> {
  const mappingsOf = (entry: CacheEntry) =>
    entry.rules.flatMap((rule) => (rule.outcome.type === 'mapping' ? [rule.outcome.mapping] : []))

  for (const mapping of exact ? mappingsOf(exact) : []) {
    const result = applyMapping(data, mapping, { file_path: filePath, arrays: shape.arrays, lenient: true })
    if (result.report.errors.length === 0) return { mapping, result }
  }

  if (exactOnly) return undefined
  const others = (await listCache(cacheDir)).filter((entry) => entry.fingerprint !== shape.fingerprint)
  for (const mapping of others.flatMap(mappingsOf).slice(0, MAX_FALLBACK_RULES)) {
    const result = applyMapping(data, mapping, { file_path: filePath, arrays: shape.arrays, lenient: true })
    if (result.report.errors.length === 0 && result.report.unmapped.length === 0) return { mapping, result }
  }
  return undefined
}
/** 读入结构化文件或文本记录，转换成统一格式。流程见 docs/architecture.md 第 5.3 节 */
export async function loadDataset(filePath: string, options: LoadDatasetOptions = {}): Promise<Dataset> {
  if (!currentTask()) return withTask(() => loadDataset(filePath, options), undefined)
  const absolute = resolve(filePath)
  const input = await readInput(absolute, options.signal)
  const { data } = input
  let shape = describeShape(data)
  const tabular = input.format === 'csv' || input.format === 'tsv'
  // 表头名称影响列语义，不能仅凭列数相同复用另一个表格的规则。
  if (tabular) shape = { ...shape, fingerprint: createHash('sha256').update(shape.fingerprint + JSON.stringify((data as { columns: unknown }).columns)).digest('hex').slice(0, 16) }
  const serialized = JSON.stringify(data)
  const sourceDigest = createHash('sha256').update(absolute).update('\0').update(serialized).digest('hex')
  const contentDigest = createHash('sha256').update(input.format).update('\0').update(serialized).digest('hex').slice(0, 24)
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const cacheDirs = [...new Set([cacheDir, options.sharedCacheDir].filter((d): d is string => !!d))]

  const build = (result: ApplyResult, platform: string, fromCache: boolean): Dataset => ({
    task_usage: currentTask()!.snapshot(),
    id: datasetId(absolute),
    platform,
    source: { format: input.format },
    file_path: absolute,
    contents: result.contents,
    items: result.items,
    imported_at: new Date().toISOString(),
    mapping: { fingerprint: shape.fingerprint, from_cache: fromCache },
    report: result.report,
    content_digest: contentDigest,
  })

  if (input.builtin) {
    const result = applyMapping(data, input.builtin, { file_path: absolute, arrays: shape.arrays })
    if (result.report.errors.length) throw new ImportError('not_feedback', formatReport(result.report))
    const dataset = build(result, input.builtin.platform, false)
    dataset.mapping.builtin = true
    return dataset
  }

  if (options.useCache !== false) {
    // 项目缓存优先，其次共享缓存
    for (const dir of cacheDirs) {
      const exact = await readCache(dir, shape.fingerprint)
      const rejected = exact?.rules.find((rule) => rule.outcome.type === 'rejected' && rule.source_digest === sourceDigest)
      if (rejected?.outcome.type === 'rejected') {
        throw new ImportError('not_feedback', `${basename(absolute)} 没有可分析文本：${rejected.outcome.reason}`)
      }
      const found = await findCachedMapping(data, absolute, shape, dir, exact, tabular)
      if (found) return build(found.result, found.mapping.platform, true)
    }
  }
  if (!tabular && options.usePresets !== false && options.useCache !== false) {
    for (const mapping of PRESET_MAPPINGS) {
      const result = applyMapping(data, mapping, { file_path: absolute, arrays: shape.arrays, lenient: true })
      if (result.report.errors.length || result.report.unmapped.length || result.items.length === 0) continue
      const dataset = build(result, mapping.platform, false)
      dataset.mapping.builtin = true
      return dataset
    }
  }
  if (!options.model) {
    throw new ImportError('no_model', `缓存里没有适用于 ${basename(absolute)} 的映射规则，需要提供模型来识别文件结构`)
  }

  const inferred = await inferMapping({
    model: options.model,
    data,
    shape,
    file_path: absolute,
    signal: options.signal,
    onEvent: options.onEvent,
  })
  const outcome = inferred.outcome
  if (!outcome) {
    const detail = inferred.last_error ? `\n最后一次错误：\n${inferred.last_error}` : ''
    throw new ImportError(
      'inference_failed',
      `模型没有给出可用的映射规则（停止原因：${inferred.run.stop_reason}）：${absolute}${detail}`,
    )
  }

  const rule = {
    created_at: new Date().toISOString(),
    file_name: basename(absolute),
    source_digest: outcome.type === 'rejected' ? sourceDigest : undefined,
    outcome: outcome.type === 'mapping' ? { type: 'mapping' as const, mapping: outcome.mapping } : outcome,
  }
  for (const dir of cacheDirs) await addCacheRule(dir, shape.fingerprint, rule)

  if (outcome.type === 'rejected') {
    throw new ImportError('not_feedback', `${basename(absolute)} 没有可分析文本：${outcome.reason}`)
  }
  return build(outcome.result, outcome.mapping.platform, false)
}

export { describeShape, type Shape } from './shape.ts'
export { applyMapping, formatReport } from './apply.ts'
export { mappingSchema, type Mapping } from './mapping.ts'
