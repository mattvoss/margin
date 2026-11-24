import { useState } from 'react'
import {
  Circle,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { AssistMarkdown } from '@/components/AssistMarkdown'
import type { AssistStageStatus } from '@/lib/assist-stream'

export interface SubagentToolStep {
  name: string
  detail?: string
}

interface SubagentProps {
  name: string
  status: AssistStageStatus
  model?: string | null
  task?: string
  thinking?: string
  steps?: SubagentToolStep[]
  result?: string
}

export function Subagent({
  name,
  status,
  model,
  task,
  thinking,
  steps = [],
  result,
}: SubagentProps) {
  const [open, setOpen] = useState<boolean>()
  const running = status === 'running'
  const failed = status === 'failed'
  const complete = status === 'completed'
  const stopped = status === 'cancelled'
  const line = (
    <TraceLine
      status={failed ? 'error' : running ? 'running' : status === 'pending' ? 'pending' : undefined}
      className="w-fit cursor-pointer select-none py-0.5 text-[10px]"
    >
      <TraceIcon>
        {complete ? <CircleCheck className="size-3" /> : null}
        {running ? <LoaderCircle className="size-3 animate-spin" /> : null}
        {status === 'pending' || status === 'cancelled' ? <Circle className="size-3" /> : null}
        {failed ? <CircleAlert className="size-3" /> : null}
      </TraceIcon>
      <TraceTitle>
        {failed
          ? `Failed ${name} subagent`
          : stopped
            ? `Stopped ${name} subagent`
            : complete
              ? `Ran ${name} subagent`
              : running
                ? `Running ${name} subagent`
                : `Queued ${name} subagent`}
      </TraceTitle>
    </TraceLine>
  )

  return (
    <Trace>
      <TraceCollapsible open={open ?? true} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted className="flex flex-col gap-2 pl-5 text-[11px]">
          {(model || steps.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {model && <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">{model}</Badge>}
              {steps.map((step, index) => (
                <Badge key={`${step.name}-${index}`} variant="outline" className="h-4 px-1.5 font-mono text-[9px]">
                  {step.name}
                </Badge>
              ))}
            </div>
          )}
          {task && <p className="whitespace-pre-wrap text-[var(--text-secondary)]">{task}</p>}
          {thinking && (
            <div className="rounded border-l-2 border-[var(--border-subtle)] pl-2">
              <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Thinking</span>
              <p className="mt-0.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">{thinking}</p>
            </div>
          )}
          {steps.length > 0 && (
            <Trace className="gap-1">
              {steps.map((step, index) => (
                <div key={`${step.name}-detail-${index}`}>
                  <TraceLine className="text-[10px]">
                    <TraceIcon><CircleCheck className="size-3" /></TraceIcon>
                    <TraceTitle>Ran {step.name}</TraceTitle>
                  </TraceLine>
                  {step.detail && (
                    <p className="whitespace-pre-wrap pl-5 text-[10px] text-[var(--text-muted)]">
                      {step.detail}
                    </p>
                  )}
                </div>
              ))}
            </Trace>
          )}
          {result && (
            <div className="border-t border-[var(--border-subtle)] pt-1.5">
              <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Result</span>
              <AssistMarkdown className="assist-markdown mt-1">{result}</AssistMarkdown>
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
