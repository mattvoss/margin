import { useState, useEffect } from 'react'
import { Pencil, Loader, X, List } from 'lucide-react'
import type { AppSettings } from '../../stores/settingsStore'
import { API_BASE, apiFetch } from '../../lib/api'
import { HarnessIcon } from '../HarnessIcon'
import { SearchableSelect } from '../ui/themed-select'
import { FilterSection, SectionLabel } from './shared'

// Harnesses driven over an API or embedded in-process instead of a spawned
// CLI: margin talks to the OpenCode service and runs Pi through its SDK, so
// neither has a program to point at.
const SERVICE_HARNESSES = new Set(['opencode', 'pi'])

// Sign-in guidance per service-backed harness. Each one authenticates in its
// own terminal — margin never sees or stores those credentials.
const SERVICE_HINTS: Record<string, { ready: string; missing: string; missingShort: string }> = {
  opencode: {
    ready: 'Margin talks to your OpenCode service. Sign in with the `opencode` CLI in your own terminal.',
    missing: '✕ No OpenCode service found — install and sign in to the `opencode` CLI, or run `opencode serve`, then reopen Settings.',
    missingShort: '✕ No service found — install and sign in to the `opencode` CLI, or run `opencode serve`, then reopen Settings',
  },
  pi: {
    ready: 'Margin runs Pi in-process. Sign in with the `pi` CLI in your own terminal.',
    missing: '✕ No usable Pi model found — install and sign in to the `pi` CLI in your own terminal, then reopen Settings.',
    missingShort: '✕ No usable Pi model — install and sign in to the `pi` CLI in your own terminal, then reopen Settings',
  },
}

const CLI_AUTH_READY = 'Authenticate its CLI in your own terminal.'
const CLI_AUTH_MISSING = '✕ Not installed — install and authenticate its CLI, then reopen Settings.'

function HarnessConfigDialog({
  harness,
  initial,
  onSave,
  onClose,
}: {
  harness: { id: string; name: string; installed: boolean }
  initial: { executable: string; model: string; context_window?: number }
  onSave: (config: { executable?: string; model: string; context_window?: number }) => void
  onClose: () => void
}) {
  const [executable, setExecutable] = useState(initial.executable)
  const [model, setModel] = useState(initial.model)
  const [context, setContext] = useState(initial.context_window ? String(initial.context_window) : '')
  const isService = SERVICE_HARNESSES.has(harness.id)
  const hint = SERVICE_HINTS[harness.id]
  const statusText = isService
    ? harness.installed
      ? hint?.ready ?? CLI_AUTH_READY
      : hint?.missing ?? CLI_AUTH_MISSING
    : harness.installed
      ? CLI_AUTH_READY
      : CLI_AUTH_MISSING

  const handleSave = () => {
    onSave(isService
      ? { model, context_window: parseInt(context) || undefined }
      : { executable, model, context_window: parseInt(context) || undefined })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/15 dark:bg-black/45 backdrop-blur-[2px] z-[200] flex items-center justify-center p-4 animate-scale-in">
      <div className="bg-[var(--bg)] border border-[var(--border-subtle)] w-full max-w-lg rounded-[16px] shadow-none p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-[16px] font-medium text-[var(--text-heading)] flex items-center gap-2">
            <HarnessIcon id={harness.id} className="w-4 h-4" />
            {harness.name}
          </h3>
          <button onClick={onClose} className="flex items-center justify-center w-8 h-8 text-[var(--text-muted)] hover:text-[var(--text-heading)] transition-colors cursor-pointer">
            <X size={15} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--text-secondary)] -mt-2">
          {statusText}
        </p>
        <div className="flex flex-col gap-3">
          {!isService && (
            <input
              type="text"
              placeholder={`Executable (e.g. /opt/homebrew/bin/${harness.id})`}
              value={executable}
              onChange={(e) => setExecutable(e.target.value)}
              className="w-full h-9 border border-[var(--border-subtle)] rounded-[4px] px-3 py-2 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)] font-mono"
            />
          )}
          <div className="flex gap-2 min-w-0">
            <HarnessModelPicker
              key={`${harness.id}:${executable}`}
              harnessId={harness.id}
              value={model}
              onChange={setModel}
            />
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Context"
              value={context}
              onChange={(e) => setContext(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-[110px] h-9 border border-[var(--border-subtle)] rounded-[4px] px-3 py-2 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)] font-mono shrink-0"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)]/50 pt-3">
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-[12px] bg-[var(--accent-brown)] text-[var(--text-inverse)] rounded-[8px] hover:bg-[var(--accent-brown-hover)] transition-colors cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export function HarnessesSettings({ settings, updateSettings, query }: { settings: AppSettings, updateSettings: (u: Partial<AppSettings>) => void, query: string }) {
  const [discovered, setDiscovered] = useState<{ id: string; name: string; installed: boolean; version: string | null }[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [configDialog, setConfigDialog] = useState<{ id: string; name: string; installed: boolean } | null>(null)

  useEffect(() => {
    apiFetch(`${API_BASE}/api/harnesses`)
      .then(res => res.ok ? res.json() : { harnesses: [] })
      .then(data => setDiscovered(data.harnesses || []))
      .catch(err => console.error(err))
      .finally(() => setIsLoading(false))
  }, [])

  // executable is optional: in-process harnesses (OpenCode, Pi) have none, and
  // omitting the key leaves any previously saved value untouched.
  const handleSaveConfig = (id: string, config: { executable?: string; model: string; context_window?: number }) => {
    updateSettings({ harnesses: { ...(settings.harnesses || {}), [id]: { ...(settings.harnesses?.[id] || {}), ...config } } })
  }

  return (
    <div className="flex flex-col gap-6">
      <FilterSection query={query} keywords="harness agent terminal executable model context">
        <section>
          <SectionLabel description="External agent runtimes (OpenCode, Pi, Claude Code, Codex, ...) run locally with your own subscription. Configure each one here; pick the active harness or endpoint from the assistant panel. Authenticate each in your own terminal.">Agent harness</SectionLabel>

          <div className="flex flex-col gap-2">
          {isLoading && (
            <p className="flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)] p-2">
              <Loader size={14} className="animate-spin" />
              Detecting installed harnesses...
            </p>
          )}

          {discovered.map(h => (
            <div key={h.id} className="relative border rounded-[12px] transition-colors group border-[var(--border-subtle)] hover:border-[var(--text-secondary)]">
              <div className="flex items-center gap-3 p-3">
                <div className="flex flex-col min-w-0 flex-1 pr-6">
                  <span className="text-[13px] font-medium text-[var(--text-heading)] flex items-center gap-2">
                    <HarnessIcon id={h.id} className="w-4 h-4" />
                    {h.name}
                  </span>
                  {/* pl-6 = icon (w-4/16px) + gap-2 (8px): status starts
                      exactly below the first letter of the harness name. */}
                  <span className="text-[11px] text-[var(--text-secondary)] pl-6">
                    {h.installed
                      ? `Ready${h.version ? ` · ${h.version}` : ''}`
                      : SERVICE_HARNESSES.has(h.id)
                        ? (SERVICE_HINTS[h.id]?.missingShort ?? '✕ Not available — install and authenticate it in your own terminal, then reopen Settings')
                        : '✕ Not installed — install and authenticate its CLI, then reopen Settings, or point Configure at its location'}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setConfigDialog({ id: h.id, name: h.name, installed: h.installed })}
                title={`Configure ${h.name}`}
                className="absolute top-1/2 -translate-y-1/2 right-2.5 flex items-center justify-center w-6 h-6 text-[var(--text-secondary)]/60 hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] rounded-[4px] transition-all cursor-pointer opacity-0 group-hover:opacity-100"
              >
                <Pencil className="w-3 h-3" strokeWidth={2} />
              </button>
            </div>
          ))}
          </div>
        </section>
      </FilterSection>
      {configDialog && (
        <HarnessConfigDialog
          harness={configDialog}
          initial={{
            executable: settings.harnesses?.[configDialog.id]?.executable || '',
            model: settings.harnesses?.[configDialog.id]?.model || '',
            context_window: settings.harnesses?.[configDialog.id]?.context_window,
          }}
          onSave={(config) => handleSaveConfig(configDialog.id, config)}
          onClose={() => setConfigDialog(null)}
        />
      )}
    </div>
  )
}

