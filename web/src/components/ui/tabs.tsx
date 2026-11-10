import { Tabs as TabsRoot, TabsContent as TabsContentPrimitive, TabsList as TabsListPrimitive, TabsTrigger as TabsTriggerPrimitive } from '@animate-ui/react/primitives/radix-ui/tabs'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export const Tabs = TabsRoot

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsListPrimitive>) {
  return <TabsListPrimitive className={cn('inline-flex items-center gap-1 rounded-full bg-black/[0.045] p-1', className)} {...props} />
}

// 动画指示条会复制选中项的样式，所以选中态的背景和阴影写在触发器上
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsTriggerPrimitive>) {
  return (
    <TabsTriggerPrimitive
      className={cn(
        'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4',
        'data-[state=active]:bg-white data-[state=active]:text-foreground data-[state=active]:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.15)]',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsContentPrimitive>) {
  return <TabsContentPrimitive className={cn('outline-none', className)} {...props} />
}
