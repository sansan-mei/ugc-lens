import { motion } from 'motion/react'
import { useId, useRef, useState } from 'react'
import { areaPaths, binAt, clock, donutArcs, fmt } from '../lib/format.ts'
import type { DanmakuGroup, Peak } from '../lib/types.ts'
import { Empty } from './ui/card.tsx'

const spring = { type: 'spring', stiffness: 120, damping: 20 } as const

/** 横向条形：每行标签、条和数值，条从左向右依次长出 */
export function BarList({ items, tone = 'primary', onSelect }: { items: Array<{ label: string; value: number; note?: string; key?: string }>; tone?: 'primary' | 'chart'; onSelect?: (key: string) => void }) {
  if (!items.length) return <Empty>暂无数据</Empty>
  const max = Math.max(...items.map((i) => i.value), 1)
  const fill = tone === 'chart' ? 'bg-chart-2' : 'bg-primary'
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={item.key ?? item.label}>
          <button type="button" disabled={!onSelect} onClick={() => onSelect?.(item.key ?? item.label)} className="group grid w-full grid-cols-[minmax(3em,max-content)_1fr_auto] items-center gap-3 rounded-md px-1 py-0.5 text-left enabled:hover:bg-accent">
            <span className="truncate text-right text-[13px] text-muted-foreground group-enabled:group-hover:text-foreground" title={item.label}>{item.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.span className={`block h-full rounded-full ${fill}`} initial={{ width: 0 }} animate={{ width: `${Math.max(1.5, (item.value / max) * 100)}%` }} transition={{ ...spring, delay: i * 0.04 }} />
            </span>
            <span className="min-w-[4.5em] text-right text-xs tabular-nums text-muted-foreground">{item.note ?? fmt(item.value)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 竖向柱状图（按天） */
export function Columns({ values, height = 180 }: { values: Array<{ label: string; value: number }>; height?: number }) {
  if (!values.length) return <Empty>暂无发布时间数据</Empty>
  const max = Math.max(...values.map((v) => v.value), 1)
  const step = Math.max(1, Math.ceil(values.length / 6))
  return (
    <div>
      <p className="mb-1 text-[11px] tabular-nums text-muted-foreground">峰值 {fmt(max)}</p>
      <div className="relative flex items-end gap-[3px] border-b" style={{ height }}>
        {values.map((v, i) => (
          <div key={v.label} className="group relative flex h-full flex-1 items-end">
            <motion.div
              className="w-full rounded-t-[3px] bg-chart-2/80 group-hover:bg-chart-2"
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(1, (v.value / max) * 100)}%` }}
              transition={{ ...spring, delay: Math.min(i * 0.012, 0.5) }}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground opacity-0 shadow-md transition group-hover:opacity-100">{v.label}：{fmt(v.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {values.map((v, i) => <span key={v.label} className="flex-1 overflow-visible whitespace-nowrap text-center text-[11px] text-muted-foreground">{i % step === 0 ? v.label : ''}</span>)}
      </div>
    </div>
  )
}

export type DensitySelection = { kind: 'peak' | 'bin'; index: number }

/**
 * 弹幕密度面积图：鼠标悬浮显示该时间段的条数和实际弹幕，点击任意位置在下方查看详情；
 * 高峰时段为粉色带，点在高峰里选中整个高峰。
 */
export function DensityArea({ timeline, binSec, peaks, bins, selected, onSelect }: { timeline: number[]; binSec: number; peaks: Peak[]; bins?: DanmakuGroup[][]; selected: DensitySelection | null; onSelect: (s: DensitySelection) => void }) {
  const id = useId()
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState(-1)
  if (!timeline.length) return <Empty>暂无弹幕时间数据</Empty>
  const box = { width: 1040, height: 220, left: 40, right: 12, top: 16, bottom: 28 }
  const { line, fill, max } = areaPaths(timeline, box)
  const plotW = box.width - box.left - box.right
  const plotH = box.height - box.top - box.bottom
  const total = timeline.length * binSec
  const sx = (sec: number) => box.left + Math.min(1, sec / total) * plotW
  // 与 areaPaths 的点位一致
  const px = (i: number) => box.left + (timeline.length === 1 ? plotW / 2 : (i / (timeline.length - 1)) * plotW)
  const py = (v: number) => box.top + plotH - (v / max) * plotH
  const peakOf = (i: number) => peaks.findIndex((p) => i * binSec >= p.start_sec && i * binSec < p.end_sec)
  const indexAt = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect()
    if (!rect || !rect.width) return -1
    return binAt(((clientX - rect.left) / rect.width * box.width - box.left) / plotW, timeline.length)
  }
  const select = (i: number) => {
    if (i < 0) return
    const peak = peakOf(i)
    onSelect(peak >= 0 ? { kind: 'peak', index: peak } : { kind: 'bin', index: i })
  }
  const ratio = hover >= 0 ? px(hover) / box.width : 0
  const groups = hover >= 0 ? (bins?.[hover] ?? []).slice(0, 5) : []
  return (
    <div className="relative">
      <svg ref={svg} viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full touch-pan-y overflow-visible" role="img" aria-label="弹幕密度">
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((r) => <line key={r} x1={box.left} x2={box.width - box.right} y1={box.top + plotH * r} y2={box.top + plotH * r} stroke="var(--border)" strokeDasharray="4 6" />)}
        {peaks.map((p, i) => {
          const active = selected?.kind === 'peak' && selected.index === i
          return (
            <rect
              key={p.start_sec}
              x={sx(p.start_sec)}
              y={box.top}
              width={Math.max(5, sx(p.end_sec) - sx(p.start_sec))}
              height={plotH}
              rx={4}
              tabIndex={0}
              role="button"
              aria-label={`高峰 ${clock(p.start_sec)}–${clock(p.end_sec)}，${fmt(p.count)} 条`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ kind: 'peak', index: i }) } }}
              className={`outline-none transition-[fill] ${active ? 'fill-chart-1/30' : 'fill-chart-1/12 focus-visible:fill-chart-1/25'}`}
            />
          )
        })}
        {selected?.kind === 'bin' && <line x1={px(selected.index)} x2={px(selected.index)} y1={box.top} y2={box.top + plotH} stroke="var(--chart-1)" strokeWidth={2} />}
        <motion.path d={fill} fill={`url(#${id}-fill)`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.3 }} />
        <motion.path d={line} fill="none" stroke="var(--chart-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }} />
        <line x1={box.left} x2={box.width - box.right} y1={box.top + plotH} y2={box.top + plotH} stroke="var(--border)" />
        <text x={box.left - 6} y={box.top + 8} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{fmt(max)}</text>
        {[0, 1, 2, 3, 4, 5].map((k) => <text key={k} x={sx((total * k) / 5)} y={box.height - 6} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{clock((total * k) / 5)}</text>)}
        {hover >= 0 && (
          <g className="pointer-events-none">
            <line x1={px(hover)} x2={px(hover)} y1={box.top} y2={box.top + plotH} stroke="var(--foreground)" strokeOpacity={0.35} strokeDasharray="3 3" />
            <circle cx={px(hover)} cy={py(timeline[hover]!)} r={4.5} fill="var(--background)" stroke="var(--chart-2)" strokeWidth={2} />
          </g>
        )}
        {/* 透明感应层：鼠标或手指在图上移动时找最近的时间段 */}
        <rect
          x={box.left}
          y={box.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          className="cursor-pointer"
          onPointerMove={(e) => setHover(indexAt(e.clientX))}
          onPointerLeave={() => setHover(-1)}
          onClick={(e) => select(indexAt(e.clientX))}
        />
      </svg>
      {hover >= 0 && (
        <div
          className="pointer-events-none absolute top-0 z-20 w-72 max-w-[80%] rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
          style={ratio > 0.6 ? { right: `calc(${(1 - ratio) * 100}% + 12px)` } : { left: `calc(${ratio * 100}% + 12px)` }}
        >
          <p className="text-xs font-semibold tabular-nums">{clock(hover * binSec)}–{clock((hover + 1) * binSec)} · {fmt(timeline[hover])} 条{peakOf(hover) >= 0 && <span className="ml-1.5 font-normal text-chart-1">高峰</span>}</p>
          {groups.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {groups.map((g) => <li key={g.id} className="flex gap-2 text-xs leading-snug"><span className="shrink-0 tabular-nums text-muted-foreground">×{fmt(g.count)}</span><span className="line-clamp-2 break-all">{g.text}</span></li>)}
            </ul>
          ) : <p className="mt-1 text-xs text-muted-foreground">这段没有弹幕</p>}
          {groups.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">点击在下方查看</p>}
        </div>
      )}
    </div>
  )
}

/** 环形图，各段依次描出 */
export function Donut({ segments, center, size = 176, thickness = 22 }: { segments: Array<{ key: string; label: string; value: number; className: string }>; center: string; size?: number; thickness?: number }) {
  const r = size / 2 - thickness / 2
  const c = 2 * Math.PI * r
  const arcs = donutArcs(segments, c)
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-44 shrink-0" role="img" aria-label="分布">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={thickness} />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {arcs.map((a, i) => (
          <motion.circle
            key={a.key}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={thickness}
            strokeLinecap="butt"
            className={a.className}
            strokeDashoffset={-a.offset}
            initial={{ strokeDasharray: `0 ${c}` }}
            animate={{ strokeDasharray: `${a.length} ${c - a.length}` }}
            transition={{ duration: 0.7, delay: 0.15 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <title>{`${a.label}：${fmt(a.value)}`}</title>
          </motion.circle>
        ))}
      </g>
      <text x="50%" y="48%" textAnchor="middle" className="fill-foreground text-[26px] font-semibold tabular-nums">{center}</text>
      <text x="50%" y="62%" textAnchor="middle" className="fill-muted-foreground text-[12px]">条</text>
    </svg>
  )
}
