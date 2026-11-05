export type Platform = 'bilibili' | 'douyin' | 'xhs' | 'youtube' | 'zhihu'

export type FeedbackKind = 'comment' | 'reply' | 'danmaku' | 'answer'

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['comment', 'reply', 'danmaku', 'answer']

export interface FeedbackAuthor {
  id?: string
  name?: string
  gender?: string
  /** IP 属地 */
  location?: string
}

/** 一条用户互动内容。字段含义见 docs/architecture.md 第 5 节 */
export interface FeedbackItem {
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
  title: string
  url?: string
  author?: string
  description?: string
  published_at?: string
  /** 平台显示的播放、点赞、评论数等 */
  stats?: Record<string, number>
  summary?: string
  transcript?: TranscriptLine[]
}

export interface Dataset {
  id: string
  /** 数据源适配器名称，如 media_crawl/bilibili */
  source: string
  platform: Platform
  file_path: string
  contents: ContentInfo[]
  items: FeedbackItem[]
  imported_at: string
}
