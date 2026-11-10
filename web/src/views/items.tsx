import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ItemRow } from '../components/item_row.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, Empty, Spinner } from '../components/ui/card.tsx'
import { api } from '../lib/api.ts'
import { fmt, KIND } from '../lib/format.ts'
import type { ItemView, Overview } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export interface SearchState { query: string; kinds: string[]; sort: string }
export function ItemsView({ o, search, onSearch, openItem }: { o: Overview; search: SearchState; onSearch: (s: SearchState) => void; openItem: (id: string) => void }) {
  const [query, setQuery] = useState(search.query)
  const [page, setPage] = useState<{ total: number; items: ItemView[] }>({ total: 0, items: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setQuery(search.query) }, [search.query])
  useEffect(() => {
    let stale = false
    setLoading(true); setError('')
    const params = new URLSearchParams({ ...search, kinds: search.kinds.join(','), limit: '40' })
    api<{ total: number; items: ItemView[] }>(`datasets/${encodeURIComponent(o.id)}/items?${params}`).then((p) => { if (!stale) setPage(p) }).catch((e: Error) => { if (!stale) setError(e.message) }).finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [o.id, search])
  async function more() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ ...search, kinds: search.kinds.join(','), limit: '40', offset: String(page.items.length) })
      const next = await api<{ total: number; items: ItemView[] }>(`datasets/${encodeURIComponent(o.id)}/items?${params}`)
      setPage((p) => ({ total: next.total, items: [...p.items, ...next.items] }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }
  return <Card>
    <form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); onSearch({ ...search, query: query.trim() }) }}>
      <div className="relative min-w-[200px] flex-1"><Search className="absolute left-4 top-3 size-4 text-muted-foreground" /><input aria-label="关键词" className="h-10 w-full rounded-full border bg-white/75 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="关键词，空格表示都要出现，| 表示任一出现" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <select aria-label="排序" className="rounded-full border bg-white/75 px-4 text-sm" value={search.sort} onChange={(e) => onSearch({ ...search, sort: e.target.value })}>{[['likes', '按点赞'], ['replies', '按回复数'], ['newest', '最新'], ['oldest', '最早'], ['video_time', '视频时间']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
      <Button type="submit">检索</Button>
    </form>
    <div className="my-4 flex flex-wrap gap-2">{Object.entries(o.stats.items).filter(([, n]) => n > 0).map(([kind, n]) => <button key={kind} type="button" aria-pressed={search.kinds.includes(kind)} onClick={() => onSearch({ ...search, kinds: search.kinds.includes(kind) ? search.kinds.filter((k) => k !== kind) : [...search.kinds, kind] })} className={cn('rounded-full px-3 py-1 text-xs transition', search.kinds.includes(kind) ? 'bg-primary/15 text-primary ring-1 ring-primary/20' : 'bg-white/70 text-muted-foreground hover:bg-white')}>{KIND[kind]} <span className="ml-1 tabular-nums opacity-70">{fmt(n)}</span></button>)}</div>
    <p className="mb-2 text-xs text-muted-foreground">共 {fmt(page.total)} 条{search.query ? `匹配“${search.query}”` : ''}</p>
    {error && <Empty>{error}</Empty>}
    <div className="-mx-3 divide-y divide-black/[0.035]">{page.items.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)}</div>
    {!loading && !page.items.length && !error && <Empty>没有匹配的原文</Empty>}
    {loading ? <Spinner label="读取原文…" /> : page.items.length < page.total && <div className="mt-5 text-center"><Button variant="secondary" onClick={more}>加载更多</Button></div>}
  </Card>
}
