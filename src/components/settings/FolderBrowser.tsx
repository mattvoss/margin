import { useEffect, useState } from 'react'
import { ChevronUp, Folder, X } from 'lucide-react'
import { API_BASE, apiFetch } from '../../lib/api'

type FolderEntry = { name: string; path: string }

type BrowseResult = {
  path: string
  parent: string | null
  cwd: string
  folders: FolderEntry[]
}

const primaryBtn =
  'shrink-0 px-3 py-1.5 rounded-[8px] text-[12px] bg-[var(--accent-brown)] text-[var(--text-inverse)] hover:bg-[var(--accent-brown-hover)] transition-colors font-medium cursor-pointer disabled:opacity-50 flex items-center gap-1.5'
const quietBtn =
  'shrink-0 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] transition-colors cursor-pointer'

/** Folder picker backed by `GET /api/workspace/browse` (JSON), not a native
 *  dialog. Opens at the application's cwd; `..` walks up to anywhere the
 *  process can read, minus the backend's sensitive-path prefixes. */
export function FolderBrowser({ title, onSelect, onClose }: {
  title: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  // The directory being listed; `null` means "the app cwd" and is sent as an
  // omitted query param. Every navigation just moves this, so the fetch lives
  // in one effect instead of being threaded through call sites.
  const [target, setTarget] = useState<string | null>(null)
  const [data, setData] = useState<BrowseResult | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const qs = target ? `?path=${encodeURIComponent(target)}` : ''
    apiFetch(`${API_BASE}/api/workspace/browse${qs}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.detail || 'Could not read this folder.')
        return body as BrowseResult
      })
      .then((body) => {
        if (cancelled) return
        setData(body)
        setCwd(body.cwd)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read this folder.')
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [target])

  // Re-requesting the directory already shown would resolve to a no-op state
  // update and strand the spinner, so skip it.
  const goTo = (next: string | null) => {
    if (next === target) return
    setLoading(true)
    setError(null)
    setTarget(next)
  }

  const atCwd = data !== null && cwd !== null && data.path === cwd

  return (
    <div className="fixed inset-0 bg-black/15 dark:bg-black/45 backdrop-blur-[2px] z-[200] flex items-center justify-center p-4 animate-scale-in">
      <div
        role="dialog"
        aria-label={title}
        className="bg-[var(--bg)] border border-[var(--border-subtle)] w-full max-w-lg rounded-[16px] shadow-none p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[16px] font-medium text-[var(--text-heading)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close folder browser"
            className="flex items-center justify-center w-8 h-8 text-[var(--text-muted)] hover:text-[var(--text-heading)] transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-[var(--text-muted)] font-mono truncate" title={data?.path ?? ''}>
            {data?.path ?? (loading ? 'Loading…' : '—')}
          </p>
          {cwd !== null && !atCwd && (
            <button
              type="button"
              onClick={() => goTo(cwd)}
              className="self-start text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] transition-colors cursor-pointer"
            >
              Back to app folder
            </button>
          )}
        </div>

        <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 max-h-[46vh] overflow-y-auto divide-y divide-[var(--border-subtle)]/60">
          {error && <p className="px-4 py-3 text-[12px] text-[var(--danger)]">{error}</p>}
          {loading && !error && (
            <p className="px-4 py-3 text-[12px] text-[var(--text-secondary)]">Loading…</p>
          )}
          {!loading && !error && data?.parent && (
            <button
              type="button"
              onClick={() => goTo(data.parent)}
              className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/40 transition-colors cursor-pointer"
            >
              <ChevronUp size={13} className="shrink-0" /> ..
            </button>
          )}
          {!loading && !error && data?.folders.map((folder) => (
            <button
              key={folder.path}
              type="button"
              onClick={() => goTo(folder.path)}
              className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-[13px] text-[var(--text-heading)] hover:bg-[var(--bg-hover)]/40 transition-colors cursor-pointer"
            >
              <Folder size={13} className="shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
          {!loading && !error && data && data.folders.length === 0 && !data.parent && (
            <p className="px-4 py-3 text-[12px] text-[var(--text-secondary)]">This folder has no subfolders.</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={quietBtn}>Cancel</button>
          <button
            type="button"
            disabled={!data || loading}
            onClick={() => data && onSelect(data.path)}
            className={primaryBtn}
          >
            <span>Select this folder</span>
          </button>
        </div>
      </div>
    </div>
  )
}