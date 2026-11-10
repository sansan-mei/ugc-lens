import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('rounded-xl border bg-card p-6 text-card-foreground shadow-sm', className)} {...props} />
}

export function CardHeader({ title, sub, action }: { title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="space-y-1.5">
        <h2 className="font-semibold leading-none">{title}</h2>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

export function Badge({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="badge" className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium text-foreground', className)} {...props} />
}

export function Notice({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground', className)} {...props} />
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      {label}
    </div>
  )
}

export const inputClass = 'h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
