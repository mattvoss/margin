// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../lib/api'
import { DEFAULT_SETTINGS } from '../lib/settingsScope'
import { useEditorStore } from './editorStore'
import { useSettingsStore } from './settingsStore'

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>

function okResponse(): Response {
  return { ok: true, statusText: 'OK', json: async () => ({}) } as unknown as Response
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS })
  useEditorStore.setState({
    content: '',
    currentFilePath: null,
    openedFiles: [],
    aiPendingEdit: null,
    autoSaveTimer: null,
    isSaving: false,
    isStreaming: false,
    editor: null,
  })
})

afterEach(() => {
  const timer = useEditorStore.getState().autoSaveTimer
  if (timer) clearTimeout(timer)
  vi.useRealTimers()
})

describe('acceptAiEdit', () => {
  it('persists the accepted AI content and clears the review', async () => {
    apiFetchMock.mockResolvedValue(okResponse())
    useEditorStore.setState({
      currentFilePath: 'chapters/chapter-1.md',
      content: '# Chapter 1\n\nAI rewritten text',
      openedFiles: [
        {
          name: 'chapter-1.md',
          path: 'chapters/chapter-1.md',
          content: '# Chapter 1\n\nAI rewritten text',
          originalContent: '# Chapter 1\n\noriginal text',
        },
      ],
      aiPendingEdit: { previousContent: '# Chapter 1\n\noriginal text' },
    })

    await useEditorStore.getState().acceptAiEdit()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = apiFetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('/api/workspace/files')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(String(init.body)) as { filename: string; content: string }
    expect(body.filename).toBe('chapters/chapter-1.md')
    expect(body.content).toBe('# Chapter 1\n\nAI rewritten text')

    const s = useEditorStore.getState()
    expect(s.aiPendingEdit).toBeNull()
    expect(s.openedFiles[0].originalContent).toBe('# Chapter 1\n\nAI rewritten text')
  })

  it('does not save when the accepted content is unchanged', async () => {
    apiFetchMock.mockResolvedValue(okResponse())
    useEditorStore.setState({
      currentFilePath: 'a.md',
      content: 'same',
      openedFiles: [
        { name: 'a.md', path: 'a.md', content: 'same', originalContent: 'same' },
      ],
      aiPendingEdit: { previousContent: 'same' },
    })

    await useEditorStore.getState().acceptAiEdit()

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(useEditorStore.getState().aiPendingEdit).toBeNull()
  })

  it('does not save untitled documents', async () => {
    apiFetchMock.mockResolvedValue(okResponse())
    useEditorStore.setState({
      currentFilePath: null,
      content: 'AI text',
      openedFiles: [],
      aiPendingEdit: { previousContent: '' },
    })

    await useEditorStore.getState().acceptAiEdit()

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(useEditorStore.getState().aiPendingEdit).toBeNull()
  })
})

describe('autosave while a review is pending', () => {
  it('writes the pre-edit content, never the unreviewed AI text', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(okResponse())
    useEditorStore.setState({
      currentFilePath: 'a.md',
      content: 'AI text',
      openedFiles: [
        { name: 'a.md', path: 'a.md', content: 'AI text', originalContent: 'original' },
      ],
      // User had edited before the AI edit — previousContent must win.
      aiPendingEdit: { previousContent: 'user edit' },
    })

    useEditorStore.getState().setContent('AI text')
    await vi.advanceTimersByTimeAsync(1000)

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = apiFetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { content: string }
    expect(body.content).toBe('user edit')
  })
})

describe('autosave while streaming', () => {
  function seedStreaming() {
    useEditorStore.setState({
      isStreaming: true,
      currentFilePath: 'a.md',
      content: 'partial',
      openedFiles: [
        { name: 'a.md', path: 'a.md', content: 'partial', originalContent: 'orig' },
      ],
      aiPendingEdit: null,
    })
  }

  it('does not persist partial streamed content', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(okResponse())
    seedStreaming()

    useEditorStore.getState().setContent('partial more')
    await vi.advanceTimersByTimeAsync(1000)

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(useEditorStore.getState().autoSaveTimer).toBeNull()
  })

  it('flushSave is a no-op while streaming', async () => {
    apiFetchMock.mockResolvedValue(okResponse())
    seedStreaming()

    await useEditorStore.getState().flushSave()

    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('resumes autosave once streaming ends', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(okResponse())
    seedStreaming()

    useEditorStore.getState().setContent('partial more')
    await vi.advanceTimersByTimeAsync(1000)
    expect(apiFetchMock).not.toHaveBeenCalled()

    useEditorStore.getState().setIsStreaming(false)
    useEditorStore.getState().setContent('final content')
    await vi.advanceTimersByTimeAsync(1000)

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = apiFetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { content: string }
    expect(body.content).toBe('final content')
  })
})
