import { fileURLToPath } from 'node:url'
import type { Mapping } from '../../src/ingest/mapping.ts'

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url))

/** 从真实数据截取，用户名、mid、rpid、弹幕发送者、封面已替换。路径同时含 BV 号和 av 号 */
export const BV_FIXTURE = fixture('bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json')

/** 结构与 BV_FIXTURE 相同，路径只有 av 号，没有弹幕，回复为空，AI 总结为空 */
export const AV_FIXTURE = fixture('bilibili/示例视频-100000002/bilibili_all.json')

/** 手写的 B 站映射规则，代替模型的输出 */
export const BILIBILI_MAPPING = {
  platform: 'bilibili',
  content: {
    path: '$.video_info',
    id_from_path: '(BV[0-9A-Za-z]{10})',
    url_template: 'https://www.bilibili.com/video/{id}',
    fields: { title: 'title', author: 'owner', published_at: 'pubdate', summary: '$.video_ai_summary.summary' },
    stats: { views: 'view', likes: 'like', duration_sec: 'duration' },
    transcript: { path: '$.video_zimu', start: 'from', end: 'to', text: 'content' },
  },
  collections: [
    {
      kind: 'comment',
      path: '$.video_comments',
      fields: {
        id: 'rpid',
        text: 'content',
        author_id: 'mid',
        author_name: 'author',
        author_gender: 'sex',
        author_location: 'location',
        likes: 'like',
        reply_count: 'replyCount',
        created_at: 'time',
      },
      children: [{ kind: 'reply', path: 'replyList', recursive: true }],
    },
    {
      kind: 'danmaku',
      path: '$.video_danmus',
      fields: { text: 'content', author_id: 'sender', video_time: 'time', danmaku_mode: 'type' },
    },
  ],
} satisfies Mapping
