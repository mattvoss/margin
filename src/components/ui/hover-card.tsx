import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function HoverCard({ ...props }: React.ComponentProps<typeof Popover>) {
  return <Popover {...props} />
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof PopoverTrigger>) {
  return <PopoverTrigger {...props} />
}

function HoverCardContent({ ...props }: React.ComponentProps<typeof PopoverContent>) {
  return <PopoverContent {...props} />
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
