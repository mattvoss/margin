import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { AppSettings } from '../../stores/settingsStore'
import { API_BASE, apiFetch } from '../../lib/api'
import {
  AGENT_DEFINITIONS,
  agentSettingsFor,
  type AgentMode,
  type AgentSettings,
  type ThinkingLevel,
} from '../../lib/agents'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionLabel, SectionCard, Toggle } from './shared'
import { toast } from '../../stores/toastStore'

const MODES: Array<{ id: AgentMode; label: string }> = [
  { id: 'write', label: 'Write' },
  { id: 'edit', label: 'Edit' },
  { id: 'chat', label: 'Chat' },
]

export function AgentsSettings({
  settings,
  updateSettings,
}: {
  settings: AppSettings
  updateSettings: (u: Partial<AppSettings>) => void
}) {
  const [mode, setMode] = useState<AgentMode>('write')
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const definitions = useMemo(
    () => AGENT_DEFINITIONS.filter((definition) => definition.mode === mode),
    [mode],
  )

  const updateAgent = (agentMode: AgentMode, id: string, patch: Partial<AgentSettings>) => {
    const current = settings.agents ?? {}
    const nextMode = { ...(current[agentMode] ?? {}), [id]: { ...agentSettingsFor(settings, agentMode, id), ...patch } }
    updateSettings({ agents: { ...current, [agentMode]: nextMode } })
  }

  const enabledCount = (agentMode: AgentMode) => AGENT_DEFINITIONS
    .filter((definition) => definition.mode === agentMode)
    .filter((definition) => agentSettingsFor(settings, agentMode, definition.id).enabled).length

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionLabel description="Choose which agents run in each mode and configure their model behavior. Disabled agents are skipped and are never used as fallbacks.">
          Agents
        </SectionLabel>
        <Tabs value={mode} onValueChange={(value) => setMode(value as AgentMode)}>
          <TabsList variant="line" className="mb-3 w-full">
            {MODES.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="text-[12px]">
                {item.label} · {enabledCount(item.id)}/{AGENT_DEFINITIONS.filter((d) => d.mode === item.id).length}
              </TabsTrigger>
            ))}
          </TabsList>
          {MODES.map((item) => (
            <TabsContent key={item.id} value={item.id} className="mt-0">
              {definitions.length === 0 ? (
                <p className="rounded-[10px] border border-[var(--border-subtle)] p-4 text-[12px] text-[var(--text-secondary)]">No agents are configured for this mode.</p>
              ) : (
                <SectionCard>
                  {definitions.map((definition) => {
                    const agent = agentSettingsFor(settings, item.id, definition.id)
                    return (
                      <AgentRow
                        key={definition.id}
                        definition={definition}
                        settings={agent}
                        open={!!open[`${item.id}:${definition.id}`]}
                        onOpenChange={(next) => setOpen((previous) => ({ ...previous, [`${item.id}:${definition.id}`]: next }))}
                        onChange={(patch) => updateAgent(item.id, definition.id, patch)}
                      />
                    )
                  })}
                </SectionCard>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </div>
  )
}

function AgentRow({ definition, settings, open, onOpenChange, onChange }: {
  definition: (typeof AGENT_DEFINITIONS)[number]
  settings: AgentSettings
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (patch: Partial<AgentSettings>) => void
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className={`transition-colors ${settings.enabled ? '' : 'opacity-60'}`}>
        <div className="flex items-center gap-3 px-4 py-3">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--text-heading)]">{definition.label}</span>
              <span className="block text-[11px] text-[var(--text-secondary)]">{definition.description}</span>
            </span>
          </CollapsibleTrigger>
          <Toggle checked={settings.enabled} onChange={(enabled) => onChange({ enabled })} label={`Enable ${definition.label}`} />
        </div>
        <CollapsibleContent>
          <AgentConfiguration definition={definition} settings={settings} onChange={onChange} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function AgentConfiguration({ definition, settings, onChange }: {
  definition: (typeof AGENT_DEFINITIONS)[number]
  settings: AgentSettings
  onChange: (patch: Partial<AgentSettings>) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [savedPrompt, setSavedPrompt] = useState('')
  const [loadingPrompt, setLoadingPrompt] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)

  useEffect(() => {
    if (!definition.promptFile) return
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingPrompt(true)
    apiFetch(`${API_BASE}/api/assist/prompts/${encodeURIComponent(definition.promptFile)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${definition.promptFile}`)
        return response.json() as Promise<{ content?: string }>
      })
      .then((data) => {
        if (active) {
          setPrompt(data.content ?? '')
          setSavedPrompt(data.content ?? '')
        }
      })
      .catch((error) => toast.error((error as Error).message))
      .finally(() => { if (active) setLoadingPrompt(false) })
    return () => { active = false }
  }, [definition.promptFile])

  const savePrompt = async () => {
    if (!definition.promptFile || prompt === savedPrompt) return
    setSavingPrompt(true)
    try {
      const response = await apiFetch(`${API_BASE}/api/assist/prompts/${encodeURIComponent(definition.promptFile)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prompt }),
      })
      if (!response.ok) throw new Error('Prompt save failed')
      setSavedPrompt(prompt)
      toast.success('Prompt saved.')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSavingPrompt(false)
    }
  }

  return (
    <div className="border-t border-[var(--border-subtle)]/60 px-4 py-4">
      {definition.promptFile && (
        <div className="mb-4">
          <label className="mb-1 block text-[12px] font-medium text-[var(--text-heading)]">Prompt</label>
          {loadingPrompt ? <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" /> : (
            <>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-[150px] w-full resize-y rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-input)] p-2 text-[11px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--text-secondary)]" />
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => void savePrompt()} disabled={savingPrompt || prompt === savedPrompt} className="rounded-[7px] bg-[var(--accent-brown)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-inverse)] disabled:opacity-50">
                  {savingPrompt ? 'Saving…' : 'Save prompt'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[12px] text-[var(--text-secondary)]">Model<input value={settings.model ?? ''} onChange={(event) => onChange({ model: event.target.value || undefined })} placeholder="Active endpoint model" className="mt-1 w-full rounded-[7px] border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 py-1.5 text-[12px] text-[var(--text)]" /></label>
        <label className="text-[12px] text-[var(--text-secondary)]">Temperature <span className="text-[var(--text)]">{settings.temperature.toFixed(2)}</span><input type="range" min="0" max="2" step="0.05" value={settings.temperature} onChange={(event) => onChange({ temperature: Number(event.target.value) })} className="mt-2 w-full" /></label>
        <div className="flex items-center justify-between rounded-[7px] border border-[var(--border-subtle)] px-2 py-2 text-[12px] text-[var(--text-secondary)]"><span>Thinking enabled</span><Toggle checked={settings.thinking_enabled} onChange={(thinking_enabled) => onChange({ thinking_enabled })} label={`Enable thinking for ${definition.label}`} /></div>
        {settings.thinking_enabled && <label className="text-[12px] text-[var(--text-secondary)]">Thinking level<select value={settings.thinking_level} onChange={(event) => onChange({ thinking_level: event.target.value as ThinkingLevel })} className="mt-1 w-full rounded-[7px] border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 py-1.5 text-[12px] text-[var(--text)]"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>}
      </div>
    </div>
  )
}
