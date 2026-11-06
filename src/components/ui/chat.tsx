import * as React from 'react'
import { cn } from '@/lib/utils'

function Chat({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="chat" className={cn('flex min-h-0 flex-1 flex-col', className)} {...props} />
}

function ChatMessages({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="chat-messages" className={cn('flex min-h-0 flex-1 flex-col', className)} {...props} />
}

export { Chat, ChatMessages }
