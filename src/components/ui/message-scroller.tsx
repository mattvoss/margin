import * as React from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { ArrowDown } from 'lucide-react'
import { ScrollBar } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface MessageScrollerContextValue {
  autoScroll: boolean
  isAtEnd: boolean
  setRoot: (root: HTMLDivElement | null) => void
  scrollToEnd: () => void
}

const MessageScrollerContext = React.createContext<MessageScrollerContextValue | null>(null)

function MessageScrollerProvider({
  autoScroll = false,
  children,
}: React.PropsWithChildren<{ autoScroll?: boolean }>) {
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null)
  const atEnd = React.useRef(true)
  const [isAtEnd, setIsAtEnd] = React.useState(true)

  const scrollToEnd = React.useCallback(() => {
    const viewport = root?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    atEnd.current = true
    setIsAtEnd(true)
  }, [root])

  React.useEffect(() => {
    if (!root) return
    const viewport = root.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    const content = root.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    if (!viewport || !content) return

    const updateAtEnd = () => {
      const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48
      atEnd.current = next
      setIsAtEnd((current) => current === next ? current : next)
    }
    const forceScrollToEnd = () => {
      viewport.scrollTop = viewport.scrollHeight
      atEnd.current = true
      setIsAtEnd(true)
    }
    const onScroll = () => updateAtEnd()
    viewport.addEventListener('scroll', onScroll, { passive: true })

    const observer = new MutationObserver((records) => {
      const newTurn = records.some((record) =>
        Array.from(record.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) return false
          return node.matches('[data-scroll-anchor="true"]') ||
            !!node.querySelector('[data-scroll-anchor="true"]')
        }),
      )
      if (autoScroll && (atEnd.current || newTurn)) forceScrollToEnd()
    })
    observer.observe(content, { childList: true, characterData: true, subtree: true })

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (autoScroll && atEnd.current) forceScrollToEnd()
        })
    resizeObserver?.observe(content)
    if (autoScroll) forceScrollToEnd()
    else updateAtEnd()

    return () => {
      viewport.removeEventListener('scroll', onScroll)
      observer.disconnect()
      resizeObserver?.disconnect()
    }
  }, [autoScroll, root])

  const context = React.useMemo(
    () => ({ autoScroll, isAtEnd, setRoot, scrollToEnd }),
    [autoScroll, isAtEnd, scrollToEnd],
  )
  return <MessageScrollerContext.Provider value={context}>{children}</MessageScrollerContext.Provider>
}

function MessageScroller({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  const context = React.useContext(MessageScrollerContext)
  return (
    <ScrollAreaPrimitive.Root
      ref={context?.setRoot}
      data-slot="message-scroller"
      className={cn('relative flex size-full min-h-0 flex-1 flex-col overflow-hidden', className)}
      {...props}
    >
      {children}
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>) {
  return (
    <ScrollAreaPrimitive.Viewport
      data-slot="message-scroller-viewport"
      role="region"
      aria-label="Messages"
      tabIndex={0}
      className={cn('size-full min-h-0 min-w-0 overscroll-contain', className)}
      {...props}
    />
  )
}

function MessageScrollerContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className={cn('flex min-h-full flex-col', className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  messageId,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<'div'> & { messageId: string; scrollAnchor?: boolean }) {
  return (
    <div
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? 'true' : 'false'}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  )
}

function MessageScrollerButton() {
  const context = React.useContext(MessageScrollerContext)
  if (!context || context.isAtEnd) return null
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="outline"
      aria-label="Scroll to latest message"
      title="Scroll to latest"
      className="absolute bottom-3 right-3 z-10 rounded-full shadow-sm"
      onClick={context.scrollToEnd}
    >
      <ArrowDown className="size-3.5" />
    </Button>
  )
}

export {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  MessageScrollerProvider,
}
