import { Check, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './ui/button.tsx'
import { inputClass, Notice } from './ui/card.tsx'
import { api } from '../lib/api.ts'
import type { SettingsView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { initialWebForm, webFormBody, webKeyPlaceholder, type WebForm } from '../lib/web_settings.ts'

const label = 'grid gap-1.5 text-sm font-medium'
const hint = 'text-xs font-normal text-muted-foreground'

/** 联网设置：开启后对话可以搜索网页、读取网页正文，写入全局配置的 web 字段 */
export function WebSettingsPanel({ view, onSaved }: { view: SettingsView; onSaved: (view: SettingsView) => void }) {
  const web = view.web
  const [form, setForm] = useState<WebForm>(() => initialWebForm(web))
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setForm(initialWebForm(web)) }, [web])
  const provider = web.providers.find((p) => p.id === form.provider)
  const set = (patch: Partial<WebForm>) => { setForm((f) => ({ ...f, ...patch })); setMessage(null) }
  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setMessage(null)
    try {
      const body = JSON.stringify(webFormBody(form))
      if (kind === 'test') {
        const r = await api<{ ok: boolean; results?: number; error?: string }>('settings/web/test', { method: 'POST', body })
        setMessage(r.ok ? { ok: true, text: `测试通过：搜索返回 ${r.results} 条结果` } : { ok: false, text: `测试失败：${r.error}` })
      } else {
        const saved = await api<SettingsView>('settings/web', { method: 'PUT', body })
        onSaved(saved)
        const e = saved.web.effective
        setMessage(!saved.web.enabled ? { ok: true, text: '已保存：联网已关闭' } : e.ok && e.enabled ? { ok: true, text: '已保存，新的对话可以联网查询' } : { ok: false, text: `已保存，但当前仍不可用：${e.ok ? '被环境变量关闭' : e.error}` })
      }
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }) } finally { setBusy('') }
  }
  const needsUrl = form.enabled && !provider?.base_url && !form.base_url.trim()

  return <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!busy && !needsUrl) void run('save') }}>
    {web.overrides.length > 0 && <Notice className="text-xs">以下环境变量会覆盖这里保存的值：{web.overrides.join('、')}</Notice>}
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" aria-label="对话时允许联网" className="mt-0.5 size-4 accent-primary" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      <span className="grid gap-1"><span className="font-medium">对话时允许联网</span><span className={hint}>数据里查不到、但与当前文件相关的问题（视频、商品、事件背景，评论里的梗和说法），模型会搜索网页并标注 [web:N] 来源。搜索词可能包含数据里的内容；网页内容不计入统计，也不能写入画像和手册。</span></span>
    </label>
    <label className={label}>搜索服务
      <select aria-label="搜索服务" value={form.provider} onChange={(e) => set({ provider: e.target.value, base_url: '' })} className={inputClass}>
        {web.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    <label className={label}>接口地址{provider?.base_url ? <span className={hint}>（可选，使用代理时填写）</span> : <span className={hint}>（必填，例如 http://localhost:8888）</span>}
      <input aria-label="搜索接口地址" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} className={inputClass} placeholder={provider?.base_url ?? 'http://localhost:8888'} spellCheck={false} />
    </label>
    {provider?.needs_key && <label className={label}>API key
      <input aria-label="搜索 API key" type="password" autoComplete="off" value={form.api_key} onChange={(e) => set({ api_key: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder={webKeyPlaceholder(form, web)} spellCheck={false} />
    </label>}
    {message && <Notice role="status" className={message.ok ? '' : 'border-destructive/30 text-destructive'}>{message.text}</Notice>}
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" variant="outline" disabled={!!busy || (!provider?.base_url && !form.base_url.trim())} onClick={() => void run('test')}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <Search />}测试搜索</Button>
      <Button type="submit" disabled={!!busy || needsUrl}>{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button>
    </div>
  </form>
}
