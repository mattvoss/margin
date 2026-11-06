import * as React from 'react'
import { cn } from '@/lib/utils'

function Bubble({ className, align = 'start', variant = 'default', ...props }: React.ComponentProps<'div'> & { align?: 'start' | 'end'; variant?: 'default' | 'muted' }) {
  return (
    <div
      data-slot="bubble"
      data-align={align}
      className={cn(
        'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed',
        align === 'end' && 'rounded-tr-sm',
        variant === 'muted' ? 'border border-border bg-muted' : 'bg-background',
        className,
      )}
      {...props}
    />
  )
}

function BubbleContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="bubble-content" className={cn('select-text', className)} {...props} />
}

export { Bubble, BubbleContent }
