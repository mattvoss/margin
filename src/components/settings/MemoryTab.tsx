import { useCallback, useEffect, useState } from 'react'
import { Archive, CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react'
import { API_BASE, apiFetch } from '../../lib/api'
import { useSettingsStore } from '../../stores/settingsStore'
import { useEditorStore } from '../../stores/editorStore'
import { FilterSection, SectionCard, SectionLabel } from './shared'

type MemoryStatus = {
  state: 'off' | 'needs_embedding_model' | 'ready' | 'unavailable'
  enabled: boolean
  recallEnabled: boolean
  extractionEnabled: boolean
  embeddingConfigured: boolean
  embeddingModel?: string
  activeCount: number
  archivedCount: number
  lastSavedAt: string | null
  workspaceScoped: boolean
}

type Memory = {
  memoryId: string
  kind: string
  content: string
  updatedAt: string
  accessCount: number
  archived: boolean
  source: { path: string; startLine: number | null; endLine: number | null; heading: string | null; contentHash: string | null } | null
  sourceReferenceStale: boolean
  mentions: Array<{ path: string; name: string; managedBy: 'user' | 'indexer' }>
}

type IndexResult = {
  filesDiscovered: number
  filesIndexed: number
  memoriesSaved: number
  filesSkipped: number
  failures: Array<{ path: string; reason: string }>
}

const stateCopy: Record<MemoryStatus['state'], { label: string; detail: string }> = {
  off: { label: 'Memory is off', detail: 'Enable memory on the server to use workspace memory.' },
  needs_embedding_model: { label: 'Embedding model needed', detail: 'Add an embedding model to the active endpoint in Settings → Endpoints.' },
  ready: { label: 'Memory is ready', detail: 'Memory can recall relevant items and save extracted memories for this workspace.' },
  unavailable: { label: 'Memory is unavailable', detail: 'Memory failed a storage or provider check. Chat continues without it.' },
}

export function MemorySettings({ query }: { query: string }) {
  const workspace = useSettingsStore(state => state.settings.linked_workspace_dir)
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState<IndexResult | null>(null)
  const [files, setFiles] = useState<Array<{ name: string; path: string }>>([])
  const [editingMentions, setEditingMentions] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const suffix = showArchived ? '?archived=true' : ''
      const [statusResponse, memoryResponse] = await Promise.all([
        apiFetch(`${API_BASE}/api/memory/status`),
        apiFetch(`${API_BASE}/api/memory${suffix}`),
      ])
      if (!statusResponse.ok || !memoryResponse.ok) throw new Error('Could not load memory status.')
      setStatus(await statusResponse.json() as MemoryStatus)
      setMemories(await memoryResponse.json() as Memory[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load memory.')
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  useEffect(() => {
    void apiFetch(`${API_BASE}/api/workspace/files`).then(response => response.ok ? response.json() : []).then(body => {
      if (Array.isArray(body)) setFiles(body as Array<{ name: string; path: string }>)
    }).catch(() => undefined)
  }, [workspace])

  const archive = async (memoryId: string) => {
    const response = await apiFetch(`${API_BASE}/api/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' })
    if (!response.ok) {
      setError('Could not archive that memory.')
      return
    }
    void load()
  }

  const testMemory = async () => {
    setTesting(true)
    setError(null)
    try {
      const response = await apiFetch(`${API_BASE}/api/memory/test`, { method: 'POST' })
      if (!response.ok) throw new Error('Memory provider or storage is unavailable.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Memory test failed.')
    } finally {
      setTesting(false)
    }
  }

  const indexMarkdown = async () => {
    setIndexing(true)
    setIndexResult(null)
    setError(null)
    try {
      const response = await apiFetch(`${API_BASE}/api/memory/index/`, { method: 'POST' })
      const body = await response.json().catch(() => null) as IndexResult | { detail?: string } | null
      if (!response.ok) {
        throw new Error(body && 'detail' in body && typeof body.detail === 'string' ? body.detail : 'Could not index Markdown files.')
      }
      setIndexResult(body as IndexResult)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not index Markdown files.')
    } finally {
      setIndexing(false)
    }
  }

  const updateMentions = async (memory: Memory, paths: string[]) => {
    setEditingMentions(memory.memoryId)
    try {
      const response = await apiFetch(`${API_BASE}/api/memory/${encodeURIComponent(memory.memoryId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mentions: paths }),
      })
      if (!response.ok) throw new Error('Could not update file mentions.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update file mentions.')
    } finally {
      setEditingMentions(null)
    }
  }

  const visible = memories.filter(memory =>
    !filter.trim() || `${memory.kind} ${memory.content}`.toLowerCase().includes(filter.trim().toLowerCase()),
  )
  const summary = status ? stateCopy[status.state] : null

  return (
    <div className="flex flex-col gap-6">
      <FilterSection query={query} keywords="memory remembered recall saved embeddings workspace archive">
        <section>
          <SectionLabel description="Memory is private to the active workspace. Remembered text is shown as data, not instructions.">Workspace memory</SectionLabel>
          <SectionCard className="p-4">
            {loading ? <p role="status" className="text-[12px] text-[var(--text-secondary)]">Loading memory status…</p> : (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  {status?.state === 'ready' ? <CheckCircle2 size={17} className="text-green-600 mt-0.5" aria-hidden="true" /> : <CircleAlert size={17} className="text-[var(--accent-brown)] mt-0.5" aria-hidden="true" />}
                  <div>
                    <p className="text-[13px] font-medium text-[var(--text-heading)]">{summary?.label ?? 'Memory status unknown'}</p>
                    <p className="text-[12px] text-[var(--text-secondary)]">{summary?.detail}</p>
                  </div>
                </div>
                {status && <div className="grid grid-cols-2 gap-2 text-[12px] text-[var(--text-secondary)] sm:grid-cols-4">
                  <span>Recall: <strong className="text-[var(--text-heading)]">{status.recallEnabled ? 'On' : 'Off'}</strong></span>
                  <span>Auto-save: <strong className="text-[var(--text-heading)]">{status.extractionEnabled ? 'On' : 'Off'}</strong></span>
                  <span>Active: <strong className="text-[var(--text-heading)]">{status.activeCount}</strong></span>
                  <span>Archived: <strong className="text-[var(--text-heading)]">{status.archivedCount}</strong></span>
                </div>}
                {status?.embeddingModel && <p className="text-[11px] text-[var(--text-muted)]">Embedding model: {status.embeddingModel}</p>}
                <div className="flex flex-wrap gap-3">
                <button onClick={() => void testMemory()} disabled={testing || status?.state !== 'ready'} className="self-start inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] disabled:opacity-50" aria-label="Test memory connection">
                  <CheckCircle2 size={13} /> {testing ? 'Testing…' : 'Test memory'}
                </button>
                <button onClick={() => void load()} className="self-start inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-heading)]" aria-label="Refresh memory status">
                  <RefreshCw size={13} /> Refresh
                </button>
                <button onClick={() => void indexMarkdown()} disabled={indexing || status?.state !== 'ready'} className="self-start inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] disabled:opacity-50" aria-label="Index all Markdown files">
                  <RefreshCw size={13} /> {indexing ? 'Indexing…' : 'Index Markdown files'}
                </button>
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">Indexing sends Markdown content to the configured LLM and embedding providers. Existing memories generated from each file are replaced after successful indexing.</p>
                {indexResult && <div role="status" className="text-[12px] text-[var(--text-secondary)]">
                  Indexed {indexResult.filesIndexed} of {indexResult.filesDiscovered} files and saved {indexResult.memoriesSaved} memories{indexResult.filesSkipped ? `; skipped ${indexResult.filesSkipped}` : ''}.
                  {indexResult.failures.length > 0 && <span className="block text-[var(--accent-brown)]">{indexResult.failures.length} file{indexResult.failures.length === 1 ? '' : 's'} failed: {indexResult.failures.map(failure => failure.path).join(', ')}</span>}
                </div>}
              </div>
            )}
            {error && <p role="alert" className="mt-3 text-[12px] text-red-600">{error}</p>}
          </SectionCard>
        </section>
      </FilterSection>

      <FilterSection query={query} keywords="memory remembered recall saved embeddings workspace archive list">
        <section>
          <div className="flex items-end justify-between gap-3 mb-2">
            <SectionLabel description="These are the memories currently stored for this workspace.">Remembered items</SectionLabel>
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)] pb-2"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>
          </div>
          <div className="flex gap-2 mb-2">
            <input aria-label="Filter memories" placeholder="Filter memories" value={filter} onChange={e => setFilter(e.target.value)} className="w-full border border-[var(--border-subtle)] rounded-[8px] px-3 py-2 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none" />
          </div>
          <SectionCard>
            {visible.length === 0 ? <p role="status" className="p-4 text-[12px] text-[var(--text-secondary)]">{status?.state === 'ready' ? 'No memories have been saved for this workspace yet.' : 'Memories will appear here when memory is configured and used.'}</p> : visible.map(memory => (
              <div key={memory.memoryId} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]"><span className="uppercase tracking-wide">{memory.kind.replace('_', ' ')}</span><span>·</span><span>{memory.accessCount} recalls</span></div>
                  <p className="mt-1 text-[13px] text-[var(--text)] whitespace-pre-wrap break-words">{memory.content}</p>
                  {memory.source && <div className="mt-2 text-[11px] text-[var(--text-muted)]">
                    <button className="underline hover:text-[var(--text)]" onClick={() => void useEditorStore.getState().openFile(memory.source!.path)}>
                      Source: {memory.source.path}{memory.source.startLine ? ` · lines ${memory.source.startLine}${memory.source.endLine && memory.source.endLine !== memory.source.startLine ? `–${memory.source.endLine}` : ''}` : ''}
                    </button>
                    {memory.source.heading && <span> · {memory.source.heading}</span>}
                    {memory.sourceReferenceStale && <span className="ml-2 text-[var(--accent-brown)]">Source changed</span>}
                  </div>}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-[var(--text-muted)]">Related files:</span>
                    {memory.mentions.map(mention => <button key={mention.path} disabled={editingMentions === memory.memoryId} className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text)]" onClick={() => void updateMentions(memory, memory.mentions.filter(item => item.path !== mention.path).map(item => item.path))} title={`Remove @${mention.path}`}>@{mention.path} ×</button>)}
                    <select aria-label="Add related file" disabled={editingMentions === memory.memoryId} value="" onChange={event => { if (event.target.value) void updateMentions(memory, [...memory.mentions.map(item => item.path), event.target.value]) }}>
                      <option value="">+ Add file</option>
                      {files.filter(file => !memory.mentions.some(mention => mention.path === file.path)).map(file => <option key={file.path} value={file.path}>@{file.path}</option>)}
                    </select>
                  </div>
                </div>
                {!memory.archived && <button onClick={() => void archive(memory.memoryId)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-heading)]" aria-label="Archive memory"><Archive size={15} /></button>}
              </div>
            ))}
          </SectionCard>
        </section>
      </FilterSection>
    </div>
  )
}
