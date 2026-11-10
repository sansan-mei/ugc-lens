// 浏览器和 Node 测试共用的格式化与图表计算，不依赖 DOM。

export const KIND: Record<string, string> = { comment: '评论', reply: '回复', danmaku: '弹幕', answer: '回答', record: '记录', transcript: '字幕' }

export const fmt = (n: number | undefined | null): string => Number(n ?? 0).toLocaleString('zh-CN')
export const pct = (x: number | undefined | null): string => x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`

export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
export const dirName = (path: string): string => path.slice(0, path.length - baseName(path).length).replace(/[\\/]$/, '')
/** 浏览器上传的副本保存在 ~/.ugc-lens/ui/uploads/<哈希>/ 下 */
export const isUpload = (path: string): boolean => /[\\/]\.ugc-lens[\\/]ui[\\/]uploads[\\/]/.test(path)

export const kb = (size: number): string => `${(size / 1024).toFixed(size > 102400 ? 0 : 1)} KB`

/** 面积图路径：返回折线与填充路径，坐标保留一位小数 */
export function areaPaths(values: number[], box: { width: number; height: number; left: number; right: number; top: number; bottom: number }): { line: string; fill: string; max: number } {
  const max = Math.max(...values, 1)
  const plotW = box.width - box.left - box.right
  const plotH = box.height - box.top - box.bottom
  const x = (i: number) => box.left + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW)
  const y = (v: number) => box.top + plotH - (v / max) * plotH
  if (!values.length) return { line: '', fill: '', max }
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const line = `M${points.join(' L')}`
  const base = box.top + plotH
  const fill = `${line} L${x(values.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`
  return { line, fill, max }
}

/** 环形图分段：每段的弧长与起点偏移（按周长计算），值为 0 的段跳过 */
export function donutArcs<T extends { value: number }>(segments: T[], circumference: number): Array<T & { length: number; offset: number }> {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (!total) return []
  let offset = 0
  return segments.filter((s) => s.value > 0).map((s) => {
    const length = (s.value / total) * circumference
    const arc = { ...s, length, offset }
    offset += length
    return arc
  })
}
