import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  Compass,
  Copy,
  CornerDownLeft,
  Loader2,
  Plus,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { useEditorStore } from '../stores/editorStore'
import { useSettingsStore, type AppSettings } from '../stores/settingsStore'
import { toast } from '../stores/toastStore'
import { API_BASE, apiFetch } from '../lib/api'
import { streamSSE } from '../lib/stream-sse'
import { AssistMarkdown } from './AssistMarkdown'
import { Button } from '@/components/ui/button'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Chat, ChatMessages } from '@/components/ui/chat'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller } from '@/components/ui/message-scroller'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'

interface PlannerHarness {
  id: string
  name: string
  installed: boolean
  version: string | null
}

interface ScenePlannerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  harnessList: PlannerHarness[]
}

interface PlannerMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string
}

type ModelChoice =
  | { kind: 'endpoint'; id: string }
  | { kind: 'harness'; id: string }

const SUGGESTIONS = [
  'What should happen next?',
  'Outline three beats for the next scene.',
  'What conflict would raise the stakes?',
  'What is the strongest opening beat?',
]

const STORAGE_PREFIX = 'margin:scene-planner'

function storageKey(kind: 'session' | 'model', workspace: string): string {
  return `${STORAGE_PREFIX}:${kind}:${workspace}`
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in private windows; the session still works.
  }
}

function choiceKey(choice: ModelChoice): string {
  return `${choice.kind}:${choice.id}`
}

function parseChoice(value: string): ModelChoice | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  const kind = value.slice(0, idx)
  const id = value.slice(idx + 1)
  if (!id) return null
  if (kind === 'endpoint') return { kind: 'endpoint', id }
  if (kind === 'harness') return { kind: 'harness', id }
  return null
}

function availableChoice(
  choice: ModelChoice | null,
  settings: AppSettings,
  harnessList: PlannerHarness[],
): choice is ModelChoice {
  if (!choice) return false
  if (choice.kind === 'endpoint') return !!settings.endpoints?.[choice.id]
  return harnessList.some((h) => h.id === choice.id && h.installed)
}

function defaultChoice(settings: AppSettings, harnessList: PlannerHarness[]): ModelChoice | null {
  const configuredHarness = settings.default_harness
  if (
    configuredHarness &&
    configuredHarness !== 'none' &&
    harnessList.some((h) => h.id === configuredHarness && h.installed)
  ) {
    return { kind: 'harness', id: configuredHarness }
  }
  if (settings.active_endpoint && settings.endpoints?.[settings.active_endpoint]) {
    return { kind: 'endpoint', id: settings.active_endpoint }
  }
  const endpoint = Object.keys(settings.endpoints ?? {})[0]
  if (endpoint) return { kind: 'endpoint', id: endpoint }
  const harness = harnessList.find((h) => h.installed)
  return harness ? { kind: 'harness', id: harness.id } : null
}

function choiceLabel(
  choice: ModelChoice | null,
  settings: AppSettings,
  harnessList: PlannerHarness[],
): string {
  if (!choice) return 'Choose a model'
  if (choice.kind === 'endpoint') {
    const endpoint = settings.endpoints?.[choice.id]
    return endpoint?.model || choice.id.replace(/_/g, ' ')
  }
  const harness = harnessList.find((h) => h.id === choice.id)
  return harness?.name ?? choice.id
}

function cursorParagraph(): string {
  const state = useEditorStore.getState()
  const editor = state.editor
  if (!editor || editor.isDestroyed) return ''
  let paragraph = ''
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph' || node.type.name === 'heading') {
      const from = offset
      const to = offset + node.nodeSize
      if (state.anchorPosition >= from && state.anchorPosition < to) {
        paragraph = node.textContent
      }
    }
  })
  return paragraph
}

