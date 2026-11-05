import { basename, dirname, sep } from 'node:path'
import * as z from 'zod'
import type { ContentInfo, FeedbackItem } from '../../dataset/types.ts'
import { SourceError, type SourceAdapter } from '../types.ts'
import { formatSchemaIssues } from '../validate.ts'

const id = z.union([z.string(), z.number()]).transform(String)

const rawReply = z.object({
  rpid: id,
  mid: id.optional(),
  author: z.string().optional(),
  content: z.string(),
  /** 毫秒 */
  time: z.number().optional(),
  like: z.number().optional(),
  replyCount: z.number().optional(),
  sex: z.string().optional(),
  location: z.string().optional(),
})

const rawComment = rawReply.extend({ replyList: z.array(rawReply).optional() })

const rawDanmu = z.object({
  /** "00:01:23" 或 "01:23" */
  time: z.string(),
  content: z.string(),
  sender: z.string().optional(),
  type: z.string().optional(),
})

const rawSubtitle = z.object({ from: z.number(), to: z.number(), content: z.string() })

const rawFile = z.object({
  video_info: z.object({
    title: z.string(),
    description: z.string().optional(),
    duration: z.number().optional(),
    owner: z.string().optional(),
    view: z.number().optional(),
    reply: z.number().optional(),
    favorite: z.number().optional(),
    coin: z.number().optional(),
    share: z.number().optional(),
    like: z.number().optional(),
    danmaku: z.number().optional(),
    /** 秒 */
    pubdate: z.number().optional(),
  }),
  video_comments: z.array(rawComment).default([]),
  video_danmus: z.array(rawDanmu).default([]),
  video_zimu: z.array(rawSubtitle).default([]),
  video_ai_summary: z.object({ summary: z.string().optional() }).nullish(),
})

type RawReply = z.output<typeof rawReply>

const BVID = /^BV[0-9A-Za-z]{10}$/

/** 文件里没有视频 ID，从路径中取：优先 BV 号，其次目录名末尾的 av 号 */
export function videoIdFromPath(filePath: string): { bvid?: string; aid?: string } {
  const parts = dirname(filePath).split(sep)
  const bvid = [...parts].reverse().find((part) => BVID.test(part))
  if (bvid) return { bvid }
  const aid = /-(\d+)$/.exec(basename(dirname(filePath)))?.[1]
  return aid ? { aid } : {}
}

/** "01:02:03" → 3723，"02:03" → 123 */
export function parseClock(value: string): number | undefined {
  const parts = value.trim().split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

function isoFromMs(ms: number | undefined): string | undefined {
  return ms === undefined || ms <= 0 ? undefined : new Date(ms).toISOString()
}

function definedStats(stats: Record<string, number | undefined>): Record<string, number> | undefined {
  const entries = Object.entries(stats).filter((entry): entry is [string, number] => entry[1] !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export const bilibiliAdapter: SourceAdapter = {
  name: 'media_crawl/bilibili',
  platform: 'bilibili',

  parse(raw, ctx) {
    const parsed = rawFile.safeParse(raw)
    if (!parsed.success) {
      throw new SourceError(`${ctx.file_path} 不是有效的 bilibili_all.json：\n${formatSchemaIssues(parsed.error)}`)
    }
    const data = parsed.data

    const { bvid, aid } = videoIdFromPath(ctx.file_path)
    const videoId = bvid ?? (aid ? `av${aid}` : undefined)
    if (!videoId) {
      throw new SourceError(`无法从路径中得到视频 ID（BV 号或目录名末尾的 av 号）：${ctx.file_path}`)
    }
    const contentId = `bilibili:${videoId}`
    const info = data.video_info

    const content: ContentInfo = {
      id: contentId,
      platform: 'bilibili',
      title: info.title,
      url: `https://www.bilibili.com/video/${videoId}`,
      author: info.owner,
      description: info.description || undefined,
      published_at: info.pubdate ? new Date(info.pubdate * 1000).toISOString() : undefined,
      stats: definedStats({
        views: info.view,
        likes: info.like,
        coins: info.coin,
        favorites: info.favorite,
        shares: info.share,
        comments: info.reply,
        danmaku: info.danmaku,
        duration_sec: info.duration,
      }),
      summary: data.video_ai_summary?.summary || undefined,
      transcript: data.video_zimu.length
        ? data.video_zimu.map((line) => ({ start_sec: line.from, end_sec: line.to, text: line.content }))
        : undefined,
    }

    const items: FeedbackItem[] = []
    const toItem = (rawItem: RawReply, kind: 'comment' | 'reply', parentId?: string): FeedbackItem => ({
      id: `bilibili:${rawItem.rpid}`,
      platform: 'bilibili',
      kind,
      content_id: contentId,
      parent_id: parentId,
      text: rawItem.content,
      author: { id: rawItem.mid, name: rawItem.author, gender: rawItem.sex, location: rawItem.location || undefined },
      likes: rawItem.like,
      reply_count: rawItem.replyCount,
      created_at: isoFromMs(rawItem.time),
    })

    for (const comment of data.video_comments) {
      const item = toItem(comment, 'comment')
      items.push(item)
      for (const reply of comment.replyList ?? []) items.push(toItem(reply, 'reply', item.id))
    }

    data.video_danmus.forEach((danmu, index) => {
      items.push({
        id: `${contentId}:dm:${index + 1}`,
        platform: 'bilibili',
        kind: 'danmaku',
        content_id: contentId,
        text: danmu.content,
        author: danmu.sender ? { id: danmu.sender } : undefined,
        video_time_sec: parseClock(danmu.time),
        danmaku_mode: danmu.type,
      })
    })

    return { contents: [content], items }
  },
}
