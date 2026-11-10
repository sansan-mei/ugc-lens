import { Button as MotionButton, type ButtonProps as MotionButtonProps } from '@animate-ui/react/primitives/buttons/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

// 样式与 Animate UI / shadcn 的 Button 一致，按压反馈由 Animate UI 的 Button 原语提供
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = MotionButtonProps & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, hoverScale = 1.03, tapScale = 0.95, type = 'button', ...props }: ButtonProps) {
  return <MotionButton data-slot="button" type={type} hoverScale={hoverScale} tapScale={tapScale} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
