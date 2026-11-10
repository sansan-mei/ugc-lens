import { FileText, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Card, Empty, Spinner } from '../components/ui/card.tsx'
import { api } from '../lib/api.ts'
import { baseName } from '../lib/format.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import type { FileEntry, Overview } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export type ReportSelection = string | { name: string; text: string } | null
export function ReportsView({ report, setReport, recent, choose, o, openItem }: { report: ReportSelection; setReport: (r: ReportSelection) => void; recent: FileEntry[]; choose: () => void; o: Overview | null; openItem: (id: string) => void }) {
  const [list, setList] = useState<FileEntry[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const body = useRef<HTMLElement>(null)
  useEffect(() => { api<{ reports: FileEntry[] }>('reports').then((p) => setList(p.reports)).catch((e: Error) => setError(e.message)) }, [])
  useEffect(() => {
    let stale = false
    setError(''); setText('')
    if (!report) return
    if (typeof report !== 'string') { setText(report.text); return }
    setLoading(true)
    api<{ text: string }>(`report?path=${encodeURIComponent(report)}`).then((p) => { if (!stale) setText(p.text) }).catch((e: Error) => { if (!stale) setError(e.message) }).finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [report])
  useEffect(() => {
    if (!o || !body.current || !text) return
    let stale = false
    const buttons = [...body.current.querySelectorAll<HTMLButtonElement>('.cite')]
    const ids = [...new Set(buttons.map((b) => b.dataset.id).filter((s): s is string => !!s))]
    if (!ids.length) return
    api<{ existing: string[] }>(`datasets/${encodeURIComponent(o.id)}/check-ids`, { method: 'POST', body: JSON.stringify({ ids }) }).then((p) => {
      if (stale) return
      const found = new Set(p.existing)
      for (const b of buttons) if (!found.has(b.dataset.id!)) { b.classList.add('plain'); b.textContent = `[${b.dataset.id}]`; b.disabled = true }
    }).catch(() => {})
    return () => { stale = true }
  }, [text, o])
  const reports = [...recent.filter((r) => r.kind === 'report'), ...list]
  return <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
    <Card className="self-start p-4"><Button variant="secondary" className="mb-3 w-full" size="sm" onClick={choose}><FolderOpen />打开其他报告…</Button>
      <div className="space-y-1">{reports.map((r) => <button type="button" key={r.path} onClick={() => setReport(r.path)} className={cn('flex w-full gap-2 rounded-2xl px-3 py-3 text-left transition', report === r.path ? 'bg-white shadow-sm' : 'hover:bg-white/70')}><FileText className="mt-0.5 size-4 shrink-0 text-primary" /><span className="min-w-0"><b className="block truncate text-sm font-medium">{baseName(r.path)}</b><small className="mt-1 block break-all text-[11px] text-muted-foreground">{r.path}</small></span></button>)}</div>
      {!reports.length && <Empty>启动目录内没有报告</Empty>}
    </Card>
    <Card className="min-h-[480px] p-6 sm:p-8">
      {loading ? <Spinner label="读取报告…" /> : error ? <Empty>{error}</Empty> : text ? <article ref={body} className="prose-report" onClick={(e) => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cite'); if (b && !b.disabled && b.dataset.id) openItem(b.dataset.id) }} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : <Empty>选择左侧报告，或打开任意位置的 Markdown 文件。</Empty>}
    </Card>
  </div>
}
