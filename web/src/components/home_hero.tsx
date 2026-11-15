import { ArrowRight, FileText, FolderOpen, MessageSquare, MousePointerClick, Quote } from 'lucide-react'
import { motion, type Variants } from 'motion/react'
import { Button } from './ui/button.tsx'
import { baseName, dirName, isUpload, kb } from '../lib/format.ts'
import { FORMAT_GROUPS } from '../lib/home.ts'
import type { FileEntry } from '../lib/types.ts'

// GSAP 常用的 expo.out 曲线：起步快、收尾长，适合入场
const EXPO = [0.16, 1, 0.3, 1] as const

const stage: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }
const rise: Variants = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EXPO } } }
// 标题逐行从遮罩下方升起
const line: Variants = { hidden: { y: '110%' }, show: { y: '0%', transition: { duration: 0.95, ease: EXPO } } }

export function HomeHero({ entries, recentLabel, onChoose, onOpen }: { entries: FileEntry[]; recentLabel: string; onChoose: () => void; onOpen: (f: FileEntry) => void }) {
  return (
    <section className="relative mx-auto max-w-[1200px]">
      <Backdrop />
      <motion.div variants={stage} initial="hidden" animate="show" className="grid items-center gap-12 py-[6vh] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
        <div className="min-w-0">
          <motion.div variants={rise} className="mb-6 inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-positive" /></span>
            数据留在本机 · 模型分析按你的配置调用
          </motion.div>
          <h1 className="text-[clamp(40px,5.6vw,68px)] font-semibold leading-[1.08] tracking-tight">
            <span className="block overflow-hidden pb-1"><motion.span variants={line} className="block">从原文里，</motion.span></span>
            <span className="block overflow-hidden pb-1"><motion.span variants={line} className="block bg-gradient-to-r from-foreground/45 to-foreground/80 bg-clip-text text-transparent">看清真实反馈。</motion.span></span>
          </h1>
          <motion.p variants={rise} className="mt-6 max-w-[34rem] text-base leading-relaxed text-muted-foreground sm:text-[17px]">
            打开评论、弹幕、问卷或工单，查看分布与趋势；每个结论都能沿着引用回到那一条原文。
          </motion.p>
          <motion.div variants={rise} className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button size="lg" data-action="choose" onClick={onChoose} className="group h-12 rounded-full px-7 text-[15px] has-[>svg]:px-6">
              <FolderOpen />选择数据文件<ArrowRight className="transition-transform duration-300 group-hover:translate-x-1" />
            </Button>
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><MousePointerClick className="size-4" />也可以直接把文件拖进窗口</span>
          </motion.div>
          <motion.div variants={rise} className="mt-7 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>支持</span>
            {FORMAT_GROUPS.map((g) => <span key={g.label} title={g.exts.join(' ')} className="rounded-md border bg-background/70 px-2 py-0.5 font-medium">{g.label}<span className="ml-1 font-normal opacity-70">{g.exts.map((e) => e.slice(1)).join(' / ')}</span></span>)}
          </motion.div>
        </div>
        <motion.div variants={rise} className="hidden lg:block" aria-hidden="true"><LensPreview /></motion.div>
      </motion.div>
      {entries.length > 0 && (
        <motion.div initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.55 } } }} className="pb-6">
          <motion.p variants={rise} className="mb-3 flex items-center gap-3 text-xs font-medium tracking-wide text-muted-foreground">{recentLabel}<span className="h-px flex-1 bg-border" /></motion.p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map((f) => (
              <motion.button key={f.path} type="button" variants={rise} whileHover={{ y: -3 }} transition={{ type: 'spring', stiffness: 380, damping: 26 }} onClick={() => onOpen(f)} className="group flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-[box-shadow,border-color] hover:border-ring/60 hover:shadow-md">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground"><FileText className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-sm font-medium">{baseName(f.path)}</b>
                  <small className="mt-0.5 block truncate text-xs text-muted-foreground" title={f.path}>{isUpload(f.path) ? '浏览器上传的副本' : dirName(f.path)}</small>
                </span>
                <small className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{kb(f.size)}</small>
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}
    </section>
  )
}

/** 点阵背景，用径向遮罩淡出边缘 */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_70%_60%_at_60%_35%,black,transparent)]" />
      <motion.div className="absolute right-[8%] top-[6%] size-[420px] rounded-full bg-chart-2/10 blur-3xl" animate={{ x: [0, 30, -10, 0], y: [0, -20, 15, 0] }} transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }} />
    </div>
  )
}

// 示意用的样例，不对应任何真实数据
const SAMPLES = [
  { kind: '评论', text: '续航比上一代好太多，就是价格有点劝退', tone: 'bg-mixed' },
  { kind: '弹幕', text: '这段讲得太清楚了！', tone: 'bg-positive' },
  { kind: '工单', text: '更新后登录一直失败，已经重装两次', tone: 'bg-negative' },
]
const BARS = [72, 46, 88, 34, 58, 64, 40]

/** 右侧示意：几条原文汇入一张统计卡片 */
function LensPreview() {
  return (
    <div className="relative mx-auto aspect-[1/1.02] w-full max-w-[520px]">
      {SAMPLES.map((s, i) => (
        <motion.div
          key={s.kind}
          initial={{ opacity: 0, x: -40, rotate: -4 }}
          animate={{ opacity: 1, x: 0, rotate: [-2, 1.5, -1][i] }}
          transition={{ delay: 0.5 + i * 0.14, duration: 0.9, ease: EXPO }}
          className="absolute z-10 w-[62%] rounded-xl border bg-card/95 p-3.5 shadow-lg backdrop-blur"
          style={{ left: `${[0, 8, 2][i]}%`, top: `${[0, 14, 28][i]}%` }}
        >
          <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 5 + i, repeat: Infinity, ease: 'easeInOut', delay: i * 0.6 }}>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground"><span className={`size-1.5 rounded-full ${s.tone}`} />{s.kind}<Quote className="ml-auto size-3 opacity-40" /></div>
            <p className="text-[13px] leading-snug">{s.text}</p>
          </motion.div>
        </motion.div>
      ))}
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.35, duration: 1.1, ease: EXPO }}
        className="absolute bottom-0 right-0 w-[72%] rounded-2xl border bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4 text-muted-foreground" />反馈概况</span>
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">样例</span>
        </div>
        <div className="flex h-24 items-end gap-2">
          {BARS.map((h, i) => (
            <motion.span key={i} className="flex-1 origin-bottom rounded-t-md bg-foreground/80" style={{ height: `${h}%`, opacity: 0.25 + (h / 100) * 0.75 }} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: 0.9 + i * 0.06, duration: 0.8, ease: EXPO }} />
          ))}
        </div>
        <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted">
          {[['bg-positive', 46], ['bg-neutral', 24], ['bg-mixed', 12], ['bg-negative', 18]].map(([c, w], i) => (
            <motion.span key={String(c)} className={String(c)} initial={{ width: 0 }} animate={{ width: `${w}%` }} transition={{ delay: 1.3 + i * 0.08, duration: 0.9, ease: EXPO }} />
          ))}
        </div>
        <div className="mt-2.5 flex justify-between text-[11px] text-muted-foreground"><span>正面 46%</span><span>负面 18%</span></div>
      </motion.div>
    </div>
  )
}
