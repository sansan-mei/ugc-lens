import { mappingSchema, type Mapping } from './mapping.ts'

/**
 * 已知导出格式的内置规则，缓存没有命中时先试这些，再请模型识别。
 * 只有试转换没有错误、也没有遗漏数组时才采用，因此结构不同的文件仍走原来的识别流程。
 */
const RAW_PRESETS = [
  {
    // media_crawl 的 B 站 *_all.json：video_info、video_comments（replyList 嵌套）、video_danmus、video_zimu、video_ai_summary
    platform: 'bilibili',
    content: {
      path: '$.video_info',
      // 路径里有 BV 号时用 BV 号，否则用目录名末尾的 av 号；文件被移动或改名后退回文件名，保证内置规则仍可用
      id_from_path: '(BV[0-9A-Za-z]{10}|\\d{5,}(?=[/\\\\][^/\\\\]+\\.json$)|[^/\\\\]+(?=\\.json$))',
      fields: { title: 'title', author: 'owner', description: 'description', published_at: 'pubdate', summary: '$.video_ai_summary.summary' },
      stats: { views: 'view', likes: 'like', coins: 'coin', favorites: 'favorite', shares: 'share', comments: 'reply', danmaku: 'danmaku', duration_sec: 'duration' },
      transcript: { path: '$.video_zimu', start: 'from', end: 'to', text: 'content' },
    },
    collections: [
      {
        kind: 'comment',
        path: '$.video_comments',
        fields: { id: 'rpid', text: 'content', author_id: 'mid', author_name: 'author', author_gender: 'sex', author_location: 'location', likes: 'like', reply_count: 'replyCount', created_at: 'time' },
        children: [{ kind: 'reply', path: 'replyList', recursive: true }],
      },
      { kind: 'danmaku', path: '$.video_danmus', fields: { text: 'content', author_id: 'sender', video_time: 'time', danmaku_mode: 'type' } },
    ],
  },
]

export const PRESET_MAPPINGS: readonly Mapping[] = RAW_PRESETS.map((preset) => mappingSchema.parse(preset))
