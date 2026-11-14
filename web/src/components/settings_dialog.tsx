import { Check, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './ui/button.tsx'
import { inputClass, Notice } from './ui/card.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.tsx'
import { api } from '../lib/api.ts'
import { defaultEndpoint, formBody, initialForm, keyPlaceholder, type SettingsForm } from '../lib/settings.ts'
import type { SettingsView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

const label = 'grid gap-1.5 text-sm font-medium'
const hint = 'text-xs font-normal text-muted-foreground'

/** 模型设置：选择提供商、填写 key 和模型，写入全局配置 ~/.ugc-lens/config.json */
export function SettingsDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved: (view: SettingsView) => void }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<SettingsForm>({ provider: '', region: 'cn', base_url: '', model: '', api_key: '' })
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState<'' | 'load' | 'models' | 'test' | 'save'>('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setMessage(null); setModels([]); setBusy('load')
    api<SettingsView>('settings').then((v) => { setView(v); setForm(initialForm(v)) }).catch((e) => setMessage({ ok: false, text: (e as Error).message })).finally(() => setBusy(''))
  }, [open])

  const provider = view?.providers.find((p) => p.id === form.provider)
  const set = (patch: Partial<SettingsForm>) => { setForm((f) => ({ ...f, ...patch })); setMessage(null) }
  const run = async (kind: 'models' | 'test' | 'save') => {
    setBusy(kind); setMessage(null)
    try {
      const body = JSON.stringify(formBody(form))
      if (kind === 'models') {
        const list = (await api<{ models: string[] }>('settings/models', { method: 'POST', body })).models
        setModels(list)
        setMessage({ ok: true, text: `共 ${list.length} 个模型，可在“模型”里选择或直接输入` })
      } else if (kind === 'test') {
        const r = await api<{ ok: boolean; error?: string }>('settings/test', { method: 'POST', body })
        setMessage(r.ok ? { ok: true, text: '测试通过：模型可以正常回答并调用工具' } : { ok: false, text: `测试失败：${r.error}` })
      } else {
        const saved = await api<SettingsView>('settings', { method: 'PUT', body })
        setView(saved); setForm(initialForm(saved)); onSaved(saved)
        setMessage(saved.effective.ok ? { ok: true, text: '已保存，新的对话和分析会使用这个模型' } : { ok: false, text: `已保存，但当前仍不可用：${saved.effective.error}` })
      }
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }) } finally { setBusy('') }
  }
  const missingKey = provider?.key === 'required' && !form.api_key.trim() && keyPlaceholder(form, view!).startsWith('接口地址已变')
  const canSubmit = !!provider && (provider.id !== 'custom' || !!form.base_url.trim()) && !busy

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <DialogContent className="top-[8vh] max-h-[84vh] w-[min(600px,calc(100%-2rem))]">
      <DialogTitle className="text-lg font-semibold leading-none">模型设置</DialogTitle>
      <DialogDescription className="-mt-2 text-sm text-muted-foreground">对话、结构识别和分析使用这里的模型。保存到 {view ? <code className="font-mono text-xs">{view.path}</code> : '全局配置'}（仅本机，权限 600），与 <code className="font-mono text-xs">ugc-lens init</code> 相同。</DialogDescription>
      {busy === 'load' || !view ? <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取配置…</p> : <form className="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void run('save') }}>
        {view.overrides.length > 0 && <Notice className="text-xs">以下设置会覆盖这里保存的值：{view.overrides.join('、')}</Notice>}
        <label className={label}>提供商
          <select aria-label="提供商" value={form.provider} onChange={(e) => { set({ provider: e.target.value, base_url: '', model: '' }); setModels([]) }} className={inputClass}>
            <option value="" disabled>选择提供商</option>
            {view.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {provider?.regions && <label className={label}>接口区域
          <select aria-label="接口区域" value={form.region} onChange={(e) => set({ region: e.target.value as 'cn' | 'global' })} className={inputClass}>
            <option value="cn">国内</option><option value="global">国际</option>
          </select>
        </label>}
        {provider && <label className={label}>接口地址{provider.id === 'custom' ? '' : <span className={hint}>（可选，使用中转或代理时填写）</span>}
          <input aria-label="接口地址" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} className={inputClass} placeholder={defaultEndpoint(provider, form.region) || 'http://localhost:8000/v1'} spellCheck={false} />
        </label>}
        {provider && provider.key !== 'none' && <label className={label}>API key{provider.key === 'optional' && <span className={hint}>（可选）</span>}
          <input aria-label="API key" type="password" autoComplete="off" value={form.api_key} onChange={(e) => set({ api_key: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder={keyPlaceholder(form, view)} spellCheck={false} />
        </label>}
        {provider && <label className={label}>模型
          <div className="flex gap-2">
            <input aria-label="模型" list="ugc-lens-models" value={form.model} onChange={(e) => set({ model: e.target.value })} className={inputClass} placeholder={models.length ? '从列表选择或输入' : '输入模型名，或点右侧获取列表'} spellCheck={false} />
            <Button type="button" variant="outline" disabled={!canSubmit} onClick={() => void run('models')}>{busy === 'models' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}获取列表</Button>
          </div>
          <datalist id="ugc-lens-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>}
        {message && <Notice role="status" className={message.ok ? '' : 'border-destructive/30 text-destructive'}>{message.text}</Notice>}
        {missingKey && !message && <p className="text-xs text-muted-foreground">已保存的 key 不会发往新的接口地址，请重新填写。</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" disabled={!canSubmit || !form.model.trim()} onClick={() => void run('test')}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <KeyRound />}测试连接</Button>
          <Button type="submit" disabled={!canSubmit || !form.model.trim()}>{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog.Root>
}
