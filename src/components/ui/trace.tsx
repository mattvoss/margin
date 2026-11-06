import * as React from 'react'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="trace" className={cn('flex flex-col', className)} {...props} />
}

function TraceCollapsible({ className, ...props }: React.ComponentProps<typeof Collapsible>) {
  return <Collapsible data-slot="trace-collapsible" className={cn('flex flex-col', className)} {...props} />
}

function TraceCollapsibleTrigger({ className, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  return <CollapsibleTrigger data-slot="trace-trigger" className={cn('text-left', className)} {...props} />
}

function TraceCollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent data-slot="trace-content" className={cn('pl-4', className)} {...props} />
}

function TraceLine({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="trace-line" className={cn('flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground', className)} {...props} />
}

function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-icon" className={cn('flex size-3.5 shrink-0 items-center justify-center', className)} {...props} />
}

function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('truncate', className)} {...props} />
}

function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-description" className={cn('shrink-0 text-muted-foreground/70', className)} {...props} />
}

export { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceIcon, TraceTitle, TraceDescription }
