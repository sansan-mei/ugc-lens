import { motion } from 'motion/react'
import { useId } from 'react'
import { areaPaths, clock, donutArcs, fmt } from '../lib/format.ts'
import type { Peak } from '../lib/types.ts'
import { Empty } from './ui/card.tsx'

const spring = { type: 'spring', stiffness: 120, damping: 20 } as const

/** 横向条形：每行标签、条和数值，条从左向右依次长出 */
export function BarList({ items, tone = 'primary', onSelect }: { items: Array<{ label: string; value: number; note?: string; key?: string }>; tone?: 'primary' | 'violet'; onSelect?: (key: string) => void }) {
  if (!items.length) return <Empty>暂无数据</Empty>
  const max = Math.max(...items.map((i) => i.value), 1)
  const fill = tone === 'violet' ? 'from-violet to-pink' : 'from-primary to-violet'
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={item.key ?? item.label}>
          <button type="button" disabled={!onSelect} onClick={() => onSelect?.(item.key ?? item.label)} className="group grid w-full grid-cols-[minmax(56px,8.5em)_1fr_auto] items-center gap-3 rounded-xl px-1 py-0.5 text-left enabled:hover:bg-white/60">
            <span className="truncate text-right text-[13px] text-muted-foreground group-enabled:group-hover:text-foreground" title={item.label}>{item.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-black/[0.05]">
              <motion.span className={`block h-full rounded-full bg-gradient-to-r ${fill}`} initial={{ width: 0 }} animate={{ width: `${Math.max(1.5, (item.value / max) * 100)}%` }} transition={{ ...spring, delay: i * 0.04 }} />
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
      <div className="relative flex items-end gap-[3px] border-b border-black/10" style={{ height }}>
        <span className="absolute -top-1 left-0 text-[11px] tabular-nums text-muted-foreground">{fmt(max)}</span>
        {values.map((v, i) => (
          <div key={v.label} className="group relative flex h-full flex-1 items-end">
            <motion.div
              className="w-full rounded-t-[5px] bg-gradient-to-t from-violet/70 to-primary/80 group-hover:from-violet group-hover:to-primary"
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(1, (v.value / max) * 100)}%` }}
              transition={{ ...spring, delay: Math.min(i * 0.012, 0.5) }}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-lg bg-foreground/90 px-2 py-1 text-[11px] text-white opacity-0 transition group-hover:opacity-100">{v.label}：{fmt(v.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {values.map((v, i) => <span key={v.label} className="flex-1 overflow-visible whitespace-nowrap text-center text-[11px] text-muted-foreground">{i % step === 0 ? v.label : ''}</span>)}
      </div>
    </div>
  )
}

/** 弹幕密度面积图；高峰时段为可点击的粉色带 */
export function DensityArea({ timeline, binSec, peaks, active, onPeak }: { timeline: number[]; binSec: number; peaks: Peak[]; active: number; onPeak: (i: number) => void }) {
  const id = useId()
  if (!timeline.length) return <Empty>暂无弹幕时间数据</Empty>
  const box = { width: 1040, height: 220, left: 40, right: 12, top: 16, bottom: 28 }
  const { line, fill, max } = areaPaths(timeline, box)
  const plotW = box.width - box.left - box.right
  const plotH = box.height - box.top - box.bottom
  const total = timeline.length * binSec
  const sx = (sec: number) => box.left + Math.min(1, sec / total) * plotW
  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full overflow-visible" role="img" aria-label="弹幕密度">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#2f7bff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#7a5cff" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`${id}-line`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#0071e3" />
          <stop offset="60%" stopColor="#7a5cff" />
          <stop offset="100%" stopColor="#ff5c9a" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((r) => <line key={r} x1={box.left} x2={box.width - box.right} y1={box.top + plotH * r} y2={box.top + plotH * r} stroke="rgba(0,0,0,0.05)" strokeDasharray="4 6" />)}
      {peaks.map((p, i) => (
        <rect
          key={p.start_sec}
          x={sx(p.start_sec)}
          y={box.top}
          width={Math.max(5, sx(p.end_sec) - sx(p.start_sec))}
          height={plotH}
          rx={4}
          tabIndex={0}
          role="button"
          aria-label={`高峰 ${clock(p.start_sec)}–${clock(p.end_sec)}`}
          onClick={() => onPeak(i)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPeak(i) } }}
          className={`cursor-pointer outline-none transition-[fill] ${i === active ? 'fill-pink/30' : 'fill-pink/12 hover:fill-pink/22 focus-visible:fill-pink/25'}`}
        >
          <title>{`高峰 ${clock(p.start_sec)}–${clock(p.end_sec)}，${fmt(p.count)} 条`}</title>
        </rect>
      ))}
      <motion.path d={fill} fill={`url(#${id}-fill)`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.3 }} />
      <motion.path d={line} fill="none" stroke={`url(#${id}-line)`} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }} />
      <line x1={box.left} x2={box.width - box.right} y1={box.top + plotH} y2={box.top + plotH} stroke="rgba(0,0,0,0.12)" />
      <text x={box.left - 6} y={box.top + 8} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{fmt(max)}</text>
      {[0, 1, 2, 3, 4, 5].map((k) => <text key={k} x={sx((total * k) / 5)} y={box.height - 6} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{clock((total * k) / 5)}</text>)}
    </svg>
  )
}

/** 环形图，各段依次描出 */
export function Donut({ segments, center, size = 176, thickness = 22 }: { segments: Array<{ key: string; label: string; value: number; className: string }>; center: string; size?: number; thickness?: number }) {
  const r = size / 2 - thickness / 2
  const c = 2 * Math.PI * r
  const arcs = donutArcs(segments, c)
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-44 shrink-0" role="img" aria-label="分布">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth={thickness} />
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
      <text x="50%" y="48%" textAnchor="middle" className="fill-foreground text-[28px] font-semibold tabular-nums">{center}</text>
      <text x="50%" y="62%" textAnchor="middle" className="fill-muted-foreground text-[12px]">条</text>
    </svg>
  )
}
