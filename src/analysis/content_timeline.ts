import { transcriptId } from '../dataset/evidence.ts'
import type { Dataset } from '../dataset/types.ts'
import { binCounts, detectPeaks } from './timeline.ts'

export function contentTimeline(dataset: Dataset, options: { contentId?: string; binSec?: number; limit?: number; offset?: number } = {}) {
  const bin = options.binSec ?? 30
  const limit = options.limit ?? 30
  const offset = options.offset ?? 0
  if (!Number.isInteger(bin) || bin < 1 || bin > 300 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('非法时间轴参数')
  const rows = []
  for (const content of dataset.contents.filter((c) => !options.contentId || c.id === options.contentId)) {
    const timed = dataset.items.filter((i) => i.content_id === content.id && i.kind === 'danmaku' && Number.isFinite(i.video_time_sec) && i.video_time_sec! >= 0)
    // 不为空白长视频分配成千上万个空窗口。
    const windows = new Map<number, typeof timed>()
    for (const item of timed) {
      const index = Math.floor(item.video_time_sec! / bin)
      const window = windows.get(index)
      if (window) window.push(item)
      else windows.set(index, [item])
    }
    // 字幕起点也能生成窗口；跨窗字幕会出现在已有的重叠窗口，不分配无事件的长时间空窗。
    for (const line of content.transcript ?? []) {
      const index = Math.floor(line.start_sec / bin)
      if (!windows.has(index)) windows.set(index, [])
    }
    const maxIndex = [...windows.keys()].reduce((max, index) => Math.max(max, index), 0)
    const peaks = maxIndex <= 100_000 ? detectPeaks(binCounts(timed.map((i) => i.video_time_sec!), bin), bin) : []
    for (const [index, items] of [...windows].sort((a, b) => a[0] - b[0])) {
      const start = index * bin
      const end = start + bin
      const transcript = (content.transcript ?? []).map((line, i) => ({ ...line, ref: transcriptId(content.id, i) })).filter((line) => line.start_sec < end && line.end_sec > start)
      rows.push({ content_id: content.id, title: content.title, start_sec: start, end_sec: end, count: items.length,
        peak: maxIndex > 100_000 ? null : peaks.some((p) => p.start_sec < end && p.end_sec > start),
        feedback: items.slice(0, 5).map((i) => ({ id: i.id, text: i.text.slice(0, 500), text_chars: i.text.length, truncated: i.text.length > 500, time_sec: i.video_time_sec })),
        feedback_omitted: Math.max(0, items.length - 5),
        transcript: transcript.slice(0, 10).map((line) => ({ ...line, text: line.text.slice(0, 500), truncated: line.text.length > 500 })),
        transcript_omitted: Math.max(0, transcript.length - 10),
      })
    }
  }
  const page: typeof rows = []
  let chars = 0
  for (const row of rows.slice(offset, offset + limit)) { const n = JSON.stringify(row).length; if (page.length && chars + n > 16_000) break; page.push(row); chars += n }
  return { total: rows.length, rows: page, next_offset: offset + page.length < rows.length ? offset + page.length : null,
    note: '同内容时间窗口的观众反应与字幕原文；不是因果判定或画面猜测。未提供字幕时 transcript 为空。' }
}
