import { AnimateUIProvider } from '@animate-ui/react/provider'
import { Fade } from '@animate-ui/react/primitives/effects/fade'
import { BarChart3, FileText, FolderOpen, History, MessageCircle, Search, Upload, Aperture } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Card, Empty, Notice, Spinner } from './components/ui/card.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog.tsx'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs.tsx'
import { ItemSheet } from './components/item_sheet.tsx'
import { api, ApiError, token, upload } from './lib/api.ts'
import { baseName, dirName, isUpload, kb } from './lib/format.ts'
import type { FileEntry, FilesResponse, Overview } from './lib/types.ts'
import { ItemsView, type SearchState } from './views/items.tsx'
import { OverviewView } from './views/overview.tsx'
import { ReportsView, type ReportSelection } from './views/reports.tsx'

const DATA_EXT = '.json,.jsonl,.ndjson,.csv,.tsv,.txt,.md,.markdown,.log'
const initialSearch: SearchState = { query: '', kinds: [], sort: 'likes' }

export default function App() {
  const [tab, setTab] = useState('overview')
  const [o, setO] = useState<Overview | null>(null)
  const [files, setFiles] = useState<FilesResponse>({ cwd: '', picker: false, recent: [], files: [] })
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [recentOpen, setRecentOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [itemId, setItemId] = useState<string | null>(null)
  const [report, setReport] = useState<ReportSelection>(null)
  const [search, setSearch] = useState<SearchState>(initialSearch)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pickKind = useRef<'data' | 'report'>('data')
  const dragDepth = useRef(0)

  async function refresh() { try { setFiles(await api<FilesResponse>('files')) } catch (e) { setToast((e as Error).message) } }
  useEffect(() => {
    if (!token) return
    void refresh()
    const last = localStorage.getItem('ugc-lens-last-file')
    if (last) void openFile(last)
  }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t) }, [toast])

  async function openFile(path: string) {
    setRecentOpen(false); setBusy('正在导入数据…')
    try {
      const loaded = await api<Overview>('open', { method: 'POST', body: JSON.stringify({ path }) })
      setO(loaded); setTab('overview'); setSearch(initialSearch)
      localStorage.setItem('ugc-lens-last-file', path)
      void refresh()
    } catch (e) { setToast((e as Error).message) } finally { setBusy('') }
  }
  function browserPick(kind: 'data' | 'report') {
    pickKind.current = kind
    if (!input.current) return
    input.current.accept = kind === 'report' ? '.md,.markdown' : DATA_EXT
    input.current.value = ''; input.current.click()
  }
  async function choose(kind: 'data' | 'report' = 'data') {
    setRecentOpen(false)
    if (!files.picker) return browserPick(kind)
    setToast('请在系统文件选择框里选择文件')
    try {
      const result = await api<{ path?: string; cancelled?: boolean }>('pick', { method: 'POST', body: JSON.stringify({ kind }) })
      setToast('')
      if (!result.path) return
      if (kind === 'report') { setReport(result.path); setTab('reports'); void refresh() }
      else await openFile(result.path)
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) { setFiles((f) => ({ ...f, picker: false })); browserPick(kind) }
      else setToast((e as Error).message)
    }
  }
  async function handleFile(file: File | undefined, kind: 'data' | 'report') {
    if (!file) return
    if (kind === 'report') {
      if (!/\.(md|markdown)$/i.test(file.name)) return setToast('请选择 Markdown 报告')
      setReport({ name: file.name, text: await file.text() }); setTab('reports'); return
    }
    setBusy(`正在读取 ${file.name}（${kb(file.size)}）…`)
    try { await openFile(await upload(file)) } catch (e) { setToast((e as Error).message) } finally { setBusy('') }
  }
  function openEntry(f: FileEntry) {
    setRecentOpen(false)
    if (f.kind === 'report') { setReport(f.path); setTab('reports') } else void openFile(f.path)
  }
  const openItem = (id: string) => { if (o) setItemId(id); else setToast('先打开对应的数据文件，才能查看引用原文') }
  const keywordSearch = (query: string, kinds: string[] = []) => { setSearch({ query, kinds, sort: 'likes' }); setTab('items') }
  const recent = files.recent.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
  const local = files.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
  function entry(f: FileEntry) {
    return <button key={f.path} type="button" onClick={() => openEntry(f)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-white/80"><FileText className="size-5 shrink-0 text-primary/70" /><span className="min-w-0 flex-1"><b className="block truncate text-sm font-medium">{baseName(f.path)}</b><small className="block truncate text-xs text-muted-foreground">{isUpload(f.path) ? '浏览器上传的副本' : dirName(f.path)}</small></span><small className="shrink-0 text-xs tabular-nums text-muted-foreground">{kb(f.size)}</small></button>
  }
  return <AnimateUIProvider><MotionConfig reducedMotion="user">
    <div onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true) } }} onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); setRecentOpen(false); const f = e.dataTransfer.files[0]; void handleFile(f, tab === 'reports' && !!f && /\.(md|markdown)$/i.test(f.name) ? 'report' : 'data') }} className="min-h-screen pb-12">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <header className="sticky top-0 z-30 border-b border-white/70 bg-white/55 backdrop-blur-2xl">
          <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-3 px-4 py-3 sm:px-8">
            <button type="button" className="flex items-center gap-2.5" onClick={() => setTab('overview')}><span className="grid size-9 place-items-center rounded-[12px] bg-gradient-to-br from-primary via-violet to-pink text-white shadow-md shadow-violet/20"><Aperture className="size-5" /></span><span className="hidden text-lg font-bold tracking-tight sm:block">ugc-lens</span></button>
            <TabsList className="min-w-0 overflow-x-auto" aria-label="视图">{[['overview', '概况', BarChart3], ['items', '原文', Search], ['reports', '报告', FileText], ['chat', '对话', MessageCircle]].map(([id, label, Icon]) => { const I = Icon as typeof BarChart3; return <TabsTrigger key={String(id)} value={String(id)} className="px-2.5 sm:px-3.5"><I /><span>{String(label)}</span></TabsTrigger> })}</TabsList>
            <div className="flex gap-1.5"><Button variant="ghost" size="icon" aria-label="最近打开" onClick={() => { setRecentOpen(true); void refresh() }}><History /></Button><Button id="open-file" className="px-3 sm:px-5" onClick={() => choose()}><FolderOpen /><span className="hidden sm:inline">打开数据</span><span className="sm:hidden">打开</span></Button></div>
          </div>
        </header>
        <main className="mx-auto max-w-[1360px] px-4 pt-7 sm:px-8">
          {!token ? <Card><Empty>缺少访问令牌，请使用 ugc-lens ui 启动时打印的完整网址。</Empty></Card> : busy ? <Card><Spinner label={busy} /></Card> : <AnimatePresence mode="wait"><motion.div key={tab + (o?.id ?? '')} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.18 }}>
            {(tab === 'overview' || tab === 'items') && !o ? <Fade><section className="mx-auto max-w-[740px] py-[8vh]"><div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs text-muted-foreground ring-1 ring-white">本地查看 · 模型分析按配置调用</div><h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">从原文里，<br /><span className="text-gradient">看清真实反馈。</span></h1><p className="mb-7 mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">打开评论、弹幕、问卷或工单，查看分布与趋势，沿着引用回到每一条原文。</p><div className="flex items-center gap-4"><Button size="lg" data-action="choose" onClick={() => choose()}><FolderOpen />选择文件…</Button><span className="text-sm text-muted-foreground">或把文件拖到这里</span></div>{(recent.length > 0 || local.length > 0) && <Card className="mt-9 p-3"><p className="px-3 py-2 text-xs font-medium text-muted-foreground">{recent.length ? '最近打开' : '启动目录里的文件'}</p>{(recent.length ? recent : local.map((f) => ({ ...f, path: `${files.cwd}/${f.path}` }))).slice(0, 5).map(entry)}</Card>}</section></Fade> : tab === 'overview' && o ? <OverviewView o={o} openItem={openItem} search={keywordSearch} /> : tab === 'items' && o ? <ItemsView o={o} search={search} onSearch={setSearch} openItem={openItem} /> : tab === 'reports' ? <ReportsView report={report} setReport={setReport} recent={files.recent} choose={() => choose('report')} o={o} openItem={openItem} /> : <Card><h1 className="mb-3 text-xl font-semibold">对话</h1><Notice>网页内对话将在下一阶段提供。现在可在终端运行 <code>ugc-lens</code>，或在 Claude Code、Codex 中安装技能，使用宿主模型提问。</Notice></Card>}
          </motion.div></AnimatePresence>}
        </main>
      </Tabs.Root>
      <Dialog.Root open={recentOpen} onOpenChange={setRecentOpen}><DialogContent><DialogTitle className="text-xl font-semibold">打开数据文件</DialogTitle><DialogDescription className="mt-1 text-sm text-muted-foreground">选择任意位置的文件，或从最近打开中继续。</DialogDescription><div className="my-5 flex flex-wrap items-center justify-center gap-3 rounded-3xl border border-dashed border-primary/30 bg-primary/[0.04] p-6"><Button onClick={() => choose()}><FolderOpen />选择文件…</Button><span className="text-xs text-muted-foreground">支持拖放</span></div><input aria-label="筛选文件" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-3 h-10 rounded-full border bg-white/80 px-4 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="筛选文件名" /><div className="min-h-0 overflow-auto">{recent.length > 0 && <><p className="px-3 py-2 text-xs text-muted-foreground">最近打开</p>{recent.map(entry)}</>}{local.length > 0 && <><p className="px-3 py-2 text-xs text-muted-foreground">启动目录</p>{local.map((f) => entry({ ...f, path: `${files.cwd}/${f.path}` }))}</>}{!recent.length && !local.length && <Empty>没有匹配文件</Empty>}</div></DialogContent></Dialog.Root>
      <ItemSheet id={itemId} datasetId={o?.id} close={() => setItemId(null)} openItem={openItem} />
      <input type="file" id="file-input" hidden ref={input} onChange={(e) => { void handleFile(e.target.files?.[0], pickKind.current) }} />
      <AnimatePresence>{toast && <motion.div role="status" initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }} className="fixed bottom-6 left-1/2 z-[70] max-w-[90vw] -translate-x-1/2 rounded-full bg-foreground/90 px-5 py-3 text-sm text-white shadow-xl backdrop-blur-xl">{toast}</motion.div>}</AnimatePresence>
      {dragging && <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center bg-primary/10 backdrop-blur-sm"><div className="glass-strong flex items-center gap-3 rounded-3xl px-8 py-6 text-lg font-semibold"><Upload className="text-primary" />松开即可打开文件</div></div>}
    </div>
  </MotionConfig></AnimateUIProvider>
}
