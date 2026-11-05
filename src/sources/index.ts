import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Dataset, Platform } from '../dataset/types.ts'
import { bilibiliAdapter } from './media_crawl/bilibili.ts'
import { SourceError, type SourceAdapter } from './types.ts'

export { SourceError, type SourceAdapter } from './types.ts'

export type FileDetection =
  | { status: 'supported'; adapter: SourceAdapter }
  | { status: 'unsupported'; platform: Platform; reason: string }
  | { status: 'ignored'; reason: string }
  | { status: 'unknown'; reason: string }

/** 与 media_crawl mcp/shared.mjs 的 FILES_BY_DATA_TYPE.all 保持一致。文件名不统一，只能逐个列出 */
const SUPPORTED: Record<string, SourceAdapter> = {
  'bilibili_all.json': bilibiliAdapter,
}

const NOT_YET: Record<string, Platform> = {
  'all_douyin.json': 'douyin',
  'all_xhs.json': 'xhs',
  'youtube_all.json': 'youtube',
  'all_zhihu.json': 'zhihu',
}

const AGGREGATES = new Set([
  'all_search.json',
  'all_recommend.json',
  'all_popular.json',
  'all_history.json',
  'all_collects.json',
  'all_uploader_summary.json',
])

export function detectFile(filePath: string): FileDetection {
  const name = basename(filePath)
  const adapter = SUPPORTED[name]
  if (adapter) return { status: 'supported', adapter }
  const platform = NOT_YET[name]
  if (platform) return { status: 'unsupported', platform, reason: `${name}（${platform}）暂不支持` }
  if (AGGREGATES.has(name)) return { status: 'ignored', reason: `${name} 是汇总文件，不是互动内容数据` }
  return { status: 'unknown', reason: `无法识别的文件：${name}` }
}

export function datasetId(filePath: string): string {
  return createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 12)
}

export async function loadDataset(filePath: string): Promise<Dataset> {
  const absolute = resolve(filePath)
  const detection = detectFile(absolute)
  if (detection.status !== 'supported') throw new SourceError(detection.reason)
  const { adapter } = detection

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error) {
    throw new SourceError(`无法读取 ${absolute}：${(error as Error).message}`)
  }

  const { contents, items } = adapter.parse(raw, { file_path: absolute })
  return {
    id: datasetId(absolute),
    source: adapter.name,
    platform: adapter.platform,
    file_path: absolute,
    contents,
    items,
    imported_at: new Date().toISOString(),
  }
}
