import { Tabs as TabsRoot, TabsContent as TabsContentPrimitive, TabsList as TabsListPrimitive, TabsTrigger as TabsTriggerPrimitive } from '@animate-ui/react/primitives/radix-ui/tabs'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export const Tabs = TabsRoot

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsListPrimitive>) {
  return <TabsListPrimitive className={cn('inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground', className)} {...props} />
}

// 选中态写在触发器上，Animate UI 的滑动指示器会复制它
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsTriggerPrimitive>) {
  return (
    <TabsTriggerPrimitive
      className={cn(
        "inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 py-1 text-sm font-medium text-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4",
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsContentPrimitive>) {
  return <TabsContentPrimitive className={cn('flex-1 outline-none', className)} {...props} />
}
