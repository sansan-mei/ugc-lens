import { CountingNumber } from '@animate-ui/react/primitives/texts/counting-number'
import { Fade } from '@animate-ui/react/primitives/effects/fade'
import { ExternalLink, LoaderCircle, Play, RotateCcw, Settings, Sparkles } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { BarList, Columns, DensityArea, Donut } from '../components/charts.tsx'
import { ItemRow } from '../components/item_row.tsx'
import { Badge, Card, CardHeader, Empty, Notice } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { api } from '../lib/api.ts'
import { ANALYSIS_TASKS, analysisTaskView, anyRunning, type AnalysisSettings, type AnalysisStatus, type AnalysisTask } from '../lib/analysis.ts'
import { baseName, clock, fmt, KIND, pct } from '../lib/format.ts'
import type { LabelResult, Overview, Term } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

const SENTIMENT = [
  ['positive', '正面', 'stroke-positive', 'bg-positive'],
  ['neutral', '中性', 'stroke-neutral', 'bg-neutral'],
  ['negative', '负面', 'stroke-negative', 'bg-negative'],
  ['mixed', '混合', 'stroke-mixed', 'bg-mixed'],
  ['uncertain', '无法判断', 'stroke-uncertain', 'bg-uncertain'],
] as const

interface Actions { openItem: (id: string) => void; search: (query: string, kinds?: string[]) => void; reload: () => void; settings: () => void }

function Reveal({ children, className, index }: { children: React.ReactNode; className?: string; index: number }) {
  return <Fade inView inViewOnce delay={Math.min(index * 60, 360)} className={className}>{children}</Fade>
}