export function ScenePlanner({ open, onOpenChange, harnessList }: ScenePlannerProps) {
  const settings = useSettingsStore((s) => s.settings)
  const setShowSettings = useSettingsStore((s) => s.setShowSettings)
  const setSettingsTab = useSettingsStore((s) => s.setSettingsTab)
  const currentFilePath = useEditorStore((s) => s.currentFilePath)
  const workspace = settings.linked_workspace_dir ?? 'sample'

  const [sessionId, setSessionId] = useState<string>(() => {
    const stored = readStored(storageKey('session', workspace))
    return stored || crypto.randomUUID()
  })
  const [choice, setChoice] = useState<ModelChoice | null>(() => {
    const stored = readStored(storageKey('model', workspace))
    return (stored ? parseChoice(stored) : null) ?? null
  })
  const [messages, setMessages] = useState<PlannerMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [streamingModel, setStreamingModel] = useState<string | null>(null)
  const [toolRows, setToolRows] = useState<Array<{ tool: string; detail: string }>>([])
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef(0)
  const restoreSessionRef = useRef<string | null>(null)

  const endpoints = useMemo(() => Object.entries(settings.endpoints ?? {}), [settings.endpoints])
  const installedHarnesses = useMemo(
    () => harnessList.filter((h) => h.installed),
    [harnessList],
  )

  const resolvedChoice = useMemo(
    () =>
      availableChoice(choice, settings, harnessList)
        ? choice
        : defaultChoice(settings, harnessList),
    [choice, settings, harnessList],
  )
  const modelLabel = choiceLabel(resolvedChoice, settings, harnessList)

  useEffect(() => {
    writeStored(storageKey('session', workspace), sessionId)
  }, [sessionId, workspace])

  useEffect(() => {
    if (resolvedChoice) writeStored(storageKey('model', workspace), choiceKey(resolvedChoice))
  }, [resolvedChoice, workspace])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, streamingText, streamingThinking, toolRows.length, isRestoring])

  // Restore the persisted planner session the first time the dialog opens.
  useEffect(() => {
    if (!open || restoreSessionRef.current === sessionId) return
    restoreSessionRef.current = sessionId
    let cancelled = false
    setIsRestoring(true)
    apiFetch(
      `${API_BASE}/api/assist/simple/logs?session_id=${encodeURIComponent(sessionId)}&mode=planner`,
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return
        const restored: PlannerMessage[] = []
        for (const raw of data) {
          const log = raw as Record<string, unknown>
          const instruction = typeof log.instruction === 'string' ? log.instruction.trim() : ''
          const output = typeof log.output === 'string' ? log.output.trim() : ''
          const id = String(log.id ?? crypto.randomUUID())
          if (instruction) {
            restored.push({ id: `${id}-user`, role: 'user', content: instruction })
          }
          if (output) {
            restored.push({
              id: `${id}-assistant`,
              role: 'assistant',
              content: output,
              thinking:
                typeof log.thinking_output === 'string' && log.thinking_output
                  ? log.thinking_output
                  : undefined,
              model: typeof log.model_used === 'string' ? log.model_used : undefined,
            })
          }
        }
        setMessages((prev) => (prev.length > 0 ? prev : restored))
      })
      .catch((err) => {
        console.error('Failed to restore planner session:', err)
      })
      .finally(() => {
        if (!cancelled) setIsRestoring(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    if (sessionId) {
      void apiFetch(`${API_BASE}/api/assist/simple/stop/${sessionId}`, { method: 'POST' }).catch(
        (err) => console.error('Failed to stop planner:', err),
      )
    }
  }, [sessionId])

  const handleNewPlan = () => {
    handleStop()
    runIdRef.current += 1
    const next = crypto.randomUUID()
    restoreSessionRef.current = null
    setSessionId(next)
    setMessages([])
    setInput('')
    setError('')
    setIsStreaming(false)
    setStreamingText('')
    setStreamingThinking('')
    setStreamingModel(null)
    setToolRows([])
  }

  const openEndpointSettings = () => {
    setSettingsTab('endpoints')
    setShowSettings(true)
    onOpenChange(false)
  }

  const openHarnessSettings = () => {
    setSettingsTab('harnesses')
    setShowSettings(true)
    onOpenChange(false)
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || isStreaming) return
    if (!resolvedChoice) {
      toast.error('Add an endpoint in Settings → Endpoints, or install an agent harness.')
      return
    }

    const runId = ++runIdRef.current
    const userMessage: PlannerMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    }
    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setError('')
    setStreamingText('')
    setStreamingThinking('')
    setStreamingModel(null)
    setToolRows([])
    setIsStreaming(true)

    const abort = new AbortController()
    abortRef.current = abort
    let full = ''
    let thinking = ''
    let model: string | null = null
    let committed = false

    const commit = (content: string, thought: string, usedModel: string | null) => {
      if (committed || !content.trim()) return
      committed = true
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: content.trim(),
          thinking: thought.trim() || undefined,
          model: usedModel || undefined,
        },
      ])
    }

    try {
      const state = useEditorStore.getState()
      const activeFilename = state.currentFilePath
        ? state.currentFilePath.split('/').pop()
        : undefined
      const body: Record<string, unknown> = {
        content: state.content,
        message: text,
        mode: 'planner',
        session_id: sessionId,
        harness: resolvedChoice.kind === 'harness' ? resolvedChoice.id : 'none',
        endpoint_id: resolvedChoice.kind === 'endpoint' ? resolvedChoice.id : null,
        ref_files: [],
        available_files: state.openedFiles.map((f) => ({ name: f.name, path: f.path })),
        active_filename: activeFilename,
        cursor_paragraph_text: cursorParagraph() || null,
        skip_planner: true,
      }

      await streamSSE(
        `${API_BASE}/api/assist/simple`,
        body,
        (status, data) => {
          if (runIdRef.current !== runId) return
          if (status === 'chunk') {
            const chunk = typeof data.chunk === 'string' ? data.chunk : ''
            if (chunk) {
              full += chunk
              setStreamingText(full)
            }
          } else if (status === 'thinking_chunk') {
            const chunk = typeof data.chunk === 'string' ? data.chunk : ''
            if (chunk) {
              thinking += chunk
              setStreamingThinking(thinking)
            }
          } else if (status === 'tool') {
            setToolRows((prev) => [
              ...prev,
              { tool: String(data.tool || 'tool'), detail: String(data.detail || '') },
            ])
          } else if (status === 'planner') {
            if (typeof data.output === 'string' && data.output.trim()) {
              full = data.output
              setStreamingText(full)
            }
            if (typeof data.thinking_output === 'string' && data.thinking_output.trim()) {
              thinking = data.thinking_output
              setStreamingThinking(thinking)
            }
            if (typeof data.model_used === 'string') {
              model = data.model_used
              setStreamingModel(model)
            }
          } else if (status === 'error') {
            setError(String(data.detail || 'The planner could not finish.'))
          }
        },
        abort.signal,
      )

      if (runIdRef.current === runId) {
        commit(full, thinking, model ?? modelLabel)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Planner request failed:', err)
        if (runIdRef.current === runId) {
          setError((err as Error).message || 'The planner could not finish.')
          commit(full, thinking, model)
        }
      } else if (runIdRef.current === runId) {
        // Keep partial output visible after Stop.
        commit(full, thinking, model)
      }
    } finally {
      if (runIdRef.current === runId) {
        setIsStreaming(false)
        setStreamingText('')
        setStreamingThinking('')
        setStreamingModel(null)
        setToolRows([])
      }
      if (abortRef.current === abort) abortRef.current = null
    }
  }

  const handleCopy = async (message: PlannerMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error('Failed to copy planner message:', err)
      toast.error('Could not copy to clipboard.')
    }
  }

  const handleInsert = (message: PlannerMessage) => {
    const editor = useEditorStore.getState().editor
    if (!editor || editor.isDestroyed) return
    editor.chain().focus().insertContent(message.content).run()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const hasThread = messages.length > 0 || isStreaming || isRestoring

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[calc(100%-2rem)] sm:max-w-3xl w-full h-[80vh] max-h-[900px] p-0 gap-0 bg-[var(--bg)] border-[var(--border-subtle)] rounded-[16px] overflow-hidden font-sans flex flex-col"
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--bg-hover)] text-[var(--accent-brown)] shrink-0">
              <Compass size={15} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-[13px] text-[var(--text-heading)]">
                Plan the next scene
              </DialogTitle>
              <DialogDescription className="text-[10.5px] text-[var(--text-muted)] truncate">
                {currentFilePath ? currentFilePath.split('/').pop() : 'No file open'} · uses the current draft and your workspace context
              </DialogDescription>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={handleNewPlan} className="text-[11px]">
              <Plus className="size-3.5" />
              New plan
            </Button>
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label="Close planner" />}
            >
              <X className="size-4" />
            </DialogClose>
          </div>
        </div>

        <div className="min-h-0 flex-1 flex flex-col">
          {hasThread ? (
            <Chat>
              <MessageScroller>
                <ChatMessages className="gap-4 px-4 py-4 select-text">
                  {isRestoring && messages.length === 0 && (
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                      <Loader2 className="size-3.5 animate-spin" />
                      Restoring your last plan…
                    </div>
                  )}

                  {messages.map((message) =>
                    message.role === 'user' ? (
                      <Message key={message.id} align="end">
                        <MessageContent>
                          <Bubble align="end" variant="muted" className="text-[var(--text)]">
                            <BubbleContent>{message.content}</BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    ) : (
                      <Message key={message.id} className="group">
                        <MessageContent className="w-full">
                          {message.thinking && (
                            <details className="text-[10px] text-[var(--text-muted)]">
                              <summary className="cursor-pointer select-none py-0.5">
                                Thought process
                              </summary>
                              <pre className="mt-1 whitespace-pre-wrap font-mono leading-relaxed border-l border-[var(--border-subtle)] pl-3">
                                {message.thinking}
                              </pre>
                            </details>
                          )}
                          <AssistMarkdown className="assist-markdown">
                            {message.content}
                          </AssistMarkdown>
                          <MessageFooter className="opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => void handleCopy(message)}
                              aria-label="Copy plan"
                            >
                              {copiedId === message.id ? (
                                <Check className="text-green-600 dark:text-green-400" />
                              ) : (
                                <Copy />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleInsert(message)}
                              aria-label="Insert plan at cursor"
                            >
                              <CornerDownLeft />
                            </Button>
                            {message.model && (
                              <span className="ml-1 text-[9.5px] text-[var(--text-muted)] truncate max-w-[220px]">
                                {message.model}
                              </span>
                            )}
                          </MessageFooter>
                        </MessageContent>
                      </Message>
                    ),
                  )}

                  {isStreaming && (
                    <Message className="group">
                      <MessageContent className="w-full">
                        {toolRows.length > 0 && (
                          <Trace className="gap-1">
                            {toolRows.map((row, i) => (
                              <TraceLine key={`tool-${i}`} className="text-[11px]">
                                <TraceIcon>
                                  <Wrench className="size-3.5 text-[var(--text-muted)]" />
                                </TraceIcon>
                                <TraceTitle>
                                  {row.tool}
                                  {row.detail ? ` ${row.detail}` : ''}
                                </TraceTitle>
                              </TraceLine>
                            ))}
                          </Trace>
                        )}
                        {streamingThinking && (
                          <details open className="text-[10px] text-[var(--text-muted)]">
                            <summary className="cursor-pointer select-none py-0.5">Thinking…</summary>
                            <pre className="mt-1 whitespace-pre-wrap font-mono leading-relaxed border-l border-[var(--border-subtle)] pl-3">
                              {streamingThinking}
                            </pre>
                          </details>
                        )}
                        {streamingText ? (
                          <AssistMarkdown streaming className="assist-markdown">
                            {streamingText}
                          </AssistMarkdown>
                        ) : (
                          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                            <Loader2 className="size-3.5 animate-spin" />
                            Planning the scene…
                          </div>
                        )}
                        {streamingModel && (
                          <span className="text-[9.5px] text-[var(--text-muted)]">
                            {streamingModel}
                          </span>
                        )}
                      </MessageContent>
                    </Message>
                  )}

                  {error && (
                    <div className="self-start rounded-[8px] border border-[var(--danger-muted)] bg-[var(--danger-bg)] px-2.5 py-2 text-[11px] text-[var(--danger)]">
                      {error}
                    </div>
                  )}

                  <div ref={endRef} />
                </ChatMessages>
              </MessageScroller>
            </Chat>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--bg-hover)] text-[var(--accent-brown)]">
                <Compass size={18} />
              </div>
              <div className="max-w-[420px]">
                <p className="text-[15px] font-medium text-[var(--text-heading)] font-serif">
                  What happens next?
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                  Work through the next scene with the current draft, your characters, and your
                  notes. Ask for options, pressure-test a beat, or build a scene plan.
                </p>
              </div>
              <div className="flex max-w-[520px] flex-wrap justify-center gap-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="outline"
                    size="sm"
                    className="text-[10.5px]"
                    onClick={() => setInput(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
          <InputGroup>
            <InputGroupTextarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Plan the next scene…"
              aria-label="Planner message"
              rows={2}
              className="min-h-[52px] text-[12px]"
            />
            <InputGroupAddon align="block-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      size="sm"
                      variant="outline"
                      className="max-w-[230px] justify-start gap-1.5"
                      aria-label={`Model: ${modelLabel}`}
                    >
                      <span className="truncate">{modelLabel}</span>
                      <ChevronDown className="size-3.5 opacity-60 shrink-0" />
                    </InputGroupButton>
                  }
                />
                <DropdownMenuContent align="start" side="top" className="w-64">
                  <DropdownMenuRadioGroup
                    value={resolvedChoice ? choiceKey(resolvedChoice) : ''}
                    onValueChange={(value) => {
                      const next = parseChoice(value)
                      if (next) setChoice(next)
                    }}
                  >
                    {endpoints.length > 0 && (
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Endpoints</DropdownMenuLabel>
                        {endpoints.map(([id, endpoint]) => (
                          <DropdownMenuRadioItem key={id} value={`endpoint:${id}`}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate capitalize">{id.replace(/_/g, ' ')}</span>
                              <span className="truncate text-[10px] font-normal text-[var(--text-muted)]">
                                {endpoint.model || 'No model set'}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuGroup>
                    )}
                    {endpoints.length > 0 && installedHarnesses.length > 0 && (
                      <DropdownMenuSeparator />
                    )}
                    {installedHarnesses.length > 0 && (
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Agents</DropdownMenuLabel>
                        {installedHarnesses.map((harness) => (
                          <DropdownMenuRadioItem key={harness.id} value={`harness:${harness.id}`}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{harness.name}</span>
                              <span className="truncate text-[10px] font-normal text-[var(--text-muted)]">
                                {settings.harnesses?.[harness.id]?.model || 'Harness default model'}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuGroup>
                    )}
                  </DropdownMenuRadioGroup>
                  {endpoints.length === 0 && installedHarnesses.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                      No models configured.
                    </div>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={openEndpointSettings}>
                    Manage endpoints
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openHarnessSettings}>
                    Manage agent harnesses
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {isStreaming ? (
                <InputGroupButton
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="ml-auto rounded-full"
                  onClick={handleStop}
                  aria-label="Stop planning"
                >
                  <Square className="size-3.5" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="button"
                  variant="default"
                  size="icon-sm"
                  className="ml-auto rounded-full"
                  disabled={!input.trim() || !resolvedChoice}
                  onClick={() => void handleSend()}
                  aria-label="Send planner message"
                >
                  <ArrowUp className="size-4" />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
          {!resolvedChoice && (
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              Add an endpoint in Settings → Endpoints, or install an agent harness to start planning.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
