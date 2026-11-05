import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { RunEventListener } from '../agent/events.ts'
import type { AgentModel } from '../agent/model.ts'
import type { Dataset } from '../dataset/types.ts'
import { applyMapping, formatReport, type ApplyResult } from './apply.ts'
import { addCacheRule, listCache, readCache, type CacheEntry } from './cache.ts'
import { inferMapping } from './infer.ts'
import type { Mapping } from './mapping.ts'
import { describeShape, type Shape } from './shape.ts'

export type ImportErrorCode = 'read_failed' | 'too_large' | 'not_json' | 'not_feedback' | 'no_model' | 'inference_failed'

export class ImportError extends Error {
  override name = 'ImportError'
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024

export interface LoadDatasetOptions {
  /** 缓存里没有可用规则时，用它推断映射规则 */
  model?: AgentModel
  /** 默认 <cwd>/.ugc-lens/mappings */
  cacheDir?: string
  /** false：不读缓存，总是重新推断（仍会写入缓存） */
  useCache?: boolean
  signal?: AbortSignal
  onEvent?: RunEventListener
}

export function datasetId(filePath: string): string {
  return createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 12)
}

export function defaultCacheDir(cwd: string = process.cwd()): string {
  return join(cwd, '.ugc-lens', 'mappings')
}

async function readJson(filePath: string): Promise<unknown> {
  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new ImportError('read_failed', `不是文件：${filePath}`)
    size = info.size
  } catch (error) {
    if (error instanceof ImportError) throw error
    throw new ImportError('read_failed', `无法读取 ${filePath}：${(error as Error).message}`)
  }
  if (size > MAX_FILE_BYTES) {
    throw new ImportError('too_large', `文件过大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_FILE_BYTES / 1024 / 1024} MB：${filePath}`)
  }
  const text = await readFile(filePath, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ImportError('not_json', `第一版只支持 JSON 文件，${filePath} 无法解析：${(error as Error).message}`)
  }
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
): Promise<{ mapping: Mapping; result: ApplyResult } | undefined> {
  const mappingsOf = (entry: CacheEntry) =>
    entry.rules.flatMap((rule) => (rule.outcome.type === 'mapping' ? [rule.outcome.mapping] : []))

  for (const mapping of exact ? mappingsOf(exact) : []) {
    const result = applyMapping(data, mapping, { file_path: filePath, arrays: shape.arrays, lenient: true })
    if (result.report.errors.length === 0) return { mapping, result }
  }

  const others = (await listCache(cacheDir)).filter((entry) => entry.fingerprint !== shape.fingerprint)
  for (const mapping of others.flatMap(mappingsOf).slice(0, MAX_FALLBACK_RULES)) {
    const result = applyMapping(data, mapping, { file_path: filePath, arrays: shape.arrays, lenient: true })
    if (result.report.errors.length === 0 && result.report.unmapped.length === 0) return { mapping, result }
  }
  return undefined
}
/** 读入任意 JSON 文件，转换成统一格式。流程见 docs/architecture.md 第 5.3 节 */
export async function loadDataset(filePath: string, options: LoadDatasetOptions = {}): Promise<Dataset> {
  const absolute = resolve(filePath)
  const data = await readJson(absolute)
  const shape = describeShape(data)
  const cacheDir = options.cacheDir ?? defaultCacheDir()

  const build = (result: ApplyResult, platform: string, fromCache: boolean): Dataset => ({
    id: datasetId(absolute),
    platform,
    file_path: absolute,
    contents: result.contents,
    items: result.items,
    imported_at: new Date().toISOString(),
    mapping: { fingerprint: shape.fingerprint, from_cache: fromCache },
    report: result.report,
  })

  if (options.useCache !== false) {
    const exact = await readCache(cacheDir, shape.fingerprint)
    const rejected = exact?.rules.find((rule) => rule.outcome.type === 'rejected')
    if (rejected?.outcome.type === 'rejected') {
      throw new ImportError('not_feedback', `${basename(absolute)} 没有互动内容：${rejected.outcome.reason}`)
    }
    const found = await findCachedMapping(data, absolute, shape, cacheDir, exact)
    if (found) return build(found.result, found.mapping.platform, true)
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

  await addCacheRule(cacheDir, shape.fingerprint, {
    created_at: new Date().toISOString(),
    file_name: basename(absolute),
    outcome: outcome.type === 'mapping' ? { type: 'mapping', mapping: outcome.mapping } : outcome,
  })

  if (outcome.type === 'rejected') {
    throw new ImportError('not_feedback', `${basename(absolute)} 没有互动内容：${outcome.reason}`)
  }
  return build(outcome.result, outcome.mapping.platform, false)
}

export { describeShape, type Shape } from './shape.ts'
export { applyMapping, formatReport } from './apply.ts'
export { mappingSchema, type Mapping } from './mapping.ts'