export function OverviewView({ o, ...actions }: { o: Overview } & Actions) {
  const content = o.contents.length === 1 ? o.contents[0] : undefined
  const title = content?.title ?? (o.contents.length > 1 ? `${o.contents.length} 个内容` : baseName(o.file))
  const counts = Object.entries(o.stats.items).filter(([, n]) => n > 0)
  const cards: Array<{ span: string; node: React.ReactNode }> = []
  const [peak, setPeak] = useState(0)

  if (o.danmaku?.timeline.length) {
    const d = o.danmaku
    cards.push({
      span: 'lg:col-span-12',
      node: (
        <Card>
          <CardHeader title="弹幕密度" sub={`每 ${d.bin_sec} 秒一段，共 ${fmt(d.total)} 条，去重后 ${fmt(d.unique)} 种。${d.peaks.length ? '粉色区域是高峰，点击查看这段在刷什么。' : '没有明显高于平时的时段。'}`} />
          <DensityArea timeline={d.timeline} binSec={d.bin_sec} peaks={d.peaks} active={peak} onPeak={setPeak} />
          {d.peaks.length > 0 && <PeakDetail peak={d.peaks[peak]!} onOpen={actions.openItem} />}
        </Card>
      ),
    })
  }
  if (o.daily.length) {
    cards.push({ span: 'lg:col-span-7', node: <Card className="h-full"><CardHeader title="发布时间" sub="评论、回复按天统计，弹幕没有发布时间。" /><Columns values={o.daily.map((d) => ({ label: d.day.slice(5), value: d.count }))} /></Card> })
  }
  if (o.stats.locations.length) {
    cards.push({
      span: o.daily.length ? 'lg:col-span-5' : 'lg:col-span-6',
      node: (
        <Card className="h-full">
          <CardHeader title="IP 属地" sub={`${fmt(o.stats.with_location)} 条带属地，占比按这些条目计算。`} />
          <BarList tone="chart" items={o.stats.locations.slice(0, 10).map((l) => ({ label: l.name, value: l.count, note: `${fmt(l.count)} · ${pct(l.count / o.stats.with_location)}` }))} />
        </Card>
      ),
    })
  }
  if (o.top.length) {
    cards.push({ span: 'lg:col-span-7', node: <Card className="h-full"><CardHeader title="高赞内容" sub="按点赞排序，点击查看全文和回复。" /><div className="-mx-3 space-y-0.5">{o.top.map((item) => <ItemRow key={item.id} item={item} onOpen={actions.openItem} />)}</div></Card> })
  }
  if (o.keywords.length || o.danmaku?.terms.length) {
    const textKinds = counts.map(([k]) => k).filter((k) => k !== 'danmaku')
    cards.push({
      span: 'lg:col-span-5',
      node: (
        <Card className="h-full">
          <CardHeader title="关键词" sub="数字为包含该词的条数，点击检索原文。" />
          {o.keywords.length > 0 && <TermCloud label="评论与回复" terms={o.keywords.slice(0, 24)} onPick={(w) => actions.search(w, textKinds)} />}
          {o.danmaku && o.danmaku.terms.length > 0 && <TermCloud label="弹幕" terms={o.danmaku.terms.slice(0, 16)} onPick={(w) => actions.search(w, ['danmaku'])} />}
        </Card>
      ),
    })
  }
  for (const label of o.labels) cards.push(labelCard(label, actions.openItem))
  cards.push({ span: 'lg:col-span-12', node: <AnalysisPanel datasetId={o.id} hasLabels={o.labels.length > 0} reload={actions.reload} settings={actions.settings} /> })

  return (
    <div className="space-y-6">
      <Fade inView inViewOnce>
        <section className="flex flex-wrap items-end justify-between gap-6 px-1 pt-2">
          <div className="min-w-0 max-w-3xl">
            <h1 className="text-[clamp(26px,3.4vw,38px)] font-semibold leading-tight tracking-tight">{title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge>{o.platform}</Badge>
              {content?.author && <span>{content.author}</span>}
              {content?.published_at && <span>{content.published_at.slice(0, 10)}</span>}
              {content?.url && <a href={content.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">原链接<ExternalLink className="size-3.5" /></a>}
              <Badge>{o.mapping === 'builtin' ? '内置规则读取' : o.mapping === 'cache' ? '缓存规则读取' : '模型识别结构'}</Badge>
            </div>
          </div>
          <div className="flex gap-3">
            {counts.map(([kind, n], i) => (
              <motion.div key={kind} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08, type: 'spring', stiffness: 200, damping: 22 }} className="min-w-[104px] rounded-xl border bg-card px-5 py-3.5 shadow-sm">
                <CountingNumber number={n} thousandSeparator="," className="block text-[28px] font-semibold tabular-nums tracking-tight" />
                <span className="text-xs text-muted-foreground">{KIND[kind] ?? kind}</span>
              </motion.div>
            ))}
          </div>
        </section>
      </Fade>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {cards.map((card, i) => <Reveal key={i} index={i} className={card.span}>{card.node}</Reveal>)}
      </div>
    </div>
  )
}

function TermCloud({ label, terms, onPick }: { label: string; terms: Term[]; onPick: (word: string) => void }) {
  return (
    <div className="mb-3">
      <p className="mb-2 text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {terms.map((t, i) => (
          <motion.button
            key={t.word}
            type="button"
            onClick={() => onPick(t.word)}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.95 }}
            transition={{ delay: Math.min(i * 0.015, 0.4) }}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-[13px] font-medium shadow-xs transition-colors hover:bg-accent"
          >
            {t.word}<span className="text-[11px] tabular-nums text-muted-foreground">{fmt(t.docs)}</span>
          </motion.button>
        ))}
      </div>
    </div>
  )
}