function HarnessModelPicker({ harnessId, value, onChange }: { harnessId: string; value: string; onChange: (model: string) => void }) {
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [manual, setManual] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [customMode, setCustomMode] = useState(false)

  useEffect(() => {
    apiFetch(`${API_BASE}/api/harnesses/${harnessId}/models`)
      .then(res => res.ok ? res.json() : { models: [], manual: true })
      .then(data => {
        setModels(data.models || [])
        setManual(data.manual !== false || (data.models || []).length === 0)
        if (value && !(data.models || []).some((m: { id: string }) => m.id === value)) {
          setCustomMode(true)
        }
      })
      .catch(err => console.error(err))
      .finally(() => setIsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessId])

  if (isLoading) {
    return <span className="flex-1 min-w-0 h-[26px] rounded-[4px] bg-[var(--bg-hover)] animate-pulse" aria-label="Loading models..." />
  }

  if (manual || models.length === 0 || customMode) {
    if (!manual && models.length > 0 && customMode) {
      return (
        <div className="flex-1 min-w-0 flex items-center gap-0.5">
          <input
            type="text"
            placeholder="e.g. anthropic/claude-sonnet-4-5 (empty = harness default)"
            value={value}
            onChange={(e) => { setCustomMode(true); onChange(e.target.value) }}
            className="flex-1 min-w-0 h-9 border border-[var(--border-subtle)] rounded-[4px] px-3 py-2 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)] font-mono"
          />
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            title="Choose from list"
            className="flex items-center justify-center w-6 h-6 text-[var(--text-secondary)]/60 hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] rounded-[4px] transition-all cursor-pointer shrink-0"
          >
            <List size={13} />
          </button>
        </div>
      )
    }
    return (
      <input
        type="text"
        placeholder="e.g. anthropic/claude-sonnet-4-5 (empty = harness default)"
        value={value}
        onChange={(e) => { setCustomMode(true); onChange(e.target.value) }}
        className="flex-1 min-w-0 border border-[var(--border-subtle)] rounded-[4px] px-2.5 py-1 text-[11px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)] font-mono"
      />
    )
  }

  return (
    <SearchableSelect
      value={value}
      onChange={(v) => {
        if (v === '__custom__') {
          setCustomMode(true)
        } else {
          onChange(v)
        }
      }}
      options={[
        { value: '', label: 'Harness default' },
        ...models.map(m => ({
          value: m.id,
          label: m.id,
        })),
        { value: '__custom__', label: 'Custom...' },
      ]}
      className="flex-1 min-w-0 font-mono"
      searchPlaceholder="Search models..."
    />
  )
}
