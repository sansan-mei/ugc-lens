import { Dialog, DialogClose, DialogContent as DialogContentPrimitive, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from '@animate-ui/react/primitives/radix-ui/dialog'
import { Drawer } from '@animate-ui/react/primitives/radix-ui/drawer'
import { X } from 'lucide-react'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export { Dialog, DialogDescription, DialogTitle }

const closeClass = "rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogContentPrimitive>) {
  return (
    <DialogPortal>
      <DialogOverlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
      <DialogContentPrimitive
        className={cn('fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-4 rounded-lg border bg-background p-6 shadow-lg outline-none', className)}
        {...props}
      >
        {children}
        <DialogClose className={cn('absolute right-4 top-4', closeClass)} aria-label="关闭"><X /></DialogClose>
      </DialogContentPrimitive>
    </DialogPortal>
  )
}

/** 右侧 Sheet：查看原文详情 */
export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Drawer.Content className="fixed inset-y-0 right-0 z-50 flex h-full w-[min(480px,100%)] flex-col border-l bg-background shadow-lg outline-none">
          <div className="flex items-center justify-between gap-2 p-4">
            <Drawer.Title className="font-semibold">{title}</Drawer.Title>
            <Drawer.Close className={closeClass} aria-label="关闭"><X /></Drawer.Close>
          </div>
          <Drawer.Description className="sr-only">原文、上级与回复</Drawer.Description>
          <div className="flex-1 overflow-y-auto px-4 pb-6">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