function PeakDetail({ peak, onOpen }: { peak: NonNullable<Overview['danmaku']>['peaks'][number]; onOpen: (id: string) => void }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div key={peak.start_sec} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }} className="mt-4 rounded-lg border bg-muted/40 p-4">
        <h3 className="text-sm font-semibold">{clock(peak.start_sec)}–{clock(peak.end_sec)} · {fmt(peak.count)} 条<span className="ml-2 font-normal text-muted-foreground">平时每段约 {peak.baseline.toFixed(1)} 条</span></h3>
        <div className="mt-2 grid gap-1 sm:grid-cols-3">
          {peak.groups.map((g) => (
            <button key={g.id} type="button" onClick={() => onOpen(g.id)} className="rounded-md border bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent">
              <div className="text-xs text-muted-foreground">×{fmt(g.count)}{g.first_sec !== undefined && ` · ${clock(g.first_sec)}`}</div>
              <div className="mt-0.5 line-clamp-2 text-sm">{g.text}</div>
            </button>
          ))}
        </div>
        {peak.terms.length > 0 && <p className="mt-2 text-xs text-muted-foreground">这段特有的词：{peak.terms.map((t) => t.word).join('、')}</p>}
      </motion.div>
    </AnimatePresence>
  )
}

function labelCard(label: LabelResult, openItem: (id: string) => void): { span: string; node: React.ReactNode } {
  const scope = label.summary.scope_note ? <p className="mt-3 text-xs text-muted-foreground">{label.summary.scope_note}</p> : null
  const coverage = `覆盖率 ${pct(label.coverage)}`
  if (label.task === 'sentiment') {
    const s = label.summary
    const stats = s.summary
    return {
      span: 'lg:col-span-6',
      node: (
        <Card className="h-full">
          <CardHeader title={label.source === 'model' ? '情感分布（模型分析）' : '情感分布'} sub={`评价对象：${s.target} · 已评估 ${fmt(stats.evaluated)}/${fmt(stats.total)} 条 · ${coverage}`} />
          <div className="flex flex-wrap items-center gap-6">
            <Donut center={fmt(stats.evaluated)} segments={SENTIMENT.map(([key, name, stroke]) => ({ key, label: name, value: stats.counts[key] ?? 0, className: stroke }))} />
            <ul className="min-w-[180px] flex-1 space-y-2 text-sm">
              {SENTIMENT.map(([key, name, , bg]) => (
                <li key={key} className="flex items-center gap-2">
                  <span className={cn('size-2.5 rounded-full', bg)} />{name}
                  <b className="ml-auto font-medium tabular-nums">{fmt(stats.counts[key])}<span className="ml-1.5 font-normal text-muted-foreground">{pct(stats.proportions[key])}</span></b>
                </li>
              ))}
              <li className="pt-1 text-xs text-muted-foreground">均值 {stats.mean_score === null ? '—' : stats.mean_score.toFixed(2)}（-1 到 1）</li>
            </ul>
          </div>
          {scope}
        </Card>
      ),
    }
  }
  if (label.task === 'topics') {
    const s = label.summary
    return {
      span: 'lg:col-span-6',
      node: (
        <Card className="h-full">
          <CardHeader title={label.source === 'model' ? '主题占比（模型分析）' : '主题占比'} sub={`逐条多标签归类，比例分母为成功归类条数，可超过 100% · ${coverage}`} />
          <BarList items={s.topics.map((t: { title: string; count: number; share: number }) => ({ label: t.title, value: t.count, note: `${fmt(t.count)} · ${pct(t.share)}` }))} />
          <p className="mt-3 text-xs text-muted-foreground">未归类 {fmt(s.unclassified)} 条，无法判断 {fmt(s.uncertain)} 条。</p>
          {scope}
        </Card>
      ),
    }
  }
  const s = label.summary
  const items = (s.opportunities ?? []).slice(0, 8) as Array<{ title: string; problem: string; quote: string; refs: string[]; priority: string; effort: string; validation: string }>
  return {
    span: 'lg:col-span-12',
    node: (
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-muted-foreground" />商业机会</span>} sub={`每条机会附原文证据；优先级为模型建议，需要验证 · ${coverage}`} />
        {items.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((op) => (
              <div key={op.title} className="rounded-lg border p-4">
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('rounded-md px-2 py-px font-medium', op.priority === 'high' ? 'bg-primary text-primary-foreground' : op.priority === 'medium' ? 'bg-secondary text-secondary-foreground border' : 'border text-muted-foreground')}>{op.priority === 'high' ? '高' : op.priority === 'medium' ? '中' : '低'}优先</span>
                  <span className="text-muted-foreground">{op.effort}</span>
                </div>
                <p className="mt-2 text-sm"><strong>{op.title}</strong>：{op.problem}</p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">“{op.quote}” {op.refs.map((id) => <button key={id} type="button" className="cite" onClick={() => openItem(id)}>{id}</button>)}</p>
                <p className="mt-1 text-xs text-muted-foreground">验证：{op.validation}</p>
              </div>
            ))}
          </div>
        ) : <Empty>没有发现有证据的机会</Empty>}
        {scope}
      </Card>
    ),
  }
}

