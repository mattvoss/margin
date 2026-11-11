import React, { useState, useEffect, useEffectEvent, useRef, useCallback, useMemo } from 'react'
import { AtSign, Check, ChevronDown, Code2, Compass, Eye, Brain, Loader2, MousePointer2, Settings, Trash2, Users, ListTodo, SquareChartGantt, Undo2, ChartNoAxesColumnIncreasing } from 'lucide-react'
import { useEditorStore } from '../stores/editorStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCharactersStore } from '../stores/charactersStore'
import { CharacterDialog } from './CharacterDialog'
import { ScenePlanner } from './ScenePlanner'
import { toast } from '../stores/toastStore'
import { API_BASE, apiFetch } from '../lib/api'
import { toDisplaySrc } from '../lib/media'
import { streamSSE } from '../lib/stream-sse'
import { applyHarnessResult } from '../lib/applyHarnessResult'
import { scheduleFileRefresh } from '../lib/refreshFiles'
import { restorePromptMentions, type MentionTarget } from '../lib/promptMentions'
import { filterMentionFiles, mentionTextFor, type ReferenceFile } from '../lib/fileMentions'
import { parseMentionQuery } from '../lib/mentionQuery'
import {
  activePostProcessPreset,
  normalizePostProcessing,
  type PostProcessPass,
} from '../lib/postProcessing'
import { HarnessIcon } from './HarnessIcon'
import { ImageDetailPopup, type ImageLogEntry } from './ImageDetailPopup'
import { AssistMarkdown } from './AssistMarkdown'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Chat, ChatMessages } from '@/components/ui/chat'
import { MessageScroller } from '@/components/ui/message-scroller'
import { Context, ContextLabel, ContextValue } from '@/components/ui/context'
import { InputGroup } from '@/components/ui/input-group'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { Trace, TraceLine, TraceIcon, TraceTitle } from '@/components/ui/trace'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { MessageFooter } from '@/components/ui/message'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileEntry } from '../stores/editorStore'

interface SimpleLogEntry {
  id: string
  timestamp: string
  mode: 'chat' | 'edit_plan' | 'edit_write' | 'planner'
  session_id?: string
  system_prompt: string
  user_prompt: string
  output: string
  instruction?: string
  selected_text?: string
  text_before?: string
  text_after?: string
  ref_files?: Array<{ name: string, path: string }>
  success?: boolean
  thinking_output?: string
  planner_system_prompt?: string
  planner_user_prompt?: string
  planner_output?: string
  raw_output?: string | null
  post_processing?: {
    source?: string
    skipped?: boolean
    reason?: string | null
    passes?: Array<{
      id: string
      name: string
      status: string
      model?: string | null
      hunk?: number
      error?: string
      prompt_tokens?: number
      completion_tokens?: number
    }>
    snapshots?: string[]
    hunks?: number
    skipped_hunks?: number
  } | null
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  tool_calls?: Array<{ tool: string; detail: string }>
}


interface MarkdownStorage {
  markdown: { getMarkdown: () => string }
}


function cleanUserPrompt(log: SimpleLogEntry): string {
  let text = log.instruction?.trim()
    ? log.instruction.trim()
    : log.mode === 'chat' ? 'AI Assistant Query' : 'Edit text'

  const hasAt = text.includes('@')
  if (!hasAt) {
    // Prepend ref files + selection before the text so chips lead the bubble
    let prefix = ''
    if (log.ref_files && log.ref_files.length > 0) {
      prefix += log.ref_files.map(f => `@${f.name}`).join(' ') + ' '
    }
    if (log.mode !== 'chat' && log.selected_text) {
      prefix += `@selection(${formatCharacterCount(log.selected_text.length)}) `
    }
    text = prefix + text
  }
  return text
}

function renderUserPrompt(text: string) {
  const regex = /@([\w.-]+(?:\([^)]+\))?)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const name = match[1]
    const isSelection = name.startsWith('selection(')
    const label = isSelection ? name.replace(/^selection\((.*)\)$/, '$1') : name

    // File tags get the neutral pill style; only cursor-selection gets the green accent
    parts.push(
      <span key={match.index} className={`inline-chip${isSelection ? ' inline-chip-selection' : ''} align-middle mx-0.5`}>
        <span className="chip-glyph flex items-center">
          {isSelection ? (
            <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m4 4 7.07 16.97 2.51-7.39 7.39-2.51L4 4Z" />
              <path d="m13 13 6 6" />
            </svg>
          ) : (
            <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11.688 3.063a3.5 3.5 0 0 1 1.027.712l5.968 5.97c.3.3.54.647.711 1.026m-7.706-7.708a3.5 3.5 0 0 0-1.448-.313H7.792a3.5 3.5 0 0 0-3.5 3.5v11.5a3.5 3.5 0 0 0 3.5 3.5h8.416a3.5 3.5 0 0 0 3.5-3.5v-5.53c0-.505-.109-.999-.314-1.45m-7.706-7.707V8.77a2 2 0 0 0 2 2h5.706" />
            </svg>
          )}
        </span>
        <span className="chip-divider" />
        <span className="chip-label">{label}</span>
      </span>
    )
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts
}

function formatCharacterCount(length: number): string {
  return `${length.toLocaleString()} ch`
}

function appendChipText(chip: HTMLElement, label: string, removeDataset: Record<string, string>) {
  const glyphEl = document.createElement('span')
  glyphEl.className = 'chip-glyph flex items-center'
  glyphEl.innerHTML = `<svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11.688 3.063a3.5 3.5 0 0 1 1.027.712l5.968 5.97c.3.3.54.647.711 1.026m-7.706-7.708a3.5 3.5 0 0 0-1.448-.313H7.792a3.5 3.5 0 0 0-3.5 3.5v11.5a3.5 3.5 0 0 0 3.5 3.5h8.416a3.5 3.5 0 0 0 3.5-3.5v-5.53c0-.505-.109-.999-.314-1.45m-7.706-7.707V8.77a2 2 0 0 0 2 2h5.706"/>
  </svg>`

  const divider = document.createElement('span')
  divider.className = 'chip-divider'

  const labelEl = document.createElement('span')
  labelEl.className = 'chip-label'
  labelEl.textContent = label

  const removeButton = document.createElement('button')
  removeButton.className = 'chip-remove'
  removeButton.type = 'button'
  removeButton.textContent = '×'
  Object.entries(removeDataset).forEach(([key, value]) => {
    removeButton.dataset[key] = value
  })

  chip.appendChild(glyphEl)
  chip.appendChild(divider)
  chip.appendChild(labelEl)
  chip.appendChild(removeButton)
}

/** Build a removable `@file` chip identical to the ones the @ menu inserts. */
function createFileChip(
  file: { name: string; path: string },
  mentionText?: string,
): HTMLSpanElement {
  const mention = mentionText ?? `@${file.name}`
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.className = 'inline-chip'
  chip.dataset.path = file.path
  chip.dataset.name = file.name
  chip.dataset.mention = mention
  appendChipText(chip, mention.replace(/^@/, ''), { path: file.path })
  return chip
}

/**
 * Restore prompt text with `@file` mentions rebuilt as chips. Mentions already
 * in the text keep their place; refs attached to the log are prepended when the
 * stored text doesn't contain them, so no reference is lost. Duplicate
 * basenames serialize as relative paths, matching the @ menu.
 */
function buildPromptFragment(
  text: string,
  workspaceFiles: MentionTarget[],
  attached: MentionTarget[],
  currentPath?: string | null,
): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const segment of restorePromptMentions(text, attached, workspaceFiles)) {
    if (segment.type === 'text') {
      fragment.appendChild(document.createTextNode(segment.value))
    } else {
      fragment.appendChild(
        createFileChip(
          segment.target,
          mentionTextFor(segment.target, workspaceFiles, currentPath),
        ),
      )
    }
  }
  return fragment
}

function appendSelectionChipText(chip: HTMLElement, length: number) {
  const glyphEl = document.createElement('span')
  glyphEl.className = 'chip-glyph flex items-center'
  glyphEl.innerHTML = `<svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 4 7.07 16.97 2.51-7.39 7.39-2.51L4 4Z" />
    <path d="m13 13 6 6" />
  </svg>`

  const divider = document.createElement('span')
  divider.className = 'chip-divider'

  const labelEl = document.createElement('span')
  labelEl.className = 'chip-label'
  labelEl.textContent = formatCharacterCount(length)

  const removeButton = document.createElement('button')
  removeButton.className = 'chip-remove'
  removeButton.type = 'button'
  removeButton.dataset.role = 'selection-remove'
  removeButton.textContent = '×'

  chip.appendChild(glyphEl)
  chip.appendChild(divider)
  chip.appendChild(labelEl)
  chip.appendChild(removeButton)
}

function getTextBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return ''
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return ''

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let parent = node.parentElement
      while (parent && parent !== el) {
        if (parent.contentEditable === 'false') return NodeFilter.FILTER_REJECT
        parent = parent.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let result = ''
  const endContainer = range.startContainer
  const endOffset = range.startOffset

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text
    if (textNode === endContainer) {
      result += (textNode.textContent ?? '').slice(0, endOffset)
      break
    }
    result += textNode.textContent ?? ''
  }
  return result
}

function getInputData(el: HTMLElement): {
  text: string
  refPaths: string[]
  selection: { text: string; from: number; to: number } | null
} {
  const refPaths: string[] = []
  el.querySelectorAll<HTMLElement>('[data-path]').forEach((chip) => {
    refPaths.push(chip.dataset.path ?? '')
  })

  let selection: { text: string; from: number; to: number } | null = null
  const selectionChip = el.querySelector<HTMLElement>('[data-role="selection"]')
  if (selectionChip) {
    selection = {
      text: selectionChip.dataset.text ?? '',
      from: Number(selectionChip.dataset.from ?? '0'),
      to: Number(selectionChip.dataset.to ?? '0'),
    }
  }

  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll<HTMLElement>('.inline-chip').forEach((chip) => {
    if (chip.dataset.role === 'selection') {
      const len = selection?.text.length || 0
      const textNode = document.createTextNode(`@selection(${formatCharacterCount(len)})`)
      chip.replaceWith(textNode)
    } else if (chip.dataset.name) {
      const mention = chip.dataset.mention || `@${chip.dataset.name}`
      const textNode = document.createTextNode(mention)
      chip.replaceWith(textNode)
    } else {
      chip.remove()
    }
  })
  return { text: clone.textContent?.trim() ?? '', refPaths, selection }
}

