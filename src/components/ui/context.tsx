import * as React from 'react'
import { cn } from '@/lib/utils'

function Context({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="context" className={cn('flex flex-col gap-1', className)} {...props} />
}

function ContextLabel({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="context-label" className={cn('text-[10px] text-muted-foreground', className)} {...props} />
}

function ContextValue({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="context-value" className={cn('font-mono text-[10px] tabular-nums', className)} {...props} />
}

export { Context, ContextLabel, ContextValue }