/** 情感分析与主题统计：显示后台任务状态，可手动开始；进行中时轮询，完成后刷新概况 */
function AnalysisPanel({ datasetId, hasLabels, reload, settings }: { datasetId: string; hasLabels: boolean; reload: () => void; settings: () => void }) {
  const [status, setStatus] = useState<(AnalysisStatus & { settings: AnalysisSettings }) | null>(null)
  const [error, setError] = useState('')
  const wasRunning = useRef(false)
  const load = async () => {
    try {
      const next = await api<AnalysisStatus & { settings: AnalysisSettings }>(`datasets/${encodeURIComponent(datasetId)}/analysis`)
      setStatus(next)
      if (wasRunning.current && !anyRunning(next)) reload()
      wasRunning.current = anyRunning(next)
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { wasRunning.current = false; void load() }, [datasetId])
  useEffect(() => {
    if (!status || !anyRunning(status)) return
    const timer = setTimeout(() => void load(), 2000)
    return () => clearTimeout(timer)
  }, [status])
  const start = async (task: AnalysisTask) => {
    setError('')
    try {
      const next = await api<AnalysisStatus>(`datasets/${encodeURIComponent(datasetId)}/analysis/${task}`, { method: 'POST', body: '{}' })
      wasRunning.current = true
      setStatus((s) => s && { ...s, ...next })
    } catch (e) { setError((e as Error).message) }
  }
  const auto = status?.settings && (status.settings.auto_sentiment || status.settings.auto_topics)
  return (
    <Card>
      <CardHeader title="智能分析" sub={`用配置的模型逐条分析，每项最多消耗约 ${fmt(status?.settings.token_budget ?? 30000)} token。${auto ? '打开数据时会自动分析，可在设置里关闭。' : '自动分析已关闭，可在设置里开启。'}`} />
      <div className="grid gap-3 sm:grid-cols-2">
        {ANALYSIS_TASKS.map((t) => {
          const view = analysisTaskView(status?.[t.id] ?? { state: 'idle' })
          return <div key={t.id} className="flex items-start justify-between gap-3 rounded-lg border p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t.desc}</p>
              <p className={cn('mt-2 flex items-center gap-1.5 text-xs', status?.[t.id]?.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{view.running && <LoaderCircle className="size-3.5 animate-spin" />}{view.text}</p>
            </div>
            {view.action && <Button size="sm" variant={status?.[t.id]?.state === 'done' ? 'outline' : 'default'} className="shrink-0" onClick={() => void start(t.id)}>{status?.[t.id]?.state === 'done' ? <RotateCcw /> : <Play />}{view.action}</Button>}
          </div>
        })}
      </div>
      {error && <Notice className="mt-3 border-destructive/30 text-destructive">{error}</Notice>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{hasLabels ? '' : '也可以在 Claude Code、Codex 中使用 ugc-lens 技能逐条标注，结果同样显示在这里。'}</span>
        <Button size="sm" variant="ghost" onClick={settings}><Settings />分析设置</Button>
      </div>
    </Card>
  )
}
