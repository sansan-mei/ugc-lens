import type { Dataset, Platform } from '../dataset/types.ts'

export interface SourceContext {
  /** 文件绝对路径，部分平台的内容 ID 只能从路径中取 */
  file_path: string
}

/** 把某种原始文件转换成统一格式 */
export interface SourceAdapter {
  /** 如 media_crawl/bilibili */
  name: string
  platform: Platform
  parse(raw: unknown, ctx: SourceContext): Pick<Dataset, 'contents' | 'items'>
}

/** 文件无法识别、暂不支持或内容不符合格式 */
export class SourceError extends Error {
  override name = 'SourceError'
}
