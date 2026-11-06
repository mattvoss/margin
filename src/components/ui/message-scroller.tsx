import * as React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

function MessageScroller({ className, ...props }: React.ComponentProps<typeof ScrollArea>) {
  return <ScrollArea data-slot="message-scroller" className={cn('min-h-0 flex-1', className)} {...props} />
}

export { MessageScroller }
