import type { Dataset, FeedbackItem } from '../../dataset/types.ts'

const KIND_LABELS: Record<FeedbackItem['kind'], string> = {
  comment: '评论',
  reply: '回复',
  danmaku: '弹幕',
  answer: '回答',
}

export function clock(seconds: number): string {
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 按 UTF-16 长度截取，但不把 emoji 这类代理对拆成两半：半个字符会让请求体无法解析 */
export function sliceText(text: string, max: number): string {
  if (text.length <= max) return text
  const end = /[\ud800-\udbff]/.test(text[max - 1] ?? '') ? max - 1 : max
  return text.slice(0, Math.max(0, end))
}

/** 正文里的换行压成空格，一条占一行，模型更容易对应 ID */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

/** 把“66666……”这种刷屏的长串压短，省下上下文；原文不变 */
export function compactRepeats(text: string): string {
  return text.replace(/(.)\1{7,}/gu, (run, char: string) => `${char.repeat(3)}…（${char}×${[...run].length}）`)
}

export interface FormatItemOptions {
  /** 压短连续重复的字符 */
  compact?: boolean
  /** 正文最多显示多少字，超出时注明全文长度 */
  maxChars?: number
  /** 数据集有多个内容时显示所属内容 */
  showContent?: boolean
}

/** 例：[1003] 评论 赞94 回复3 2024-10-22 浙江 用户3：正文… */
export function formatItem(item: FeedbackItem, options: FormatItemOptions = {}): string {
  const parts = [`[${item.id}]`, KIND_LABELS[item.kind]]
  if (item.likes !== undefined) parts.push(`赞${item.likes}`)
  if (item.reply_count) parts.push(`回复${item.reply_count}`)
  if (item.created_at) parts.push(item.created_at.slice(0, 10))
  if (item.video_time_sec !== undefined) parts.push(`视频${clock(item.video_time_sec)}`)
  if (item.author?.location) parts.push(item.author.location)
  if (item.parent_id) parts.push(`回复[${item.parent_id}]`)
  if (options.showContent) parts.push(`内容${item.content_id}`)
  const name = item.author?.name ? `${item.author.name}：` : ''

  const text = options.compact ? compactRepeats(oneLine(item.text)) : oneLine(item.text)
  const max = options.maxChars ?? Infinity
  const body = text.length > max ? `${sliceText(text, max)}…（全文 ${text.length} 字）` : text
  return `${parts.join(' ')} ${name}${body}`
}

export function hasManyContents(dataset: Dataset): boolean {
  return dataset.contents.length > 1
}

/** 逐行累加，超过字符上限时停下，至少保留一行 */
export function takeLines(lines: readonly string[], maxChars: number): { shown: string[]; omitted: number } {
  const shown: string[] = []
  let chars = 0
  for (const line of lines) {
    if (shown.length > 0 && chars + line.length > maxChars) break
    shown.push(line)
    chars += line.length + 1
  }
  return { shown, omitted: lines.length - shown.length }
}
