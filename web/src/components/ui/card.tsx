import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section className={cn('glass rounded-[28px] p-6', className)} {...props} />
}

export function CardHeader({ title, sub, action }: { title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

export function Badge({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-black/5', className)} {...props} />
}

export function Notice({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-2xl bg-primary/[0.06] px-4 py-3 text-sm leading-relaxed text-foreground/80 ring-1 ring-primary/10 [&_code]:rounded-md [&_code]:bg-black/[0.06] [&_code]:px-1.5', className)} {...props} />
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
      {label}
    </div>
  )
}
