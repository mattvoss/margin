import { useState } from 'react'
import { Brain, ChevronDown, Loader2, Wrench } from 'lucide-react'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export function ReasoningTrace({
  text,
  running = false,
}: {
  text: string
  running?: boolean
}) {
  const [open, setOpen] = useState<boolean>()
  const line = (
    <TraceLine
      status={running ? 'running' : undefined}
      className="w-fit cursor-pointer select-none py-0.5 text-[10px]"
    >
      <TraceIcon>
        {running ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3" />}
      </TraceIcon>
      <TraceTitle>{running ? 'Thinking…' : 'Thought'}</TraceTitle>
      {text ? (
        <ChevronDown
          className={`size-3 transition-transform ${open ?? running ? 'rotate-180' : ''}`}
        />
      ) : null}
    </TraceLine>
  )

  if (!text) return <Trace>{line}</Trace>

  return (
    <Trace>
      <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="max-h-[320px] overflow-y-auto whitespace-pre-wrap border-l border-[var(--border-subtle)] pl-3 font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
          {text}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

export function ToolTrace({
  tool,
  detail,
  running = false,
}: {
  tool: string
  detail?: string
  running?: boolean
}) {
  const [open, setOpen] = useState(false)
  const line = (
    <TraceLine status={running ? 'running' : undefined} className="w-fit text-[10px]">
      <TraceIcon>
        {running ? <Loader2 className="size-3 animate-spin" /> : <Wrench className="size-3" />}
      </TraceIcon>
      <TraceTitle>{running ? `Running ${tool}` : `Tool · ${tool}`}</TraceTitle>
      {detail ? (
        <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      ) : null}
    </TraceLine>
  )

  if (!detail) return line
  return (
      <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap pl-5 text-[10px] text-[var(--text-muted)]">
        {detail}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
