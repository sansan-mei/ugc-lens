// SVG 图表：纯函数返回 SVG 字符串，所有文本先转义；不使用 style 属性，以满足页面的内容安全策略。
import { escapeHtml } from './markdown.js'

const fmt = (n) => Number(n).toLocaleString('zh-CN')
export const clock = (sec) => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

/** 横向条形图：每行标签、条和数值；items 为 [{ label, value, note? }] */
export function hBars(items, { width = 520, row = 30, labelWidth = 96, tone = 'accent', max } = {}) {
  if (!items.length) return '<p class="empty">暂无数据</p>'
  const top = max ?? Math.max(...items.map((i) => i.value), 1)
  const bar = width - labelWidth - 64
  const height = items.length * row
  const rows = items.map((item, i) => {
    const y = i * row
    const w = Math.max(2, (item.value / top) * bar)
    return `<g class="bar-row" data-label="${escapeHtml(item.label)}">
      <text x="${labelWidth - 10}" y="${y + row / 2 + 4}" text-anchor="end" class="axis-label">${escapeHtml(item.label)}</text>
      <rect x="${labelWidth}" y="${y + 7}" width="${bar}" height="${row - 14}" rx="${(row - 14) / 2}" class="track"/>
      <rect x="${labelWidth}" y="${y + 7}" width="${w.toFixed(1)}" height="${row - 14}" rx="${(row - 14) / 2}" class="bar-fill tone-${escapeHtml(tone)}"/>
      <text x="${labelWidth + w + 8}" y="${y + row / 2 + 4}" class="value-label">${escapeHtml(item.note ?? fmt(item.value))}</text>
    </g>`
  })
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">${rows.join('')}</svg>`
}

/** 竖向柱状图（按天等），columns 为 [{ label, value }] */
export function columns(values, { width = 560, height = 180 } = {}) {
  if (!values.length) return '<p class="empty">暂无发布时间数据</p>'
  const pad = { l: 36, r: 8, t: 12, b: 26 }
  const max = Math.max(...values.map((v) => v.value), 1)
  const w = (width - pad.l - pad.r) / values.length
  const plotH = height - pad.t - pad.b
  const bars = values.map((v, i) => {
    const h = (v.value / max) * plotH
    return `<rect x="${(pad.l + i * w + w * 0.15).toFixed(1)}" y="${(pad.t + plotH - h).toFixed(1)}" width="${Math.max(1, w * 0.7).toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="3" class="col"><title>${escapeHtml(v.label)}：${fmt(v.value)}</title></rect>`
  })
  const step = Math.max(1, Math.ceil(values.length / 6))
  const labels = values.map((v, i) => i % step === 0 ? `<text x="${(pad.l + i * w + w / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis-label">${escapeHtml(v.label)}</text>` : '').join('')
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${pad.t + plotH}" y2="${pad.t + plotH}" class="axis"/>
    <text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" class="axis-label">${fmt(max)}</text>
    ${bars.join('')}${labels}</svg>`
}

/** 弹幕密度面积图，高峰时段画浅色背景带并可点击 */
export function area(timeline, binSec, peaks = [], { width = 1040, height = 200 } = {}) {
  if (!timeline.length) return '<p class="empty">暂无弹幕时间数据</p>'
  const pad = { l: 40, r: 12, t: 16, b: 28 }
  const max = Math.max(...timeline, 1)
  const plotW = width - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const x = (i) => pad.l + (timeline.length === 1 ? plotW / 2 : (i / (timeline.length - 1)) * plotW)
  const y = (v) => pad.t + plotH - (v / max) * plotH
  const points = timeline.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const line = `M${points.join(' L')}`
  const fill = `${line} L${x(timeline.length - 1).toFixed(1)},${pad.t + plotH} L${x(0).toFixed(1)},${pad.t + plotH} Z`
  const total = timeline.length * binSec
  const sx = (sec) => pad.l + Math.min(1, sec / total) * plotW
  const bands = peaks.map((p, i) => `<rect x="${sx(p.start_sec).toFixed(1)}" y="${pad.t}" width="${Math.max(4, sx(p.end_sec) - sx(p.start_sec)).toFixed(1)}" height="${plotH}" class="peak-band" data-peak="${i}" tabindex="0"><title>高峰 ${clock(p.start_sec)}–${clock(p.end_sec)}，${fmt(p.count)} 条</title></rect>`)
  const ticks = []
  for (let k = 0; k <= 5; k++) {
    const sec = (total * k) / 5
    ticks.push(`<text x="${sx(sec).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis-label">${clock(sec)}</text>`)
  }
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img">
    <defs><linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2f7bff" stop-opacity="0.35"/><stop offset="100%" stop-color="#7a5cff" stop-opacity="0.02"/></linearGradient></defs>
    ${bands.join('')}
    <path d="${fill}" fill="url(#area-fill)"/>
    <path d="${line}" class="area-line"/>
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${pad.t + plotH}" y2="${pad.t + plotH}" class="axis"/>
    <text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" class="axis-label">${fmt(max)}</text>
    ${ticks.join('')}</svg>`
}

/** 环形图；segments 为 [{ label, value, color }]，中心显示合计或指定文字 */
export function donut(segments, { size = 180, thickness = 26, center } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = size / 2 - thickness / 2
  const c = 2 * Math.PI * r
  let offset = 0
  const arcs = total ? segments.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * c
    const arc = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${escapeHtml(s.label)}：${fmt(s.value)}</title></circle>`
    offset += len
    return arc
  }) : []
  return `<svg viewBox="0 0 ${size} ${size}" class="donut" role="img">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" class="track-ring" stroke-width="${thickness}"/>
    ${arcs.join('')}
    <text x="50%" y="48%" text-anchor="middle" class="donut-value">${escapeHtml(center ?? fmt(total))}</text>
    <text x="50%" y="62%" text-anchor="middle" class="axis-label">条</text></svg>`
}
