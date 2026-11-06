import * as React from 'react'
import { cn } from '@/lib/utils'

function Message({ className, align = 'start', ...props }: React.ComponentProps<'article'> & { align?: 'start' | 'end' }) {
  return <article data-slot="message" data-align={align} className={cn('flex w-full flex-col gap-1.5', align === 'end' ? 'items-end' : 'items-start', className)} {...props} />
}

function MessageContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="message-content" className={cn('flex max-w-full flex-col gap-1.5', className)} {...props} />
}

function MessageFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="message-footer" className={cn('flex items-center gap-1', className)} {...props} />
}

export { Message, MessageContent, MessageFooter }
