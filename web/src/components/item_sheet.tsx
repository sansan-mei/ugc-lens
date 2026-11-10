import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { ItemView } from '../lib/types.ts'
import { ItemMeta, ItemRow } from './item_row.tsx'
import { Empty, Spinner } from './ui/card.tsx'
import { Sheet } from './ui/dialog.tsx'

export function ItemSheet({ id, datasetId, close, openItem }: { id: string | null; datasetId?: string; close: () => void; openItem: (id: string) => void }) {
  const [data, setData] = useState<{ item: ItemView; parent?: ItemView; replies: ItemView[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let stale = false
    setData(null); setError('')
    if (!id || !datasetId) return
    api<NonNullable<typeof data>>(`datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(id)}`).then((p) => { if (!stale) setData(p) }).catch((e: Error) => { if (!stale) setError(e.message) })
    return () => { stale = true }
  }, [id, datasetId])
  return <Sheet open={!!id} onOpenChange={(open) => { if (!open) close() }} title="原文详情">
    {error ? <Empty>{error}</Empty> : !data ? <Spinner label="读取原文…" /> : <>
      <ItemMeta item={data.item} extra />
      <p className="mt-4 whitespace-pre-wrap break-words text-base leading-[1.8]">{data.item.text}</p>
      <p className="mt-3 break-all text-xs text-muted-foreground">ID {data.item.id}</p>
      {data.parent && <><h3 className="mb-2 mt-7 text-xs font-medium text-muted-foreground">回复的是</h3><ItemRow className="border" item={data.parent} onOpen={openItem} /></>}
      {data.replies.length > 0 && <><h3 className="mb-2 mt-7 text-xs font-medium text-muted-foreground">直接回复（{data.replies.length}）</h3><div className="divide-y divide-black/5">{data.replies.map((r) => <ItemRow key={r.id} item={r} onOpen={openItem} />)}</div></>}
    </>}
  </Sheet>
}
