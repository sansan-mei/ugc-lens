import type { TaskUsage } from '../agent/usage.ts'
/** 平台名，由模型根据文件内容判断，如 bilibili、xhs；判断不了时为 unknown */
export type Platform = string

export type FeedbackKind = 'comment' | 'reply' | 'danmaku' | 'answer' | 'record'

export const FEEDBACK_KINDS = ['comment', 'reply', 'danmaku', 'answer', 'record'] as const satisfies readonly FeedbackKind[]

export interface FeedbackAuthor {
  id?: string
  name?: string
  gender?: string
  /** IP 属地 */
  location?: string
}

/** 一条用户互动内容。字段含义见 docs/architecture.md 第 5 节 */
export interface FeedbackItem {
  /** 数据集内唯一 */
  id: string
  platform: Platform
  kind: FeedbackKind
  content_id: string
  parent_id?: string
  /** 原文，不做清洗 */
  text: string
  author?: FeedbackAuthor
  likes?: number
  /** 平台显示的回复总数，可能大于实际搜集到的数量 */
  reply_count?: number
  created_at?: string
  video_time_sec?: number
  danmaku_mode?: string
}

export interface TranscriptLine {
  start_sec: number
  end_sec: number
  text: string
}

/** 被评论的对象：视频、笔记、问题 */
export interface ContentInfo {
  id: string
  platform: Platform
  /** 只有评论、没有内容详情的文件里没有标题 */
  title?: string
  url?: string
  author?: string
  description?: string
  published_at?: string
  /** 平台显示的播放、点赞、评论数等 */
  stats?: Record<string, number>
  summary?: string
  transcript?: TranscriptLine[]
}

export interface CollectionReport {
  /** 如 $.video_comments 或 $.video_comments[].replyList */
  path: string
  kind: FeedbackKind
  /** 路径上找到的数组元素个数 */
  elements: number
  imported: number
  /** 取不到 text 而跳过的元素 */
  skipped: number
  /** 字段名 → 命中率（0~1），只统计规则里写了的字段 */
  field_hits: Record<string, number>
}

/** 按映射规则试转换的结果，规则是否可用由 errors 决定 */
export interface ImportReport {
  contents: number
  items: number
  content?: { path: string; elements: number; field_hits: Record<string, number> }
  transcripts?: Array<{ content_id: string; path: string; status: 'absent' | 'empty' | 'failed' | 'imported'; elements: number; imported: number; failed: number }>
  collections: CollectionReport[]
  errors: string[]
  warnings: string[]
  /** 结构里较大、元素是对象、但没被任何规则使用的数组路径 */
  unmapped: string[]
}

export interface Dataset {
  task_usage?: TaskUsage
  id: string
  platform: Platform
  file_path: string
  contents: ContentInfo[]
  items: FeedbackItem[]
  imported_at: string
  source?: { format: string }
  mapping: { fingerprint: string; from_cache: boolean; builtin?: boolean }
  report: ImportReport
}