function ThinkingDropdown({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Trace>
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col gap-0 self-start w-full mb-0"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] font-sans hover:text-[var(--text-secondary)] transition-colors select-none py-0.5 w-fit cursor-pointer"
          >
            <svg
              className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            {text && !open ? 'Thought Process' : open ? 'Thought Process' : 'Thinking'}
          </button>
        }
      />
      <CollapsibleContent className="font-mono text-[10px] text-[var(--text-muted)] leading-relaxed max-h-[120px] overflow-y-auto whitespace-pre-wrap pl-4 border-l border-[var(--border-subtle)] mt-1">
        {text}
      </CollapsibleContent>
    </Collapsible>
    </Trace>
  )
}

export function SimpleAssist() {
  const {
    content, setContent, editor,
    anchorPosition,
    pendingEditSelection, setPendingEditSelection,
  } = useEditorStore()

  const openedFiles = useEditorStore((s) => s.openedFiles)
  const currentFilePath = useEditorStore((s) => s.currentFilePath)
  const updateFileContent = useEditorStore((s) => s.updateFileContent)
  const characterState = useCharactersStore((s) => s.state)
  const charactersTracking = useCharactersStore((s) => s.tracking)
  const charactersError = useCharactersStore((s) => s.error)
  const setCharactersDialogOpen = useCharactersStore((s) => s.setDialogOpen)
  const activeCharacterCount = useMemo(
    () => (characterState?.characters ?? []).filter((character) => character.active).length,
    [characterState],
  )
  const [isWorking, setIsWorking] = useState(false)
  const [isPlanning, setIsPlanning] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [plannerContextFiles, setPlannerContextFiles] = useState<string[]>([])
  const [streamingThinkingText, setStreamingThinkingText] = useState('')
  const [streamingChatText, setStreamingChatText] = useState('')
  const [postProcessStatus, setPostProcessStatus] = useState<{ index: number; total: number; name?: string } | null>(null)
  const [runningPass, setRunningPass] = useState<{ logId: string; passId: string } | null>(null)
  const [instructionText, setInstructionText] = useState('')
  const [historyLogs, setHistoryLogs] = useState<SimpleLogEntry[]>([])
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copiedResponseId, setCopiedResponseId] = useState<string | null>(null)

  const handleCopyPrompt = async (log: SimpleLogEntry) => {
    const textToCopy = log.instruction || log.user_prompt || cleanUserPrompt(log)
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopiedId(log.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error('Failed to copy prompt text:', err)
      toast.error('Could not copy to clipboard.')
    }
  }

  const handleCopyResponse = async (log: SimpleLogEntry) => {
    try {
      await navigator.clipboard.writeText(log.output)
      setCopiedResponseId(log.id)
      window.setTimeout(() => setCopiedResponseId(null), 2000)
    } catch (err) {
      console.error('Failed to copy response:', err)
      toast.error('Could not copy to clipboard.')
    }
  }

  const handleInsertResponse = (log: SimpleLogEntry) => {
    const activeEditor = useEditorStore.getState().editor
    if (!activeEditor || activeEditor.isDestroyed) return
    activeEditor.chain().focus().insertContent(log.output).run()
  }

  const [activeInstruction, setActiveInstruction] = useState('')
  const [activeRefFiles, setActiveRefFiles] = useState<FileEntry[]>([])
  const [errorText, setErrorText] = useState('')
  const [activeSessionId, setActiveSessionId] = useState<string>(() => crypto.randomUUID())
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false)
  const [plannerOpen, setPlannerOpen] = useState(false)
  const [sessionLoadCount, setSessionLoadCount] = useState(3)
  const [historyView, setHistoryView] = useState<'chats' | 'images'>('chats')
  const [imageLogs, setImageLogs] = useState<ImageLogEntry[] | null>(null)
  const [imageLoadCount, setImageLoadCount] = useState(10)
  const [selectedImage, setSelectedImage] = useState<ImageLogEntry | null>(null)
  const [mode, setMode] = useState<'chat' | 'edit'>('edit')
  const [activeHarness, setActiveHarness] = useState('none')
  const [harnessList, setHarnessList] = useState<Array<{ id: string; name: string; installed: boolean; version: string | null }>>([])
  const [noticeText, setNoticeText] = useState('')
  const [showHarnessDropdown, setShowHarnessDropdown] = useState(false)
  const [activeToolRows, setActiveToolRows] = useState<Array<{ tool: string; detail: string }>>([])
  const harnessBaseRef = useRef('')
  const harnessLabel = (id: string) => harnessList.find(h => h.id === id)?.name ?? id
  const hasSelection = !!pendingEditSelection
  const { settings, fetchSettings, setShowSettings, setSettingsTab, updateSettings } = useSettingsStore()
  const [previousDefaultMode, setPreviousDefaultMode] = useState(settings?.default_mode)
  if (previousDefaultMode !== settings?.default_mode) {
    setPreviousDefaultMode(settings?.default_mode)
    if (settings?.default_mode) {
      setMode(settings.default_mode as 'chat' | 'edit')
    }
  }
  // Active endpoint display name (same `id.replace('_', ' ')` convention as
  // EndpointsTab). Empty when unset — there is no .env concept anymore.
  const activeEndpointName = settings?.active_endpoint
    ? settings.active_endpoint.replace('_', ' ')
    : ''
  const endpointEntries = Object.entries(settings?.endpoints || {})
  const oneOffPasses = useMemo(
    () => activePostProcessPreset(normalizePostProcessing(settings?.post_processing)).passes,
    [settings?.post_processing],
  )

  const handleRunPostProcessPass = async (log: SimpleLogEntry, pass: PostProcessPass) => {
    if (!log.output || runningPass) return
    setRunningPass({ logId: log.id, passId: pass.id })
    setNoticeText(`Running ${pass.name}…`)
    try {
      const res = await apiFetch(`${API_BASE}/api/assist/post-process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pass_id: pass.id,
          text: log.output,
          content: useEditorStore.getState().content,
          session_id: log.session_id || activeSessionId,
          text_before: log.text_before ?? '',
          text_after: log.text_after ?? '',
          available_files: openedFiles.map((file) => ({ name: file.name, path: file.path })),
        }),
      })
      const data = (await res.json().catch(() => null)) as {
        output?: string
        skipped?: boolean
        reason?: string | null
        pass?: { status?: string; error?: string | null } | null
        detail?: string
      } | null
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
      if (!data) throw new Error('The server returned an empty response.')
      if (data.pass?.status === 'failed') {
        throw new Error(data.pass.error || `${pass.name} failed.`)
      }
      if (data.skipped || !data.output) {
        const reason = data.reason ? ` (${data.reason.replace(/_/g, ' ')})` : ''
        setNoticeText(`${pass.name} was skipped${reason}.`)
        return
      }
      if (data.output === log.output) {
        setNoticeText(`${pass.name} left the text unchanged.`)
        return
      }
      setHistoryLogs((prev) =>
        prev.map((entry) =>
          entry.id === log.id ? { ...entry, output: data.output as string } : entry,
        ),
      )
      setNoticeText('')
      toast.success(`${pass.name} applied`)
    } catch (error) {
      console.error('Failed to run post-processing pass:', error)
      setNoticeText('')
      toast.error(error instanceof Error ? error.message : 'Could not run that pass.')
    } finally {
      setRunningPass(null)
    }
  }

  const handleRetry = (log: SimpleLogEntry) => {
    handlePromptToInput(log)
    window.setTimeout(() => {
      if (log.mode === 'chat') {
        void handleChat()
      } else {
        void handleEdit()
      }
    }, 0)
  }

  // Picking an endpoint means "use this endpoint instead of the harness":
  // same two fields the Endpoints tab writes, then close the menu.
  const handlePickEndpoint = (id: string) => {
    updateSettings({ active_endpoint: id, default_harness: 'none' })
    setShowHarnessDropdown(false)
  }

  const handleManageEndpoints = () => {
    setSettingsTab('endpoints')
    setShowSettings(true)
    setShowHarnessDropdown(false)
  }
  // Single source of truth: the panel, SettingsModal, and bubble menu all
  // read/write settings.default_harness, so they can never disagree.
  const harness = settings?.default_harness || 'none'



  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const [showFileDropdown, setShowFileDropdown] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const wasAbortedRef = useRef(false)

  // Pre-fill the input box with a previous prompt so it can be edited and
  // re-sent. Every file the log tagged comes back as a chip: mentions already
  // in the prompt keep their place, and refs missing from the stored text are
  // prepended. Anything without a resolvable path stays plain text rather than
  // a chip that tags nothing. Any pending editor-selection chip is kept.
  const handlePromptToInput = (log: SimpleLogEntry) => {
    const textToUse = log.instruction || log.user_prompt || cleanUserPrompt(log)
    const el = inputRef.current
    if (!el) return
    try {
      // Log entries win over workspace files: they carry the paths that were
      // actually tagged when the prompt ran.
      const attached: MentionTarget[] = []
      for (const file of log.ref_files ?? []) {
        if (file?.name && file?.path) attached.push({ name: file.name, path: file.path })
      }
      const workspaceFiles: MentionTarget[] = openedFiles.map((file) => ({
        name: file.name,
        path: file.path,
      }))

      const fragment = buildPromptFragment(
        textToUse,
        workspaceFiles,
        attached,
        currentFilePath,
      )

      // The editor selection is separate context, not prompt text — keep the
      // pending chip instead of silently dropping it.
      const selectionChip = el.querySelector<HTMLElement>('[data-role="selection"]')
      if (selectionChip) fragment.prepend(selectionChip)

      el.replaceChildren(fragment)
      // Read the text back so chip mentions serialize exactly as typing would.
      setInstructionText(getInputData(el).text)
      setShowFileDropdown(false)

      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      el.focus()
    } catch (err) {
      console.error('Failed to copy prompt to input:', err)
      toast.error('Could not copy prompt to input.')
    }
  }

  const handleStop = async () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    if (activeSessionId) {
      try {
        await apiFetch(`${API_BASE}/api/assist/simple/stop/${activeSessionId}`, { method: 'POST' })
      } catch (err) {
        console.error('Failed to call stop endpoint', err)
      }
    }
  }

  const containerRef = useRef<HTMLDivElement>(null)

  const fetchLogs = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/assist/simple/logs`)
      if (res.ok) {
        const data = await res.json()
        // Planner turns are persisted for the dedicated planner session, not
        // the assist chat history. Keep them out of this panel's sessions.
        setHistoryLogs((Array.isArray(data) ? data : []).filter((entry: SimpleLogEntry) => entry.mode !== 'planner'))
      }
    } catch (err) {
      console.error('Failed to fetch simple logs:', err)
      toast.error('Could not load chat history.')
    }
  }

  const imageLogsFetchingRef = useRef(false)

  const fetchImageLogs = useCallback(async () => {
    // Dedup: rapid open/tab-switch sequences share one in-flight request.
    if (imageLogsFetchingRef.current) return
    imageLogsFetchingRef.current = true
    try {
      const res = await apiFetch(`${API_BASE}/api/images/logs`)
      if (res.ok) {
        const data = await res.json()
        setImageLogs([...(data.logs || [])].reverse())
      } else {
        setImageLogs([])
      }
    } catch (err) {
      console.error('Failed to fetch image logs:', err)
      toast.error('Could not load image history.')
      setImageLogs([])
    } finally {
      imageLogsFetchingRef.current = false
    }
  }, [])

  const handleDeleteImageLog = async (e: React.MouseEvent, log: ImageLogEntry, i: number) => {
    e.stopPropagation()
    try {
      const res = await apiFetch(
        `${API_BASE}/api/images/logs/${encodeURIComponent(imageKey(log, i))}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        console.warn('DELETE image log returned', res.status)
        toast.error('Could not delete that history entry.')
      }
    } catch (err) {
      console.error('Failed to delete image log:', err)
      toast.error('Could not delete that history entry.')
    }
    // Don't leave the detail popup open on a deleted entry.
    if (selectedImage != null) {
      const same = selectedImage.id
        ? selectedImage.id === log.id
        : !log.id && selectedImage.timestamp === log.timestamp
          && selectedImage.path === log.path
      if (same) setSelectedImage(null)
    }
    await fetchImageLogs()
  }

  const handleHistoryOpen = () => {
    const opening = !showHistoryDropdown
    setShowHistoryDropdown(opening)
    // Always refetch images on open — a generation may have landed since.
    if (opening && historyView === 'images') {
      void fetchImageLogs()
    }
  }

  const handleHistoryViewChange = (view: 'chats' | 'images') => {
    setHistoryView(view)
    // Always refetch on tab switch — never show a stale cached list.
    if (view === 'images') {
      void fetchImageLogs()
    }
  }

  const imageKey = (log: ImageLogEntry, i: number) => log.id || `img-${i}`
  const sessions = useMemo(() => {
    const map = new Map<string, { name: string; logCount: number; timestamp: string }>()
    const sessionLogs = new Map<string, SimpleLogEntry[]>()
    for (const log of historyLogs) {
      const sid = log.session_id || ''
      if (!sid) continue
      if (!sessionLogs.has(sid)) sessionLogs.set(sid, [])
      sessionLogs.get(sid)!.push(log)
    }
    for (const [sid, logs] of sessionLogs) {
      const first = logs.reduce((a, b) => (a.timestamp || '') < (b.timestamp || '') ? a : b)
      const raw = first.instruction || ''
      const name = raw.slice(0, 35) + (raw.length > 35 ? '...' : '') || 'Assist'
      const latest = logs.reduce((a, b) => (a.timestamp || '') > (b.timestamp || '') ? a : b)
      map.set(sid, { name, logCount: logs.length, timestamp: latest.timestamp || '' })
    }
    return Array.from(map.entries())
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  }, [historyLogs])

  const filteredLogs = useMemo(() =>
    historyLogs.filter(l => l.session_id === activeSessionId),
    [historyLogs, activeSessionId]
  )

  const displayLogs = useMemo(() =>
    filteredLogs.filter(l => l.mode !== 'edit_plan' && l.mode !== 'planner'),
    [filteredLogs]
  )


  const activeContextWindow = useMemo(() => {
    if (!settings) return undefined
    if (harness !== 'none') {
      // Harness ring only when the user set a window; otherwise hidden.
      return settings.harnesses?.[harness]?.context_window || undefined
    }
    if (settings.active_endpoint && settings.endpoints[settings.active_endpoint]) {
      return settings.endpoints[settings.active_endpoint].context_window || 8192
    }
    return settings.default_context_window || 8192
  }, [settings, harness])

  const sessionInputTokens = useMemo(() =>
    filteredLogs.reduce((sum, l) => sum + (l.prompt_tokens || 0), 0),
    [filteredLogs])

  const sessionOutputTokens = useMemo(() =>
    filteredLogs.reduce((sum, l) => sum + (l.completion_tokens || 0), 0),
    [filteredLogs])

  // Context = what the model last saw (its prompt), NOT a session sum:
  // harness runs are independent conversations and endpoint prompts carry
  // their own history, so summing across requests overstates the window.
  const contextUsedTokens = useMemo(() => {
    for (let i = filteredLogs.length - 1; i >= 0; i--) {
      const t = filteredLogs[i]?.prompt_tokens || 0
      if (t > 0) return t
    }
    return 0
  }, [filteredLogs])

  const percentUsed = useMemo(() => {
    if (!activeContextWindow) return 0
    return (contextUsedTokens / activeContextWindow) * 100
  }, [contextUsedTokens, activeContextWindow])

  const percentLeft = useMemo(() => {
    return Math.max(0, 100 - percentUsed)
  }, [percentUsed])

  const loadInitialData = useEffectEvent(() => {
    fetchLogs()
    apiFetch(`${API_BASE}/api/harnesses`)
      .then(res => res.ok ? res.json() : { harnesses: [] })
      .then(data => setHarnessList(data.harnesses || []))
      .catch(err => {
        console.error('Failed to fetch harnesses:', err)
        toast.error('Could not load agent harnesses.')
      })
  })

  useEffect(() => {
    queueMicrotask(() => {
      loadInitialData()
    })
  }, [])

  // Reset all session state when the active workspace changes.
  // Keyed on the linked path itself: workspaceDir is only a custom/sample
  // flag, so custom → custom switches would never refire this effect.
  const linkedWorkspaceDir = settings?.linked_workspace_dir ?? null
  const [previousLinkedWorkspaceDir, setPreviousLinkedWorkspaceDir] = useState(linkedWorkspaceDir)
  if (previousLinkedWorkspaceDir !== linkedWorkspaceDir) {
    setPreviousLinkedWorkspaceDir(linkedWorkspaceDir)
    setHistoryLogs([])
    setImageLogs(null)
    setHistoryView('chats')
    setActiveSessionId(crypto.randomUUID())
    setPlannerContextFiles([])
    setStreamingThinkingText('')
    setStreamingChatText('')
    setPostProcessStatus(null)
    setActiveToolRows([])
    setActiveHarness('none')
    setNoticeText('')
  }

  useEffect(() => {
    useCharactersStore.getState().resetForWorkspace()
  }, [linkedWorkspaceDir])

  useEffect(() => {
    if (historyLogs.length > 0 || isWorking || errorText) {
      outputRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [historyLogs.length, isWorking, errorText])

  // Close file-mention dropdown on click outside (harness menu is a
  // DropdownMenu and manages its own dismissal)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowFileDropdown(false)
      }
    }
    if (showFileDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showFileDropdown])



  const filteredFiles = useMemo(
    () => filterMentionFiles(openedFiles, fileQuery, currentFilePath),
    [openedFiles, fileQuery, currentFilePath],
  )


  const handleInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return

    const textBefore = getTextBeforeCaret(el)
    const { text, selection: domSelection } = getInputData(el)
    setInstructionText(text)

    if (!domSelection && pendingEditSelection) {
      setPendingEditSelection(null)
    }

    const parsed = parseMentionQuery(textBefore)
    if (!parsed) {
      setShowFileDropdown(false)
      return
    }

    setFileQuery(parsed.query)
    setHighlightedIndex(0)
    setShowFileDropdown(true)
  }, [pendingEditSelection, setPendingEditSelection])

  const handleSelectFile = (file: ReferenceFile) => {
    const div = inputRef.current
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !div) return

    const range = sel.getRangeAt(0)
    const textNode = range.startContainer
    if (textNode.nodeType !== Node.TEXT_NODE || !div.contains(textNode)) return

    const text = textNode.textContent ?? ''
    const caretOffset = range.startOffset
    const parsed = parseMentionQuery(text.slice(0, caretOffset))
    if (!parsed) return

    const atIndex = parsed.atIndex
    const mentionEnd = caretOffset

    range.setStart(textNode, atIndex)
    range.setEnd(textNode, mentionEnd)
    range.deleteContents()

    const mention = mentionTextFor(
      file,
      useEditorStore.getState().openedFiles,
      useEditorStore.getState().currentFilePath,
    )
    const chip = createFileChip(file, mention)

    const isEditorContent = file.name === 'editorcontent.ts'
    const zwsp = document.createTextNode(isEditorContent ? '\u200B ' : '\u200B')
    const fragment = document.createDocumentFragment()
    fragment.appendChild(chip)
    fragment.appendChild(zwsp)
    range.insertNode(fragment)
    setShowFileDropdown(false)

    setTimeout(() => {
      const currentSel = window.getSelection()
      if (currentSel) {
        const rangeAfter = document.createRange()
        rangeAfter.setStartAfter(zwsp)
        rangeAfter.collapse(true)
        currentSel.removeAllRanges()
        currentSel.addRange(rangeAfter)
      }
      div.focus()
    }, 0)
  }

  const handleEdit = async () => {
    const activeEditor = useEditorStore.getState().editor || editor
    if (!activeEditor || activeEditor.isDestroyed || !activeEditor.view || !activeEditor.state) return
    const inputEl = inputRef.current!
    const { text: currentInstruction, refPaths, selection: domSelection } = getInputData(inputEl)
    if (!currentInstruction) return

    const selectionInfo = domSelection
    const localHasSelection = !!selectionInfo
    const selectionText = selectionInfo ? selectionInfo.text : ''
    setIsWorking(true)
    setIsPlanning(true)
    setIsGenerating(false)
    // Suppress autosave while the model streams: the editor receives partial
    // output that must never hit disk (see editorStore.setContent/flushSave).
    useEditorStore.getState().setIsStreaming(true)
    setPlannerContextFiles([])
    setStreamingThinkingText('')
    setStreamingChatText('')
    setPostProcessStatus(null)
    setActiveToolRows([])
    setActiveInstruction(currentInstruction)
    const currentRefFiles = Array.from(new Set(refPaths))
      .map(path => openedFiles.find(f => f.path === path))
      .filter((f): f is FileEntry => !!f)
    setActiveRefFiles(currentRefFiles)
    setErrorText('')
    setNoticeText('')
    // Snapshot for harness three-way reconciliation (editor stays editable)
    harnessBaseRef.current = useEditorStore.getState().content
    setActiveHarness(harness)

    if (inputRef.current) {
      inputRef.current.textContent = ''
      setInstructionText('')
    }

    wasAbortedRef.current = false
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    try {
      // Do NOT append mentionContext to content — the backend injects ref files
      // via ref_files + context_needed resolution. Polluting `content` with file
      // headers breaks cursor paragraph detection in extract_anchor_context().
      const cleanMessage = currentInstruction
        .replace(/\s*@selection\([^)]*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      const activeFilename = currentFilePath ? currentFilePath.split('/').pop() : undefined

      const body: Record<string, unknown> = {
        content: content,
        message: cleanMessage,
        mode: 'edit',
        harness: harness,
        session_id: activeSessionId,
        ref_files: currentRefFiles.map(f => ({ name: f.name, path: f.path })),
        available_files: openedFiles.map(f => ({ name: f.name, path: f.path })),
        active_filename: activeFilename,
      }

      if (localHasSelection) {
        body.selected_text = selectionText
      } else {
        const doc = activeEditor.state.doc
        let cursorParagraphText = ''
        doc.forEach((node, offset) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            const from = offset
            const to = offset + node.nodeSize
            if (anchorPosition >= from && anchorPosition < to) {
              cursorParagraphText = node.textContent
            }
          }
        })
        if (cursorParagraphText) {
          body.cursor_paragraph_text = cursorParagraphText
        }
      }

      const startPos = localHasSelection && selectionInfo ? selectionInfo.from : anchorPosition
      let currentEndPos = localHasSelection && selectionInfo ? selectionInfo.to : anchorPosition
      let isStreaming = false
      let characterTracked = false
      const workspaceAtStart = useSettingsStore.getState().selectedWorkspaceDir()
      const previousContent = useEditorStore.getState().content

      await streamSSE(
        `${API_BASE}/api/assist/simple`,
        body,
        (status, data) => {
          if (status === 'planning') {
            setIsPlanning(true)
            setIsGenerating(false)
          } else if (status === 'context_resolved') {
            if (Array.isArray(data.context_needed)) {
              setPlannerContextFiles(data.context_needed)
            }
          } else if (status === 'generating') {
            setIsPlanning(false)
            setIsGenerating(true)
          } else if (status === 'thinking_chunk') {
            setStreamingThinkingText(prev => prev + (data.chunk as string))
          } else if (status === 'post_processing_start') {
            setPostProcessStatus({ index: 0, total: Number(data.total) || 0 })
          } else if (status === 'post_processing_pass') {
            setPostProcessStatus({
              index: Number(data.index) || 0,
              total: Number(data.total) || 0,
              name: String(data.name || ''),
            })
          } else if (status === 'post_processing_pass_done') {
            setPostProcessStatus(prev => prev ? { ...prev, index: Number(data.index) || prev.index } : prev)
            if (data.result_status === 'failed') {
              setNoticeText(`${String(data.name || 'Post-processing pass')} failed; kept the previous text.`)
            }
          } else if (status === 'post_processing_skipped') {
            const reason = String(data.reason || '')
            if (reason && !['disabled', 'no_passes', 'min_chars', 'aborted'].includes(reason)) {
              setNoticeText(`Post-processing skipped: ${reason.replace(/_/g, ' ')}`)
            }
          } else if (status === 'chunk') {
            setIsPlanning(false)
            setIsGenerating(true)
            if (harness !== 'none') {
              // Harness stdout is progress output — display only, never insert
              setStreamingChatText(prev => prev + (data.chunk as string))
            } else {
            const chunk = data.chunk as string
            const liveEditor = useEditorStore.getState().editor || activeEditor
            if (liveEditor && liveEditor.view && liveEditor.state && !liveEditor.isDestroyed) {
              let tr
              if (!isStreaming) {
                tr = liveEditor.state.tr.insertText(chunk, startPos, currentEndPos)
                isStreaming = true
              } else {
                tr = liveEditor.state.tr.insertText(chunk, currentEndPos)
              }
              liveEditor.view.dispatch(tr)
              currentEndPos = tr.mapping.map(currentEndPos)
              // No diff highlight on untitled docs (no file identity) —
              // plain insert only. Saved files keep the live highlight.
              if (useEditorStore.getState().currentFilePath) {
                liveEditor.commands.setAiHighlight(startPos, currentEndPos)
              }
              liveEditor.commands.setTextSelection(currentEndPos)
            }
            }
          } else if (status === 'tool') {
            // Every harness streams structured events and emits tool rows.
            setIsPlanning(false)
            setIsGenerating(true)
            setActiveToolRows(prev => [...prev, { tool: String(data.tool || 'tool'), detail: String(data.detail || '') }])
            // Write/edit tool landed on disk → refresh the sidebar tree
            // (reads/globs are noise; the open document stays on the
            // merge-at-done path, this syncs added and deleted files).
            if (data.path && !['read', 'glob', 'grep'].includes(String(data.tool).toLowerCase())) scheduleFileRefresh()
          } else if (status === 'harness_done') {
            setIsPlanning(false)
            setIsGenerating(false)
            scheduleFileRefresh(0)
            const postInfo = data.post_processing as { skipped_hunks?: number } | null | undefined
            if (postInfo?.skipped_hunks) {
              setNoticeText(`${postInfo.skipped_hunks} changed paragraph${postInfo.skipped_hunks === 1 ? ' was' : 's were'} left unprocessed (cap or minimum length).`)
            }
            applyHarnessResult(harnessBaseRef.current, harness)
              .then(({ conflicts, deleted }) => {
                if (deleted) {
                  setNoticeText(`The open file was deleted by ${harnessLabel(harness)}.`)
                } else if (conflicts > 0) {
                  setNoticeText(`${conflicts} paragraph${conflicts > 1 ? 's were' : ' was'} changed by both you and ${harnessLabel(harness)} — kept your version.`)
                }
                if (!deleted && !wasAbortedRef.current) {
                  const mergedText = useEditorStore.getState().content
                  void useCharactersStore.getState().trackAfterGeneration({
                    text: mergedText.slice(-20000),
                    filePath: useEditorStore.getState().currentFilePath,
                    sessionId: activeSessionId,
                    workspaceDir: workspaceAtStart,
                  })
                }
                setPendingEditSelection(null)
              })
              .catch((e) => setErrorText('Error: ' + (e as Error).message))
          } else if (status === 'applied') {
            if (data.model_used) {
              useEditorStore.getState().setActiveModel(data.model_used as string)
            }
            const output = data.output as string

            const liveEditor = useEditorStore.getState().editor || activeEditor
            if (liveEditor && liveEditor.view && liveEditor.state && !liveEditor.isDestroyed) {
              // File identity decides diff vs plain insert — not content
              // emptiness. An untitled doc (no path) can never be saved, so
              // never create a pending diff/highlight for it. A blank saved
              // file (has path) still gets the normal diff flow.
              const filePathAtApply = useEditorStore.getState().currentFilePath
              if (!filePathAtApply) {
                let chain = liveEditor.chain()
                chain = chain.deleteRange({ from: startPos, to: currentEndPos })
                chain = chain.insertContentAt(startPos, output)
                chain.run()
                liveEditor.commands.setTextSelection(startPos + output.length)
                const storage = liveEditor.storage as unknown as MarkdownStorage
                if (storage.markdown) {
                  setContent(storage.markdown.getMarkdown())
                }
              } else {
                const review = data.review !== false
                const setAiPendingEdit = useEditorStore.getState().setAiPendingEdit
                const beforeSize = liveEditor.state.doc.content.size

                if (review) {
                  setAiPendingEdit({
                    previousContent,
                    selectionRange: localHasSelection && selectionInfo ? { from: selectionInfo.from, to: selectionInfo.to } : null,
                    highlightFrom: startPos
                  })
                } else {
                  // Post-processing opted out of review: insert and persist the
                  // final text directly. Autosave writes `previousContent` while
                  // a review is pending, so this path must save explicitly.
                  setAiPendingEdit(null)
                  liveEditor.commands.clearAiHighlight()
                }

                let chain = liveEditor.chain()
                chain = chain.deleteRange({ from: startPos, to: currentEndPos })
                chain = chain.insertContentAt(startPos, output)
                chain.run()

                const afterSize = liveEditor.state.doc.content.size
                const endPos = currentEndPos + (afterSize - beforeSize)

                if (review && endPos > startPos) {
                  liveEditor.commands.setAiHighlight(startPos, endPos)
                  liveEditor.commands.setTextSelection(endPos)
                } else if (endPos > startPos) {
                  liveEditor.commands.setTextSelection(endPos)
                }

                const storage = liveEditor.storage as unknown as MarkdownStorage
                if (storage.markdown) {
                  const md = storage.markdown.getMarkdown()
                  setContent(md)
                  updateFileContent(filePathAtApply, md)
                  if (!review) {
                    void useEditorStore.getState().saveFile(filePathAtApply, md)
                  }
                }
              }
            }
            setPendingEditSelection(null)

            if (!characterTracked) {
              characterTracked = true
              const pathAtApply = useEditorStore.getState().currentFilePath
              const mergedText = useEditorStore.getState().content
              const generatedText = typeof output === 'string' ? output : ''
              void useCharactersStore.getState().trackAfterGeneration({
                text: generatedText.trim() ? generatedText : mergedText.slice(-12000),
                filePath: pathAtApply,
                sessionId: activeSessionId,
                workspaceDir: workspaceAtStart,
              })
            }
          }
        },
        abortRef.current.signal
      )
      await fetchLogs()
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        wasAbortedRef.current = true
        // User cancelled — keep partial output visible, don't show error
      } else {
        console.error(err)
        setErrorText('Error: ' + (err as Error).message)
      }
    } finally {
      useEditorStore.getState().setIsStreaming(false)
      setIsWorking(false)
      setIsPlanning(false)
      setIsGenerating(false)
      setPlannerContextFiles([])
      setActiveHarness('none')
      setPostProcessStatus(null)
      if (!wasAbortedRef.current) {
        setStreamingThinkingText('')
        setStreamingChatText('')
        setActiveInstruction('')
        setActiveRefFiles([])
      }
    }
  }

  const handleChat = async () => {
    if (!editor) return
    const inputEl = inputRef.current!
    const { text: currentInstruction, refPaths, selection: domSelection } = getInputData(inputEl)
    if (!currentInstruction) return

    const selectionInfo = domSelection
    const localHasSelection = !!selectionInfo
    const selectionText = selectionInfo ? selectionInfo.text : ''

    setIsWorking(true)
    setIsPlanning(true)
    setIsGenerating(false)
    setPlannerContextFiles([])
    setStreamingThinkingText('')
    setStreamingChatText('')
    setPostProcessStatus(null)
    setActiveToolRows([])
    setActiveInstruction(currentInstruction)
    const currentRefFiles = Array.from(new Set(refPaths))
      .map(path => openedFiles.find(f => f.path === path))
      .filter((f): f is FileEntry => !!f)
    setActiveRefFiles(currentRefFiles)
    setErrorText('')
    setNoticeText('')
    harnessBaseRef.current = useEditorStore.getState().content
    setActiveHarness(harness)

    if (inputRef.current) {
      inputRef.current.textContent = ''
      setInstructionText('')
    }

    wasAbortedRef.current = false
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    try {
      const cleanMessage = currentInstruction
        .replace(/\s*@selection\([^)]*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      const activeFilename = currentFilePath ? currentFilePath.split('/').pop() : undefined

      const body: Record<string, unknown> = {
        content: content,
        message: cleanMessage,
        mode: 'chat',
        harness: harness,
        session_id: activeSessionId,
        ref_files: currentRefFiles.map(f => ({ name: f.name, path: f.path })),
        available_files: openedFiles.map(f => ({ name: f.name, path: f.path })),
        active_filename: activeFilename,
      }

      if (localHasSelection) {
        body.selected_text = selectionText
      }

      await streamSSE(
        `${API_BASE}/api/assist/simple`,
        body,
        (status, data) => {
          if (status === 'planning') {
            setIsPlanning(true)
            setIsGenerating(false)
          } else if (status === 'context_resolved') {
            if (Array.isArray(data.context_needed)) {
              setPlannerContextFiles(data.context_needed)
            }
          } else if (status === 'generating') {
            setIsPlanning(false)
            setIsGenerating(true)
          } else if (status === 'thinking_chunk') {
            setStreamingThinkingText(prev => prev + (data.chunk as string))
          } else if (status === 'post_processing_start') {
            setPostProcessStatus({ index: 0, total: Number(data.total) || 0 })
          } else if (status === 'post_processing_pass') {
            setPostProcessStatus({
              index: Number(data.index) || 0,
              total: Number(data.total) || 0,
              name: String(data.name || ''),
            })
          } else if (status === 'post_processing_pass_done') {
            setPostProcessStatus(prev => prev ? { ...prev, index: Number(data.index) || prev.index } : prev)
            if (data.result_status === 'failed') {
              setNoticeText(`${String(data.name || 'Post-processing pass')} failed; kept the previous text.`)
            }
          } else if (status === 'post_processing_skipped') {
            const reason = String(data.reason || '')
            if (reason && !['disabled', 'no_passes', 'min_chars', 'aborted'].includes(reason)) {
              setNoticeText(`Post-processing skipped: ${reason.replace(/_/g, ' ')}`)
            }
          } else if (status === 'chunk') {
            setIsPlanning(false)
            setIsGenerating(true)
            setStreamingChatText(prev => prev + (data.chunk as string))
          } else if (status === 'tool') {
            // Every harness streams structured events and emits tool rows.
            setIsPlanning(false)
            setIsGenerating(true)
            setActiveToolRows(prev => [...prev, { tool: String(data.tool || 'tool'), detail: String(data.detail || '') }])
            // Write/edit tool landed on disk → refresh the sidebar tree
            // (reads/globs are noise; the open document stays on the
            // merge-at-done path, this syncs added and deleted files).
            if (data.path && !['read', 'glob', 'grep'].includes(String(data.tool).toLowerCase())) scheduleFileRefresh()
          } else if (status === 'chat') {
            if (data.model_used) {
              useEditorStore.getState().setActiveModel(data.model_used as string)
            }
            if (typeof data.output === 'string') {
              setStreamingChatText(data.output)
            }
          } else if (status === 'harness_done') {
            setIsPlanning(false)
            setIsGenerating(false)
            scheduleFileRefresh(0)
            const postInfo = data.post_processing as { skipped_hunks?: number } | null | undefined
            if (postInfo?.skipped_hunks) {
              setNoticeText(`${postInfo.skipped_hunks} changed paragraph${postInfo.skipped_hunks === 1 ? ' was' : 's were'} left unprocessed (cap or minimum length).`)
            }
            applyHarnessResult(harnessBaseRef.current, harness)
              .then(({ conflicts, deleted }) => {
                if (deleted) {
                  setNoticeText(`The open file was deleted by ${harnessLabel(harness)}.`)
                } else if (conflicts > 0) {
                  setNoticeText(`${conflicts} paragraph${conflicts > 1 ? 's were' : ' was'} changed by both you and ${harnessLabel(harness)} — kept your version.`)
                }
              })
              .catch((e) => setErrorText('Error: ' + (e as Error).message))
          }
        },
        abortRef.current.signal
      )
      await fetchLogs()
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        wasAbortedRef.current = true
        // User cancelled — keep partial output visible, don't show error
      } else {
        console.error(err)
        setErrorText('Error: ' + (err as Error).message)
      }
    } finally {
      setIsWorking(false)
      setIsPlanning(false)
      setIsGenerating(false)
      setPlannerContextFiles([])
      setActiveHarness('none')
      setPostProcessStatus(null)
      if (!wasAbortedRef.current) {
        setStreamingThinkingText('')
        setStreamingChatText('')
        setActiveInstruction('')
        setActiveRefFiles([])
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Backspace' && !inputRef.current?.textContent?.trim() && pendingEditSelection) {
      e.preventDefault()
      setPendingEditSelection(null)
      return
    }
    if (showFileDropdown && filteredFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIndex((i) => Math.min(i + 1, filteredFiles.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSelectFile(filteredFiles[highlightedIndex])
        return
      }
    }
    if (e.key === 'Escape' && showFileDropdown) {
      e.preventDefault()
      setShowFileDropdown(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        document.execCommand('insertText', false, '\n')
      } else {
        if (instructionText && !isWorking) {
          if (mode === 'chat') {
            handleChat()
          } else {
            handleEdit()
          }
        }
      }
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  const handleContentMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('chip-remove')) {
      e.preventDefault()
      const chip = target.closest('.inline-chip') as HTMLElement
      if (chip) {
        const isSelection = chip.dataset.role === 'selection'
        chip.remove()
        if (isSelection) {
          setPendingEditSelection(null)
        }
        handleInput()
      }
    }
  }

  // Handle sync of pendingEditSelection into inline tag chips and autofocus
  useEffect(() => {
    const div = inputRef.current
    if (!div) return

    if (pendingEditSelection) {
      // Find and remove any existing selection chip first to avoid duplicates
      const existingSelectionChip = div.querySelector('[data-role="selection"]')
      if (existingSelectionChip) {
        existingSelectionChip.remove()
      }

      // Create the new selection tag/chip
      const chip = document.createElement('span')
      chip.contentEditable = 'false'
      chip.className = 'inline-chip inline-chip-selection'
      chip.dataset.role = 'selection'
      chip.dataset.from = String(pendingEditSelection.from)
      chip.dataset.to = String(pendingEditSelection.to)
      chip.dataset.text = pendingEditSelection.text

      const len = pendingEditSelection.text.length
      appendSelectionChipText(chip, len)

      // Insert it at current selection/caret of input, or at the end if not inside
      const sel = window.getSelection()
      let range: Range | null = null
      if (sel && sel.rangeCount > 0) {
        const potentialRange = sel.getRangeAt(0)
        if (div.contains(potentialRange.startContainer)) {
          range = potentialRange
        }
      }

      if (!range) {
        range = document.createRange()
        range.selectNodeContents(div)
        range.collapse(false)
      }

      // Add a space after the selection tag.
      const zwsp = document.createTextNode('\u200B ')
      const fragment = document.createDocumentFragment()
      fragment.appendChild(chip)
      fragment.appendChild(zwsp)
      range.insertNode(fragment)

      // Focus and move caret after the space
      setTimeout(() => {
        const currentSel = window.getSelection()
        if (currentSel) {
          const rangeAfter = document.createRange()
          rangeAfter.setStartAfter(zwsp)
          rangeAfter.collapse(true)
          currentSel.removeAllRanges()
          currentSel.addRange(rangeAfter)
        }
        div.focus()
        handleInput()
      }, 0)
    } else {
      // When pendingEditSelection is null, clean up the selection chip if it exists in DOM
      const existingSelectionChip = div.querySelector('[data-role="selection"]')
      if (existingSelectionChip) {
        existingSelectionChip.remove()
        handleInput()
      }
    }
  }, [pendingEditSelection, handleInput, setPendingEditSelection])

  const hasHistory = filteredLogs.length > 0 || isWorking || !!errorText || !!noticeText

  const renderInputCard = () => (
    <InputGroup className="h-auto min-h-[92px] items-stretch rounded-[14px] bg-[var(--bg-elevated)] border-[var(--border-subtle)] focus-within:border-[var(--text-muted)] shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] duration-200 pt-3 px-3 pb-2 flex-col relative animate-scale-in">
      <div className="flex items-start gap-1.5 w-full">
        <div
          ref={inputRef}
          contentEditable
          role="textbox"
          aria-multiline="true"
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onMouseDown={handleContentMouseDown}
          data-placeholder={mode === 'chat' ? 'Ask a question...' : 'Describe changes...'}
          className="flex-1 min-w-0 bg-transparent border-0 p-0 text-xs focus:ring-0 focus:outline-none resize-none text-[var(--text)] min-h-[44px] font-sans leading-relaxed whitespace-pre-wrap empty:before:content-[attr(data-placeholder)] empty:before:text-[var(--text-muted)]"
        />
      </div>

      {showFileDropdown && (
        <div
          ref={dropdownRef}
          className="absolute left-2.5 right-2.5 bottom-full mb-1 z-50 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-[12px] overflow-hidden shadow-[0_4px_16px_rgba(0,0,0,0.03)]"
        >
          <Command>
            <CommandList className="max-h-[200px]">
              <CommandEmpty>
                <span className="text-[11px] text-[var(--text-secondary)] font-sans">
                  No matching files
                </span>
              </CommandEmpty>
              {filteredFiles.map((file, index) => (
                <CommandItem
                  key={file.path}
                  value={`${file.name} ${file.path}`}
                  onSelect={() => handleSelectFile(file)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  data-selected={index === highlightedIndex ? true : undefined}
                  className={`gap-2 px-3 py-2 ${index === highlightedIndex ? 'bg-[var(--bg-hover)]' : ''}`}
                >
                  <span className="text-xs text-[var(--text)] font-medium font-sans truncate">
                    {file.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)] font-sans truncate">
                    {file.path}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      )}

      {/* Input Action Bar */}
      <div className="flex items-center justify-between select-none">
        {/* Mode Toggle */}
        <div className="flex items-center">
          <button
            onClick={() => setMode(mode === 'edit' ? 'chat' : 'edit')}
            className={`flex items-center justify-center w-6 h-6 rounded-full transition-all duration-200 cursor-pointer -ml-1.5 ${mode === 'edit'
              ? 'text-[var(--accent-brown)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)]'
              }`}
            title={mode === 'edit' ? 'Switch to Chat mode' : 'Switch to Plan mode'}
          >
            {mode === 'edit' ? <SquareChartGantt size={12} /> : <ListTodo size={12} />}
          </button>
          {/* Harness selector: logo only, name in tooltip + dropdown */}
          <DropdownMenu open={showHarnessDropdown} onOpenChange={setShowHarnessDropdown}>
            <DropdownMenuTrigger
              aria-label={harness === 'none'
                ? (activeEndpointName ? `Endpoint — ${activeEndpointName}` : 'Endpoint')
                : harnessLabel(harness)}
              render={
                <button
                  className="ml-1 flex items-center gap-0.5 text-[var(--text-secondary)] hover:text-[var(--text-heading)] transition-colors cursor-pointer"
                >
                  <HarnessIcon id={harness} className="w-3.5 h-3.5" />
                  <ChevronDown className={`w-2.5 h-2.5 opacity-60 shrink-0 transition-transform duration-150 ${showHarnessDropdown ? 'rotate-180' : ''}`} />
                </button>
              }
            />
            <DropdownMenuContent side="top" align="start" className="min-w-[180px] bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={harness === 'none' ? 'text-[var(--text-heading)]' : 'text-[var(--text-secondary)]'}>
                  <HarnessIcon id="none" className="w-3.5 h-3.5" />
                  <span className="text-[11px] truncate flex-1">Endpoint</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[180px] bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
                  {endpointEntries.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
                      No endpoints yet
                    </div>
                  ) : (
                    endpointEntries.map(([id, ep]) => {
                      const isActive = harness === 'none' && settings?.active_endpoint === id
                      const displayName = id.replace('_', ' ')
                      return (
                        <DropdownMenuItem
                          key={id}
                          onClick={() => handlePickEndpoint(id)}
                          className={isActive ? 'text-[var(--text-heading)]' : 'text-[var(--text-secondary)]'}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className="text-[11px] truncate min-w-0 capitalize" title={displayName}>{displayName}</span>
                              {ep.supports_vision && (
                                <span title="Supports image input" className="flex shrink-0 text-[var(--text-muted)]">
                                  <Eye size={11} />
                                </span>
                              )}
                              {ep.is_thinking !== false ? (
                                <span title="Thinking enabled" className="flex shrink-0 text-[var(--text-muted)]">
                                  <Brain size={11} />
                                </span>
                              ) : (
                                <span title="Thinking disabled" className="flex shrink-0 text-[var(--text-muted)] opacity-50">
                                  <Brain size={11} />
                                </span>
                              )}
                            </span>
                            {ep.model && (
                              <span className="block text-[10px] leading-tight truncate text-[var(--text-muted)]" title={ep.model}>{ep.model}</span>
                            )}
                          </span>
                          <Check size={14} className={`shrink-0 ${isActive ? 'text-[var(--accent-brown)]' : 'invisible'}`} />
                        </DropdownMenuItem>
                      )
                    })
                  )}
                  <DropdownMenuSeparator className="bg-[var(--border-sidebar)]/60" />
                  <DropdownMenuItem
                    onClick={handleManageEndpoints}
                    className="text-[11px] text-[var(--text-secondary)]"
                  >
                    Manage endpoints
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {harnessList.map(h => (
                <DropdownMenuItem
                  key={h.id}
                  disabled={!h.installed}
                  onClick={() => {
                    updateSettings({ default_harness: h.id })
                    setShowHarnessDropdown(false)
                  }}
                  className={harness === h.id ? 'text-[var(--text-heading)]' : 'text-[var(--text-secondary)]'}
                >
                  <HarnessIcon id={h.id} className="w-3.5 h-3.5" />
                  <span className="text-[11px] truncate flex-1">{h.name}</span>
                  {h.installed ? null : <span className="text-[9px] text-[var(--text-muted)] shrink-0">not installed</span>}
                  <Check size={14} className={`shrink-0 ${harness === h.id ? 'text-[var(--accent-brown)]' : 'invisible'}`} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Context Ring and Action Button Group */}
        <div className="flex items-center gap-2 -mr-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setCharactersDialogOpen(true)}
                  className="relative flex items-center justify-center w-6 h-6 shrink-0 rounded-full text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  title="Active characters"
                  aria-label="Open active characters"
                >
                  <Users
                    size={14}
                    className={charactersTracking ? 'animate-pulse' : ''}
                  />
                  {activeCharacterCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[13px] h-[13px] px-[3px] rounded-full bg-[var(--accent-brown)] text-[var(--text-inverse)] text-[8px] leading-[13px] text-center font-medium tabular-nums">
                      {activeCharacterCount}
                    </span>
                  )}
                  {charactersError && (
                    <span className="absolute -bottom-0.5 -left-0.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                  )}
                </button>
              }
            />
            <TooltipContent
              side="top"
              align="end"
              className="max-w-[280px] whitespace-normal bg-[var(--bg-elevated)] border-[var(--border)] text-[10.5px]"
            >
              {charactersTracking
                ? 'Updating active cast…'
                : charactersError
                  ? `Character tracker: ${charactersError}`
                  : activeCharacterCount > 0
                    ? `${activeCharacterCount} active character${activeCharacterCount === 1 ? '' : 's'} — view cast`
                    : 'Active characters'}
            </TooltipContent>
          </Tooltip>

          {/* Circular Context Ring (hidden when no window is known) */}
          {activeContextWindow ? (
          <HoverCard>
            <HoverCardTrigger
              delay={10}
              closeDelay={100}
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-[10px] font-mono"
                >
                  <ChartNoAxesColumnIncreasing className="size-3" aria-hidden="true" />
                  <span>{Math.round(percentUsed)}%</span>
                </Button>
              }
            />
            <HoverCardContent className="flex w-64 flex-col gap-3" align="end">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">Context</span>
                <span className="text-muted-foreground">
                  {contextUsedTokens.toLocaleString()} / {activeContextWindow.toLocaleString()}
                </span>
              </div>
              <Progress value={percentUsed} aria-label="Context used" />
              <Context className="text-[var(--text-secondary)] leading-relaxed">
                <div className="flex justify-between gap-4"><ContextLabel>Session input:</ContextLabel><ContextValue className="text-[var(--text)]">{sessionInputTokens.toLocaleString()}</ContextValue></div>
                <div className="flex justify-between gap-4"><ContextLabel>Session output:</ContextLabel><ContextValue className="text-[var(--text)]">{sessionOutputTokens.toLocaleString()}</ContextValue></div>
                <div className="flex justify-between gap-4"><ContextLabel>{percentUsed.toFixed(1)}% used:</ContextLabel><ContextValue className="text-[var(--text)]">{percentLeft.toFixed(1)}% left</ContextValue></div>
              </Context>
            </HoverCardContent>
          </HoverCard>
          ) : null}

          {/* Action Button: Stop when working, Send/Submit otherwise */}
          <button
            onClick={() => {
              if (isWorking) {
                handleStop()
              } else if (mode === 'chat') {
                handleChat()
              } else {
                handleEdit()
              }
            }}
            disabled={!isWorking && !instructionText}
            className={`
              flex items-center justify-center transition-[background-color,transform,opacity] duration-150 cursor-pointer select-none border rounded-full w-6 h-6 shrink-0 active:scale-[0.9] 
              ${isWorking
                ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] border-[var(--border-subtle)] hover:border-[var(--danger-muted)]'
                : 'bg-[var(--accent-brown)] hover:bg-[var(--accent-brown-hover)] text-[var(--text-inverse)] disabled:bg-[var(--bg-disabled)] disabled:text-[var(--text-disabled)] disabled:border-transparent border-transparent'
              }
            `}
            title={isWorking ? 'Stop generation' : mode === 'chat' ? 'Send Message' : hasSelection ? 'Replace Selection' : 'Insert Content'}
          >
            {isWorking ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </InputGroup>
  )

  return (
    <div ref={containerRef} className="flex flex-col w-full h-full select-none animate-fade-in">
      {/* Header: tokens on left, actions on right */}
      <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-[var(--border-sidebar)] select-none shrink-0 w-full animate-fade-in">
        {/* Header Title */}
        <div className="text-[12px] font-medium text-[var(--text-heading)] font-serif pl-1">
        </div>
        {/* Action Buttons Group */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPlannerOpen(true)}
            className="flex items-center justify-center w-7 h-7 text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[6px] transition-all cursor-pointer active:scale-[0.95]"
            title="Plan next scene"
          >
            <Compass size={14} />
          </button>

          <button
            onClick={() => {
              const newId = crypto.randomUUID()
              setActiveSessionId(newId)
            }}
            className="flex items-center justify-center w-7 h-7 text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[6px] transition-all cursor-pointer active:scale-[0.95]"
            title="New Chat"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <path d="M10 3v14M3 10h14" />
            </svg>
          </button>

          <Popover
            open={showHistoryDropdown}
            onOpenChange={(open) => {
              if (open) handleHistoryOpen()
              else setShowHistoryDropdown(false)
            }}
          >
            <PopoverTrigger
              render={
                <button
                  className="flex items-center justify-center w-7 h-7 text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[6px] transition-all cursor-pointer active:scale-[0.95]"
                  title="History"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="var(--text-secondary)"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M11.25 7.75v5h3" /><path d="M4.855 7.875a8.25 8.25 0 1 1-.824 6.26m-.176-5.26v-4.75m0 4.75h4.75" /></g></svg>
                </button>
              }
            />
            <PopoverContent align="end" sideOffset={6} className="w-[260px] p-2 bg-[var(--bg-elevated)] border-[var(--border-subtle)]">
              <Tabs value={historyView} onValueChange={(v) => handleHistoryViewChange(v as 'chats' | 'images')}>
                <TabsList variant="line" className="w-full">
                  <TabsTrigger value="chats" className="text-[11px]">
                    Chats
                    {sessions.length > 0 && (
                      <Badge variant="secondary" className="ml-1 px-1 py-0 text-[9px]">{sessions.length}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="images" className="text-[11px]">Imagine</TabsTrigger>
                </TabsList>
                <TabsContent value="chats" className="mt-1">
                  {sessions.length === 0 ? (
                    <div className="px-3 py-2 text-center text-[11px] text-[var(--text-muted)] font-sans">
                      No logs
                    </div>
                  ) : (
                    <ScrollArea className="max-h-[280px]">
                      <div className="flex flex-col gap-0.5 pr-2">
                        {sessions.slice(0, sessionLoadCount).map(session => (
                          <div key={session.id} className="group flex items-center gap-1 px-2 py-1 rounded-[4px] hover:bg-[var(--bg-hover)] transition-colors">
                            <button
                              onClick={() => { setActiveSessionId(session.id); setShowHistoryDropdown(false) }}
                              className={`flex-1 min-w-0 text-left text-[11px] cursor-pointer ${activeSessionId === session.id ? 'text-[var(--text-heading)]' : 'text-[var(--text-secondary)]'}`}
                            >
                              <span className="truncate block pr-1">{session.name}</span>
                            </button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={async (e) => {
                                e.stopPropagation()
                                try {
                                  const res = await apiFetch(`${API_BASE}/api/assist/simple/session/${session.id}`, { method: 'DELETE' })
                                  if (!res.ok) {
                                    console.warn('DELETE session returned', res.status)
                                    toast.error('Could not delete that session.')
                                  }
                                } catch (e) {
                                  console.error('Failed to delete session:', e)
                                  toast.error('Could not delete that session.')
                                }
                                if (activeSessionId === session.id) {
                                  setActiveSessionId(crypto.randomUUID())
                                }
                                await fetchLogs()
                              }}
                              className="opacity-0 group-hover:opacity-100 text-[var(--text-secondary)]/60 hover:text-red-500"
                              title="Delete session"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                        {sessions.length > sessionLoadCount && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSessionLoadCount(c => c + 5)}
                            className="w-full text-[11px] text-[var(--text-secondary)]"
                          >
                            Show {sessions.length - sessionLoadCount} more...
                          </Button>
                        )}
                      </div>
                    </ScrollArea>
                  )}
                </TabsContent>
                <TabsContent value="images" className="mt-1">
                  {imageLogs === null ? (
                    <div className="flex flex-col gap-2 p-2">
                      <Skeleton className="h-11 w-full" />
                      <Skeleton className="h-11 w-full" />
                      <Skeleton className="h-11 w-full" />
                    </div>
                  ) : imageLogs.length === 0 ? (
                    <div className="px-3 py-4 text-center font-sans">
                      <div className="text-[11px] text-[var(--text-muted)]">No imagines yet</div>
                    </div>
                  ) : (
                    <ScrollArea className="max-h-[320px]">
                      <div className="flex flex-col gap-0.5 pr-2">
                        {imageLogs.slice(0, imageLoadCount).map((log, i) => (
                          <div
                            key={imageKey(log, i)}
                            className="group flex items-center gap-1 px-2 py-1 mb-0.5 rounded-[4px] hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            <button
                              onClick={() => { setSelectedImage(log); setShowHistoryDropdown(false) }}
                              className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer"
                            >
                              {log.path ? (
                                <img
                                  src={toDisplaySrc(log.path)}
                                  alt=""
                                  className="h-9 w-9 rounded-[4px] border border-[var(--border-subtle)] object-cover shrink-0"
                                />
                              ) : (
                                <span className="h-9 w-9 rounded-[4px] border border-[var(--border-subtle)] bg-[var(--bg-hover)] shrink-0" />
                              )}
                              <span className="flex-1 min-w-0">
                                <span className="truncate block text-[11px] text-[var(--text-secondary)] pr-1">
                                  {(log.prompt || log.final_prompt || 'Untitled').slice(0, 60)}
                                </span>
                                <span className="truncate block text-[10px] text-[var(--text-muted)] pr-1">
                                  {log.timestamp ? new Date(log.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                                  {log.timestamp ? ` ${new Date(log.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}
                                </span>
                              </span>
                            </button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={(e) => handleDeleteImageLog(e, log, i)}
                              className="opacity-0 group-hover:opacity-100 text-[var(--text-secondary)]/60 hover:text-red-500 shrink-0"
                              title="Delete log entry"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                        {imageLogs.length > imageLoadCount && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setImageLoadCount(c => c + 10)}
                            className="w-full text-[11px] text-[var(--text-secondary)]"
                          >
                            Show {imageLogs.length - imageLoadCount} more...
                          </Button>
                        )}
                      </div>
                    </ScrollArea>
                  )}
                </TabsContent>
              </Tabs>
            </PopoverContent>
          </Popover>

          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center justify-center w-7 h-7 text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[6px] transition-all cursor-pointer active:scale-[0.95]"
            title="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* History area (scrollable) */}
      {hasHistory && (
        <Chat>
          <MessageScroller>
          <ChatMessages className="gap-4 pr-1 pt-2 select-text">
            {displayLogs.map((log) => {
              const isExpanded = !!expandedIds[log.id]

              const plannerContextFiles: string[] = (() => {
                if (!log.planner_output) return []
                try {
                  const start = log.planner_output.indexOf('{')
                  const end = log.planner_output.lastIndexOf('}') + 1
                  if (start !== -1 && end > start) {
                    const data = JSON.parse(log.planner_output.slice(start, end))
                    if (Array.isArray(data.context_needed)) {
                      return data.context_needed
                    }
                  }
                } catch {
                  // Malformed planner output has no context entries.
                }
                return []
              })()

              return (
                <Message key={log.id} className="group gap-3">
                  {/* User Speech Capsule Bubble */}
                  <Bubble align="end" variant="muted" className="font-sans text-[var(--text)] flex flex-wrap items-center gap-1 animate-scale-in">
                    <BubbleContent>{renderUserPrompt(cleanUserPrompt(log))}</BubbleContent>
                  </Bubble>
                  <MessageFooter className="self-end opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <Tooltip>
                      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => handlePromptToInput(log)} aria-label="Restore prompt to input"><Undo2 /></Button>} />
                      <TooltipContent>Restore prompt to input</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => void handleCopyPrompt(log)} aria-label="Copy prompt">
                        {copiedId === log.id ? <Check className="text-green-600 dark:text-green-400" /> : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="14" height="14" x="8" y="8" rx="2" />
                            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 1 2 2" />
                          </svg>
                        )}
                      </Button>} />
                      <TooltipContent>{copiedId === log.id ? 'Copied' : 'Copy prompt'}</TooltipContent>
                    </Tooltip>
                  </MessageFooter>

                  {/* AI Assistant Plain Text Response */}
                  <MessageContent className="w-full py-1 animate-scale-in">
                    <div className="flex items-center gap-2.5 select-none text-[var(--text-muted)]">
                      <button
                        onClick={() => setExpandedIds(prev => ({ ...prev, [log.id]: !prev[log.id] }))}
                        className="flex items-center gap-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] transition-colors cursor-pointer"
                        title="Toggle prompt details"
                      >
                        <span>Telemetry</span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`w-2.5 h-2.5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="text-[10px] font-mono text-[var(--text-secondary)] leading-normal select-text whitespace-pre-wrap mt-1 p-2 bg-[var(--bg-expanded)]/50 border border-[var(--border)] rounded-[6px] animate-fade-in w-full flex flex-col gap-3">
                        {((log.ref_files && log.ref_files.length > 0) || log.selected_text || plannerContextFiles.length > 0) && (
                          <div className="flex flex-col gap-1 border-b border-[var(--border)] pb-2 mb-1 select-none">
                            {log.ref_files?.map((file) => (
                              <div key={file.path} className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-secondary)] font-sans">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                                <span>Read {file.name}</span>
                              </div>
                            ))}
                            {plannerContextFiles.map((filepath) => {
                              return (
                                <div key={filepath} className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-secondary)] font-sans">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                  <span>{filepath}</span>
                                </div>
                              )
                            })}
                            {log.selected_text && (
                              <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-secondary)] font-sans">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                                <span>Read editor selection ({log.selected_text.length} Ch)</span>
                              </div>
                            )}
                            {log.tool_calls?.map((t, i) => (
                              <div key={`tool-${i}`} className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-secondary)] font-sans">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                                </svg>
                                <span>{t.tool}{t.detail ? ` ${t.detail}` : ''}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {log.planner_system_prompt && (
                          <div className="flex flex-col gap-1">
                            <span className="text-[9px] uppercase tracking-widest font-sans text-[var(--text-muted)] font-semibold">① Planner</span>
                            <div><strong>System:</strong> {log.planner_system_prompt}</div>
                            <div className="mt-1"><strong>User:</strong> {log.planner_user_prompt}</div>
                            <div className="mt-1"><strong>Output:</strong> {log.planner_output}</div>
                          </div>
                        )}
                        {log.planner_system_prompt && (
                          <div className="border-t border-[var(--border)] pt-2 mt-1" />
                        )}
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-widest font-sans text-[var(--text-muted)] font-semibold">{log.planner_system_prompt ? '② Generator' : 'Prompt'}</span>
                          <div><strong>System:</strong> {log.system_prompt}</div>
                          <div className="mt-1"><strong>User:</strong> {log.user_prompt}</div>
                        </div>
                        {log.post_processing && (
                          <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-2 mt-1">
                            <span className="text-[9px] uppercase tracking-widest font-sans text-[var(--text-muted)] font-semibold">Post-processing</span>
                            {log.post_processing.skipped ? (
                              <div>Skipped ({log.post_processing.reason || 'not applicable'})</div>
                            ) : (
                              <>
                                {(log.post_processing.passes || []).map((pass, i) => (
                                  <div key={`pp-${i}`} className="flex items-center gap-1.5">
                                    <span className="text-[var(--text-muted)]">{pass.hunk ? `hunk ${pass.hunk} · ` : ''}{pass.name}</span>
                                    <span className={pass.status === 'ok' ? 'text-green-600 dark:text-green-400' : pass.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}>
                                      {pass.status}
                                    </span>
                                    {pass.model && <span className="text-[var(--text-muted)]">{pass.model}</span>}
                                    {pass.error && <span className="text-[var(--danger)]">{pass.error}</span>}
                                  </div>
                                ))}
                                {log.post_processing.skipped_hunks ? (
                                  <div className="text-[var(--text-muted)]">{log.post_processing.skipped_hunks} hunk(s) not post-processed (cap or minimum length)</div>
                                ) : null}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Thinking dropdown — visible when thinking output exists */}
                    {log.thinking_output && (
                      <div className="mt-0.5">
                        <ThinkingDropdown text={log.thinking_output} defaultOpen={false} />
                      </div>
                    )}

                    {/* Always-visible context rows — ref files + planner context + selection */}
                    {((log.ref_files && log.ref_files.length > 0) || log.selected_text || plannerContextFiles.length > 0) && (() => {
                      const uniqueFiles = new Map<string, string>()
                      log.ref_files?.forEach(f => uniqueFiles.set(f.name, f.name))
                      // Only add planner files not already shown as user-tagged chips
                      const refFileNames = new Set((log.ref_files || []).map(f => f.name))
                      plannerContextFiles.forEach(f => {
                        const name = f.split('/').pop() || f
                        if (!refFileNames.has(name)) uniqueFiles.set(name, name)
                      })

                      return (
                        <div className="flex flex-col gap-1 mt-1 select-none">
                          {Array.from(uniqueFiles.values()).map((name, i) => (
                            <div key={i} className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)] font-sans">
                              <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                              <span>Read {name}</span>
                            </div>
                          ))}
                          {log.selected_text && (
                            <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)] font-sans">
                              <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                              <span>Read editor selection ({log.selected_text.length} ch)</span>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    <div className={`text-xs font-sans leading-relaxed select-text mt-1 ${log.success === false ? 'text-[var(--danger)] font-medium whitespace-pre-wrap' : 'text-[var(--text)]'}`}>
                      {log.success === false ? log.output : log.output ? (
                        <ContextMenu>
                          <ContextMenuTrigger className="block select-text">
                            <AssistMarkdown className="assist-markdown">{log.output}</AssistMarkdown>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-40 bg-[var(--bg-elevated)] border-[var(--border)]">
                            <ContextMenuItem
                              onClick={() => {
                                const editor = useEditorStore.getState().editor
                                if (editor && !editor.isDestroyed) {
                                  editor.chain().focus().insertContent(log.output).run()
                                }
                              }}
                              className="text-[11px] text-[var(--text-secondary)] focus:bg-[var(--bg-hover)] focus:text-[var(--text-heading)]"
                              title="Insert raw markdown at cursor"
                            >
                              Insert at cursor
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(log.output)
                                  toast.success('Copied to clipboard')
                                } catch (err) {
                                  console.error('Failed to copy', err)
                                  toast.error('Could not copy to clipboard.')
                                }
                              }}
                              className="text-[11px] text-[var(--text-secondary)] focus:bg-[var(--bg-hover)] focus:text-[var(--text-heading)]"
                            >
                              Copy
                            </ContextMenuItem>
                            <ContextMenuSeparator className="bg-[var(--border)]" />
                            <ContextMenuSub>
                              <ContextMenuSubTrigger
                                disabled={!!runningPass}
                                className="text-[11px] text-[var(--text-secondary)] focus:bg-[var(--bg-hover)] focus:text-[var(--text-heading)]"
                              >
                                Run post-processing pass
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="w-56 bg-[var(--bg-elevated)] border-[var(--border)]">
                                {oneOffPasses.length === 0 ? (
                                  <ContextMenuItem
                                    disabled
                                    className="text-[11px] text-[var(--text-muted)]"
                                  >
                                    No passes configured
                                  </ContextMenuItem>
                                ) : (
                                  oneOffPasses.map((pass) => {
                                    const isRunning =
                                      runningPass?.logId === log.id &&
                                      runningPass.passId === pass.id
                                    return (
                                      <ContextMenuItem
                                        key={pass.id}
                                        disabled={!!runningPass}
                                        onClick={() => void handleRunPostProcessPass(log, pass)}
                                        className="text-[11px] text-[var(--text-secondary)] focus:bg-[var(--bg-hover)] focus:text-[var(--text-heading)]"
                                        title={`Run ${pass.name} on this response only`}
                                      >
                                        {isRunning ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : null}
                                        <span className="flex-1 truncate">{pass.name}</span>
                                        {!pass.enabled ? (
                                          <span className="text-[9px] text-[var(--text-muted)]">
                                            off
                                          </span>
                                        ) : null}
                                      </ContextMenuItem>
                                    )
                                  })
                                )}
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                          </ContextMenuContent>
                        </ContextMenu>
                      ) : null}
                    </div>
                    {log.success !== false && log.output && (
                      <MessageFooter className="opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => void handleCopyResponse(log)} aria-label="Copy response">
                            {copiedResponseId === log.id ? <Check className="text-green-600 dark:text-green-400" /> : <span className="text-[10px]">Copy</span>}
                          </Button>} />
                          <TooltipContent>{copiedResponseId === log.id ? 'Copied' : 'Copy response'}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => handleInsertResponse(log)} aria-label="Insert response"><span className="text-[10px]">Insert</span></Button>} />
                          <TooltipContent>Insert response at cursor</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => handleRetry(log)} aria-label="Retry response"><Undo2 /></Button>} />
                          <TooltipContent>Retry response</TooltipContent>
                        </Tooltip>
                      </MessageFooter>
                    )}
                  </MessageContent>
                </Message>
              )
            })}

            {isWorking && activeInstruction && (
              <Message className="gap-2.5 animate-fade-in">
                {/* User Prompt */}
                <Bubble align="end" variant="muted" className="font-sans text-[var(--text)] opacity-70">
                  <BubbleContent>{renderUserPrompt(activeInstruction)}</BubbleContent>
                </Bubble>
                {/* Context Readings Logs */}
                {activeRefFiles.map((file) => (
                  <div key={file.path} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] font-sans select-none ml-1">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Reading {file.name}</span>
                  </div>
                ))}
                {/* Planner context files — only show ones the user didn't already tag */}
                {plannerContextFiles
                  .filter(filepath => {
                    const name = filepath.split('/').pop() || filepath
                    return !activeRefFiles.some(f => f.name === name)
                  })
                  .map((filepath) => {
                    const name = filepath.split('/').pop() || filepath
                    return (
                      <div key={filepath} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] font-sans select-none ml-1">
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span>Reading {name}</span>
                      </div>
                    )
                  })}

                {/* Harness tool calls (structured harnesses) */}
                {activeToolRows.length > 0 && (
                  <Trace className="ml-1 gap-1">
                    {activeToolRows.map((t, i) => (
                      <TraceLine key={`htool-${i}`} className="text-[11px] font-sans">
                        <TraceIcon>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                          </svg>
                        </TraceIcon>
                        <TraceTitle>{t.tool}{t.detail ? ` ${t.detail}` : ''}</TraceTitle>
                      </TraceLine>
                    ))}
                  </Trace>
                )}

                {streamingThinkingText && (
                  <div className="self-start w-full">
                    <ThinkingDropdown text={streamingThinkingText} defaultOpen={true} />
                  </div>
                )}

                {/* Live chat stream render (also harness progress output) */}
                {(mode === 'chat' || activeHarness !== 'none') && streamingChatText && (
                  <div className="flex flex-col gap-1.5 self-start w-full select-text max-w-full py-1 animate-scale-in relative group">
                    <div className="text-xs font-sans leading-relaxed select-text text-[var(--text)]">
                      <AssistMarkdown streaming className="assist-markdown">{streamingChatText}</AssistMarkdown>
                    </div>
                    {/* Hover context menu */}
                    <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col gap-0.5 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[6px] shadow-lg z-10 p-0.5 min-w-[120px]">
                      <button
                        onClick={() => {
                          const editor = useEditorStore.getState().editor
                          if (editor && !editor.isDestroyed) {
                            editor.chain().focus().insertContent(streamingChatText).run()
                          }
                        }}
                        className="px-2 py-1 text-[10px] text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-heading)] rounded-[4px] transition-colors cursor-pointer"
                        title="Insert raw markdown at cursor"
                      >
                        Insert at cursor
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(streamingChatText)
                            toast.success('Copied to clipboard')
                          } catch (err) {
                            console.error('Failed to copy', err)
                            toast.error('Could not copy to clipboard.')
                          }
                        }}
                        className="px-2 py-1 text-[10px] text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-heading)] rounded-[4px] transition-colors cursor-pointer"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                {/* Phase-aware status indicator */}
                <Trace ref={outputRef} className="py-1">
                  <TraceLine className="text-xs font-serif italic">
                  <div className={`status-indicator-square ${isPlanning ? 'animate-planning' : isGenerating ? 'animate-generating-pulse' : ''}`}>
                    <div className={`status-indicator-inner ${isGenerating ? 'animate-orbit' : ''}`} />
                  </div>
                  <TraceIcon><span className="animate-shimmer">
                    {postProcessStatus
                      ? `Post-processing${postProcessStatus.name ? ` · ${postProcessStatus.name}` : ''}${postProcessStatus.total ? ` (${Math.min(postProcessStatus.index + 1, postProcessStatus.total)}/${postProcessStatus.total})` : ''}…`
                      : activeHarness !== 'none' && isWorking ? `${harnessLabel(activeHarness)} working…` : isPlanning ? 'Planning...' : isGenerating ? 'Generating...' : 'Thinking about the edit...'}
                  </span></TraceIcon>
                  <TraceTitle className="animate-shimmer">{postProcessStatus ? 'Working' : isPlanning ? 'Planning' : isGenerating ? 'Generating' : 'Thinking'}</TraceTitle>
                  </TraceLine>
                </Trace>
              </Message>
            )}

            {errorText && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--danger)] bg-[var(--danger-bg)] border border-[var(--danger-muted)] rounded-[8px] px-2.5 py-2 font-sans self-start select-none animate-fade-in" ref={outputRef}>
                <span>{errorText}</span>
              </div>
            )}

            {noticeText && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-[8px] px-2.5 py-2 font-sans self-start select-none animate-fade-in">
                <span>{noticeText}</span>
              </div>
            )}
          </ChatMessages>
          </MessageScroller>
        </Chat>
      )}

      {!hasHistory && (
        <div className="flex-1 flex flex-col justify-center px-5 py-10 animate-fade-in max-w-[300px] mx-auto select-none font-sans text-left">
          <div className="text-center mb-6">
            <div className="mt-3 text-[18px] font-medium text-[var(--text-heading)] font-serif">
              M<em>a</em>rg<em>i</em>n
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-muted)] font-sans">
              Edit, ask, and pull context into the draft.
            </p>
          </div>

          <div className="flex flex-col gap-2.5 text-[11px] text-[var(--text-secondary)]">
            <div className="flex gap-2.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
              <AtSign size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              <p className="leading-normal text-[var(--text)]">Type <code className="font-mono text-[9.5px] bg-[var(--bg-hover)] px-1 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text)]">@</code> to add markdown files.</p>
            </div>

            <div className="flex gap-2.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
              <Code2 size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              <p className="leading-normal text-[var(--text)]"><strong className="font-medium">Edit</strong> changes text, <strong className="font-medium">Chat</strong> answers questions.</p>
            </div>

            <div className="flex gap-2.5 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
              <MousePointer2 size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              <p className="leading-normal text-[var(--text)]">Place the cursor or highlight text to guide the edit.</p>
            </div>
          </div>
        </div>
      )}

      {/* Input Card always anchored cleanly at the bottom */}
      <div className="shrink-0 mt-auto pt-2">
        {renderInputCard()}
      </div>

      {selectedImage && (
        <ImageDetailPopup log={selectedImage} onClose={() => setSelectedImage(null)} />
      )}

      <CharacterDialog />

      <ScenePlanner
        key={linkedWorkspaceDir ?? 'sample'}
        open={plannerOpen}
        onOpenChange={setPlannerOpen}
        harnessList={harnessList}
      />
    </div>
  )
}
