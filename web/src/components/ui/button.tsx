import { Button as MotionButton, type ButtonProps as MotionButtonProps } from '@animate-ui/react/primitives/buttons/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors outline-none focus-visible:ring-4 focus-visible:ring-ring/40 disabled:opacity-45 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[0_8px_20px_-8px_rgba(0,113,227,0.7)] hover:bg-[#0077ed]',
        secondary: 'bg-muted text-foreground hover:bg-black/[0.08]',
        ghost: 'text-foreground/80 hover:bg-muted hover:text-foreground',
        outline: 'border border-border bg-white/70 hover:bg-white',
        link: 'text-primary hover:underline px-0',
      },
      size: {
        default: 'h-10 px-5 text-[15px]',
        sm: 'h-8 px-3.5 text-[13px]',
        lg: 'h-12 px-7 text-base',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = MotionButtonProps & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, hoverScale = 1.02, tapScale = 0.96, type = 'button', ...props }: ButtonProps) {
  return <MotionButton type={type} hoverScale={hoverScale} tapScale={tapScale} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
