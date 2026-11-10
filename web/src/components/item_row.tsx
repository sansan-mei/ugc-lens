import { clock, fmt, KIND } from '../lib/format.ts'
import type { ItemView } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export function ItemMeta({ item, extra }: { item: ItemView; extra?: boolean }) {
  const meta = [
    item.likes !== undefined ? `赞 ${fmt(item.likes)}` : '',
    item.reply_count ? `回复 ${fmt(item.reply_count)}` : '',
    item.video_time_sec !== undefined ? `视频 ${clock(item.video_time_sec)}` : '',
    item.location ?? '',
    extra ? item.created_at?.slice(0, 16).replace('T', ' ') ?? '' : item.created_at?.slice(0, 10) ?? '',
    item.author ?? '',
  ].filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
      <span className="rounded-md border px-1.5 py-px font-medium text-foreground">{KIND[item.kind] ?? item.kind}</span>
      {meta.map((m, i) => <span key={i}>{m}</span>)}
    </div>
  )
}

export function ItemRow({ item, onOpen, className }: { item: ItemView; onOpen: (id: string) => void; className?: string }) {
  return (
    <button type="button" onClick={() => onOpen(item.id)} className={cn('block w-full rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent', className)}>
      <ItemMeta item={item} />
      <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed">{item.text}</p>
    </button>
  )
}
