import { Dialog, DialogClose, DialogContent as DialogContentPrimitive, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from '@animate-ui/react/primitives/radix-ui/dialog'
import { Drawer } from '@animate-ui/react/primitives/radix-ui/drawer'
import { X } from 'lucide-react'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export { Dialog, DialogDescription, DialogTitle }

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogContentPrimitive>) {
  return (
    <DialogPortal>
      <DialogOverlay className="fixed inset-0 z-50 bg-[rgba(20,30,50,0.18)] backdrop-blur-[6px]" />
      <DialogContentPrimitive
        className={cn('glass-strong fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[min(680px,calc(100%-24px))] -translate-x-1/2 flex-col rounded-[30px] p-6 outline-none', className)}
        {...props}
      >
        {children}
        <DialogClose className="absolute right-4 top-4 grid size-8 place-items-center rounded-full bg-black/[0.05] text-muted-foreground transition hover:bg-black/10 hover:text-foreground" aria-label="关闭">
          <X className="size-4" />
        </DialogClose>
      </DialogContentPrimitive>
    </DialogPortal>
  )
}

/** 右侧抽屉：查看原文详情 */
export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[rgba(20,30,50,0.16)] backdrop-blur-[3px]" />
        <Drawer.Content className="glass-strong fixed inset-y-3 right-3 z-50 flex w-[min(520px,calc(100%-24px))] flex-col rounded-[28px] outline-none">
          <div className="flex items-center justify-between border-b border-black/5 px-6 py-4">
            <Drawer.Title className="text-base font-semibold">{title}</Drawer.Title>
            <Drawer.Close className="grid size-8 place-items-center rounded-full bg-black/[0.05] text-muted-foreground transition hover:bg-black/10 hover:text-foreground" aria-label="关闭">
              <X className="size-4" />
            </Drawer.Close>
          </div>
          <Drawer.Description className="sr-only">原文、上级与回复</Drawer.Description>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
