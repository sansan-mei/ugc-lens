import { Check, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './ui/button.tsx'
import { inputClass, Notice } from './ui/card.tsx'
import { api } from '../lib/api.ts'
import { ANALYSIS_TASKS, type AnalysisSettings } from '../lib/analysis.ts'
import type { SettingsView } from '../lib/types.ts'

/** 分析设置：打开数据时是否自动跑情感分析、主题统计，以及每项的 token 预算 */
export function AnalysisSettingsPanel({ view, onSaved }: { view: SettingsView; onSaved: (view: SettingsView) => void }) {
  const [form, setForm] = useState<AnalysisSettings>(view.analysis)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setForm(view.analysis) }, [view.analysis])
  const keys = { sentiment: 'auto_sentiment', topics: 'auto_topics' } as const
  const save = async () => {
    setBusy(true); setMessage(null)
    try {
      const saved = await api<SettingsView>('settings/analysis', { method: 'PUT', body: JSON.stringify(form) })
      onSaved(saved)
      setMessage({ ok: true, text: saved.analysis.auto_sentiment || saved.analysis.auto_topics ? '已保存：之后打开还没有分析过的数据时会在后台自动分析' : '已保存：不自动分析，可以在概况页手动开始' })
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!busy) void save() }}>
    <p className="text-xs text-muted-foreground">打开数据后用配置的模型在后台逐条分析，结果显示在概况页，并保存在启动目录的 <code className="font-mono">.ugc-lens/ui/analysis/</code>。默认开启；同一份数据分析过就不再自动重跑。逐条分析会消耗模型 token，每项不超过下面的预算，不需要时可以关闭。</p>
    {!view.effective.ok && <Notice className="text-xs">还没有可用的模型，自动分析会跳过。请先在“模型”里完成配置。</Notice>}
    {ANALYSIS_TASKS.map((t) => <label key={t.id} className="flex items-start gap-3 text-sm">
      <input type="checkbox" aria-label={`打开数据时自动${t.name}`} className="mt-0.5 size-4 accent-primary" checked={form[keys[t.id]]} onChange={(e) => { setForm((f) => ({ ...f, [keys[t.id]]: e.target.checked })); setMessage(null) }} />
      <span className="grid gap-1"><span className="font-medium">打开数据时自动{t.name}</span><span className="text-xs text-muted-foreground">{t.desc}</span></span>
    </label>)}
    <label className="grid gap-1.5 text-sm font-medium">每项 token 预算<span className="text-xs font-normal text-muted-foreground">达到预算后停止，未评估部分会在结果里注明</span>
      <input aria-label="每项 token 预算" type="number" min={1000} max={1000000} step={1000} value={form.token_budget} onChange={(e) => { setForm((f) => ({ ...f, token_budget: Number(e.target.value) })); setMessage(null) }} className={inputClass} />
    </label>
    {message && <Notice role="status" className={message.ok ? '' : 'border-destructive/30 text-destructive'}>{message.text}</Notice>}
    <div className="flex justify-end pt-1"><Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button></div>
  </form>
}
