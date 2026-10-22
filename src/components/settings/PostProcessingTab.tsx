import { useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react'
import { useSettingsStore, type AppSettings } from '../../stores/settingsStore'
import {
  MAX_HARNESS_HUNKS,
  activePostProcessPreset,
  enabledPostProcessPasses,
  normalizePostProcessing,
  type PostProcessPass,
  type PostProcessingSettings,
  type PostProcessPreset,
} from '../../lib/postProcessing'
import { FilterSection, Row, SectionCard, SectionLabel, Toggle } from './shared'
import { ThemedSelect } from '../ui/themed-select'

export function PostProcessingSettings({
  settings,
  updateSettings,
  query,
}: {
  settings: AppSettings
  updateSettings: (updates: Partial<AppSettings>) => void
  query: string
}) {
  const config = normalizePostProcessing(settings.post_processing)
  const preset = activePostProcessPreset(config)
  const enabled = enabledPostProcessPasses(config)

  const save = (next: PostProcessingSettings) => {
    void updateSettings({ post_processing: next })
  }
  /**
   * Read the latest stored config before patching. A pass name/prompt draft
   * commits on blur immediately before a click, and React has not re-rendered
   * this component yet, so using the render-time `config` here would clobber
   * the just-committed field.
   */
  const patchConfig = (patch: Partial<PostProcessingSettings>) => {
    const latest = normalizePostProcessing(useSettingsStore.getState().settings.post_processing)
    save({ ...latest, ...patch })
  }
  const updatePreset = (updater: (p: PostProcessPreset) => PostProcessPreset) => {
    const latest = normalizePostProcessing(useSettingsStore.getState().settings.post_processing)
    const active = activePostProcessPreset(latest)
    save({
      ...latest,
      presets: latest.presets.map((p) => (p.id === active.id ? updater(p) : p)),
    })
  }
  const updatePass = (id: string, patch: Partial<PostProcessPass>) => {
    updatePreset((p) => ({
      ...p,
      passes: p.passes.map((pass) => (pass.id === id ? { ...pass, ...patch } : pass)),
    }))
  }
  const movePass = (index: number, delta: number) => {
    updatePreset((p) => {
      const target = index + delta
      if (target < 0 || target >= p.passes.length) return p
      const passes = [...p.passes]
      const [item] = passes.splice(index, 1)
      passes.splice(target, 0, item)
      return { ...p, passes }
    })
  }

  const enabledModes = [
    config.apply_to_edit ? 'Edit' : null,
    config.apply_to_chat ? 'Chat' : null,
    config.apply_to_harness ? 'Harness' : null,
  ].filter(Boolean) as string[]

  const endpointOptions = [
    { value: '', label: 'Active endpoint' },
    ...Object.entries(settings.endpoints || {}).map(([id, ep]) => ({
      value: id,
      label: `${id.replace(/_/g, ' ')}${ep.model ? ` · ${ep.model}` : ''}`,
    })),
  ]

  return (
    <div className="flex flex-col gap-6">
      <FilterSection query={query} keywords="post-processing post processing pipeline passes prose polish rewrite review">
        <section>
          <SectionLabel description="Ordered passes that rewrite Writer or Chat output before it reaches you. Each pass only sees the previous pass's text. Disabled by default.">
            Pipeline
          </SectionLabel>
          <SectionCard>
            <Row
              label="Enable post-processing"
              description="Runs after the configured Writer or Harness produces text. Four starter passes ship disabled."
              control={
                <Toggle
                  checked={config.enabled}
                  label="Enable post-processing"
                  onChange={(next) => patchConfig({ enabled: next })}
                />
              }
            />
            <Row
              label="Review before applying"
              description="Endpoint Edit output stays in the normal accept/reject review. Harness runs always keep their existing three-way merge review."
              control={
                <Toggle
                  checked={config.review}
                  label="Review before applying"
                  onChange={(next) => patchConfig({ review: next })}
                />
              }
            />
            <Row
              label="Minimum characters"
              description="Outputs shorter than this skip the pipeline. Keeps tiny insertions from spending calls."
              control={
                <input
                  type="number"
                  min="0"
                  max="100000"
                  value={config.min_chars}
                  onChange={(e) =>
                    patchConfig({
                      min_chars: Math.max(0, Math.min(100_000, parseInt(e.target.value) || 0)),
                    })
                  }
                  className="w-24 border border-[var(--border-subtle)] rounded-[8px] px-2 py-1.5 text-[13px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)]"
                />
              }
            />
            <Row
              label="Apply to Edit"
              description="Panel edits and inline inserts/replacements that use an endpoint."
              control={
                <Toggle
                  checked={config.apply_to_edit}
                  label="Apply to Edit"
                  onChange={(next) => patchConfig({ apply_to_edit: next })}
                />
              }
            />
            <Row
              label="Apply to Chat"
              description="Assistant chat replies. Off by default so questions are not rewritten."
              control={
                <Toggle
                  checked={config.apply_to_chat}
                  label="Apply to Chat"
                  onChange={(next) => patchConfig({ apply_to_chat: next })}
                />
              }
            />
            <Row
              label="Apply to Harness"
              description="Only paragraph hunks the harness changed in the active file. Other files are untouched in this version."
              control={
                <Toggle
                  checked={config.apply_to_harness}
                  label="Apply to Harness"
                  onChange={(next) => patchConfig({ apply_to_harness: next })}
                />
              }
            />
          </SectionCard>
        </section>
      </FilterSection>

      <FilterSection query={query} keywords="calls cost warning tokens budget">
        <div className="flex items-start gap-2 rounded-[10px] border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <p>
            {!config.enabled
              ? 'Post-processing is off. No extra calls are made.'
              : enabled.length === 0
                ? 'The pipeline is on, but every pass is disabled. No extra calls are made.'
                : `${enabled.length} active pass${enabled.length === 1 ? '' : 'es'} add ${enabled.length} call${enabled.length === 1 ? '' : 's'} per ${enabledModes.join('/') || 'generation'}.${config.apply_to_harness ? ` A harness run can add up to ${enabled.length * MAX_HARNESS_HUNKS} calls because up to ${MAX_HARNESS_HUNKS} changed hunks are processed.` : ''}`}
          </p>
        </div>
      </FilterSection>

      <FilterSection query={query} keywords="preset presets profile default">
        <section>
          <SectionLabel description="Passes live inside a preset. Margin ships with one Default preset; more presets arrive in a later version.">
            Preset
          </SectionLabel>
          <SectionCard>
            <Row
              label="Active preset"
              description="Switch which ordered pass list runs after generation."
              control={
                <ThemedSelect
                  value={preset.id}
                  onChange={(value) => patchConfig({ active_preset: value })}
                  options={config.presets.map((p) => ({ value: p.id, label: p.name }))}
                  className="w-[180px]"
                  disabled={config.presets.length <= 1}
                />
              }
            />
          </SectionCard>
        </section>
      </FilterSection>

      <FilterSection query={query} keywords="passes pass prompt grounding character prose repetition rhythm editor">
        <section>
          <SectionLabel description="Run in order. A pass receives the previous pass's output; it never sees your original instruction. Drag-free reordering uses the arrows.">
            Passes
          </SectionLabel>
          <div className="flex flex-col gap-3">
            {preset.passes.length === 0 ? (
              <p className="text-[12px] text-[var(--text-secondary)] px-1">
                No passes in this preset.
              </p>
            ) : (
              preset.passes.map((pass, index) => (
                <PassCard
                  key={`${preset.id}:${pass.id}`}
                  pass={pass}
                  index={index}
                  total={preset.passes.length}
                  endpointOptions={endpointOptions}
                  onChange={(patch) => updatePass(pass.id, patch)}
                  onMove={(delta) => movePass(index, delta)}
                />
              ))
            )}
          </div>
        </section>
      </FilterSection>
    </div>
  )
}

function PassCard({
  pass,
  index,
  total,
  endpointOptions,
  onChange,
  onMove,
}: {
  pass: PostProcessPass
  index: number
  total: number
  endpointOptions: Array<{ value: string; label: string }>
  onChange: (patch: Partial<PostProcessPass>) => void
  onMove: (delta: number) => void
}) {
  const [name, setName] = useState(pass.name)
  const [prompt, setPrompt] = useState(pass.prompt)

  const commitName = () => {
    const next = name.trim() || 'Untitled pass'
    if (next !== pass.name) onChange({ name: next })
    if (next !== name) setName(next)
  }
  const commitPrompt = () => {
    if (prompt.trim() && prompt !== pass.prompt) onChange({ prompt })
    if (!prompt.trim()) setPrompt(pass.prompt)
  }

  return (
    <div
      className={`rounded-[12px] border bg-[var(--bg-elevated)]/40 transition-colors ${
        pass.enabled ? 'border-[var(--accent-brown)]/40' : 'border-[var(--border-subtle)]'
      }`}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Toggle
          checked={pass.enabled}
          label={`Enable ${pass.name}`}
          onChange={(next) => onChange({ enabled: next })}
        />
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            spellCheck={false}
            aria-label="Pass name"
            className="w-full bg-transparent border-0 p-0 text-[13px] font-medium text-[var(--text-heading)] outline-none focus:ring-0"
          />
          <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5">
            Pass {index + 1} of {total} · {pass.endpoint_id ? pass.endpoint_id.replace(/_/g, ' ') : 'active endpoint'} · temp {pass.temperature}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move ${pass.name} up`}
            className="p-1.5 rounded-[6px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition-colors"
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={`Move ${pass.name} down`}
            className="p-1.5 rounded-[6px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition-colors"
          >
            <ArrowDown size={13} />
          </button>
        </div>
      </div>

      <div className="border-t border-[var(--border-subtle)]/70 px-3.5 py-3 flex flex-col gap-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
            Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={commitPrompt}
            spellCheck={false}
            rows={5}
            className="w-full border border-[var(--border-subtle)] rounded-[6px] p-2.5 text-[11.5px] text-[var(--text)] bg-transparent outline-none focus:border-[var(--text-secondary)] transition-colors resize-y font-mono leading-relaxed"
          />
          <p className="text-[10.5px] text-[var(--text-muted)] mt-1">
            The generated text arrives as <code className="font-mono">&lt;text_to_transform&gt;</code>. Ask for rewritten text only.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
              Endpoint
            </label>
            <ThemedSelect
              value={pass.endpoint_id ?? ''}
              onChange={(value) => onChange({ endpoint_id: value || null })}
              options={endpointOptions}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
              Scene turns
            </label>
            <input
              type="number"
              min="0"
              max="20"
              value={pass.context_length}
              onChange={(e) =>
                onChange({ context_length: Math.max(0, Math.min(20, parseInt(e.target.value) || 0)) })
              }
              className="w-full border border-[var(--border-subtle)] rounded-[8px] px-2 py-1.5 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)]"
            />
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
            Context
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ContextToggle
              label="Characters"
              checked={pass.include_character}
              onChange={(next) => onChange({ include_character: next })}
            />
            <ContextToggle
              label="Scene history"
              checked={pass.include_scene}
              onChange={(next) => onChange({ include_scene: next })}
            />
            <ContextToggle
              label="Pinned refs"
              checked={pass.include_pinned_refs}
              onChange={(next) => onChange({ include_pinned_refs: next })}
            />
            <ContextToggle
              label="Document window"
              checked={pass.include_document}
              onChange={(next) => onChange({ include_document: next })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
              Temperature
            </label>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={pass.temperature}
              onChange={(e) => {
                const value = Number(e.target.value)
                onChange({
                  temperature: Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 0.3,
                })
              }}
              className="w-full border border-[var(--border-subtle)] rounded-[8px] px-2 py-1.5 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)]"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1">
              Max tokens
            </label>
            <input
              type="number"
              min="0"
              max="32768"
              placeholder="Inherit Writer"
              value={pass.max_tokens ?? ''}
              onChange={(e) => {
                const raw = e.target.value
                onChange({
                  max_tokens: raw === '' ? null : Math.max(1, Math.min(32768, parseInt(raw) || 1)),
                })
              }}
              className="w-full border border-[var(--border-subtle)] rounded-[8px] px-2 py-1.5 text-[12px] bg-[var(--bg-input)] text-[var(--text)] outline-none focus:border-[var(--text-secondary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ContextToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)] cursor-pointer select-none">
      <Toggle checked={checked} label={label} onChange={onChange} />
      {label}
    </label>
  )
}
