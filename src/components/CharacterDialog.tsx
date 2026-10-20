import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { confirmDialog } from '../stores/dialogStore'
import { useCharactersStore } from '../stores/charactersStore'
import { useEditorStore } from '../stores/editorStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  chapterDisplayName,
  resolveRescanTarget,
  workspaceStorageKey,
} from '../lib/chapters'
import {
  MAX_TRACKED_CHARACTERS,
  emptyAppearance,
  type CharacterAppearance,
  type CharacterDraft,
  type TrackedCharacter,
} from '../lib/characters'

interface Draft {
  name: string
  aliases: string
  active: boolean
  role: string
  summary: string
  clothes: string
  appearance: CharacterAppearance
  accessories: string
}

function emptyDraft(): Draft {
  return {
    name: '',
    aliases: '',
    active: true,
    role: '',
    summary: '',
    clothes: '',
    appearance: emptyAppearance(),
    accessories: '',
  }
}

function toDraft(character: TrackedCharacter): Draft {
  return {
    name: character.name,
    aliases: character.aliases.join(', '),
    active: character.active,
    role: character.role,
    summary: character.summary,
    clothes: character.clothes,
    appearance: { ...character.appearance },
    accessories: character.accessories,
  }
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 py-1.5 text-[12px] text-[var(--text)] outline-none transition-colors focus:border-[var(--text-secondary)]"
      />
    </label>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 2,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="w-full resize-y rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 py-1.5 text-[12px] leading-relaxed text-[var(--text)] outline-none transition-colors focus:border-[var(--text-secondary)]"
      />
    </label>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex min-w-0 gap-1.5">
      <span className="shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 text-[var(--text-secondary)]">{value}</span>
    </div>
  )
}

function CharacterCard({
  character,
  disabled,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  character: TrackedCharacter
  disabled: boolean
  onEdit: () => void
  onDelete: () => void
  onToggleActive: () => void
}) {
  const appearance = character.appearance
  return (
    <div
      className={`rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2.5 transition-opacity ${
        character.active ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            character.active ? 'bg-emerald-500' : 'bg-[var(--text-muted)]'
          }`}
          title={character.active ? 'Active in the story' : 'Inactive'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-[var(--text-heading)]">
              {character.name}
            </span>
            {character.role && (
              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
                {character.role}
              </span>
            )}
            {!character.active && (
              <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
                Inactive
              </span>
            )}
          </div>
          {character.aliases.length > 0 && (
            <p className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
              {character.aliases.join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            size="sm"
            checked={character.active}
            disabled={disabled}
            onCheckedChange={onToggleActive}
            aria-label={character.active ? 'Mark inactive' : 'Mark active'}
            title={character.active ? 'Active in the story' : 'Inactive'}
          />
          <button
            type="button"
            onClick={onEdit}
            disabled={disabled}
            title={`Edit ${character.name}`}
            className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-heading)] disabled:opacity-40"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            title={`Delete ${character.name}`}
            className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {(character.summary || character.clothes || character.accessories) && (
        <div className="mt-2 space-y-1 pl-4 text-[11px] leading-relaxed">
          {character.summary && (
            <p className="text-[var(--text-secondary)]">{character.summary}</p>
          )}
          <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
            <Info label="Clothes" value={character.clothes} />
            <Info label="Accessories" value={character.accessories} />
          </div>
        </div>
      )}

      {(appearance.hair ||
        appearance.eyes ||
        appearance.face ||
        appearance.height ||
        appearance.build ||
        appearance.skin) && (
        <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 pl-4 text-[11px] sm:grid-cols-2">
          <Info label="Hair" value={appearance.hair} />
          <Info label="Eyes" value={appearance.eyes} />
          <Info label="Face" value={appearance.face} />
          <Info label="Height" value={appearance.height} />
          <Info label="Build" value={appearance.build} />
          <Info label="Skin" value={appearance.skin} />
        </div>
      )}
    </div>
  )
}

export function CharacterDialog() {
  const open = useCharactersStore((s) => s.dialogOpen)
  const setDialogOpen = useCharactersStore((s) => s.setDialogOpen)
  const characterState = useCharactersStore((s) => s.state)
  const lastChapterByWorkspace = useCharactersStore((s) => s.lastChapterByWorkspace)
  const loading = useCharactersStore((s) => s.loading)
  const tracking = useCharactersStore((s) => s.tracking)
  const saving = useCharactersStore((s) => s.saving)
  const error = useCharactersStore((s) => s.error)
  const editing = useCharactersStore((s) => s.editing)
  const stale = useCharactersStore((s) => s.stale)
  const fetchState = useCharactersStore((s) => s.fetchState)
  const rescanLastChapter = useCharactersStore((s) => s.rescanLastChapter)
  const setEditing = useCharactersStore((s) => s.setEditing)
  const updateCharacter = useCharactersStore((s) => s.updateCharacter)
  const createCharacter = useCharactersStore((s) => s.createCharacter)
  const deleteCharacter = useCharactersStore((s) => s.deleteCharacter)
  const clearError = useCharactersStore((s) => s.clearError)

  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const currentFilePath = useEditorStore((s) => s.currentFilePath)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => {
    // Read once per open. If an extraction is already in flight, its response
    // will supply the fresh state; a competing GET could overwrite it.
    if (open && !useCharactersStore.getState().tracking) void fetchState()
  }, [open, fetchState])

  const workspaceDir = settings.linked_workspace_dir ?? null
  const lastChapter = lastChapterByWorkspace[workspaceStorageKey(workspaceDir)]
  const target = resolveRescanTarget(
    lastChapter?.path,
    currentFilePath,
    characterState?.source_path,
  )
  const targetName = target
    ? lastChapter?.path === target
      ? lastChapter.name
      : chapterDisplayName(target)
    : ''

  const characters = useMemo(
    () => characterState?.characters ?? [],
    [characterState],
  )
  const activeCharacters = useMemo(
    () => characters.filter((character) => character.active),
    [characters],
  )
  const inactiveCharacters = useMemo(
    () => characters.filter((character) => !character.active),
    [characters],
  )

  const cancelEdit = () => {
    setDraft(null)
    setEditingId(null)
    setIsNew(false)
    setFormError(null)
    setEditing(false)
  }

  const startAdd = () => {
    if (characters.length >= MAX_TRACKED_CHARACTERS) return
    setDraft(emptyDraft())
    setEditingId(null)
    setIsNew(true)
    setFormError(null)
    setEditing(true)
  }

  const startEdit = (character: TrackedCharacter) => {
    setDraft(toDraft(character))
    setEditingId(character.id)
    setIsNew(false)
    setFormError(null)
    setEditing(true)
  }

  const patchDraft = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const patchAppearance = (key: keyof CharacterAppearance, value: string) => {
    setDraft((current) =>
      current
        ? { ...current, appearance: { ...current.appearance, [key]: value } }
        : current,
    )
  }

  const save = async () => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setFormError('Name is required.')
      return
    }
    setFormError(null)

    const payload: CharacterDraft = {
      name,
      aliases: draft.aliases
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean),
      active: draft.active,
      role: draft.role,
      summary: draft.summary,
      clothes: draft.clothes,
      appearance: { ...draft.appearance },
      accessories: draft.accessories,
    }

    try {
      if (isNew) {
        await createCharacter(payload)
      } else if (editingId) {
        await updateCharacter(editingId, payload)
      }
      cancelEdit()
    } catch {
      // The store surfaces the server message in the error banner.
    }
  }

  const remove = async (character: TrackedCharacter) => {
    const ok = await confirmDialog({
      title: `Delete ${character.name}?`,
      description: 'This removes them from the active cast list. It does not edit the manuscript.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteCharacter(character.id)
      if (editingId === character.id) cancelEdit()
    } catch {
      // The store surfaces the server message in the error banner.
    }
  }

  const toggleActive = (character: TrackedCharacter) => {
    void updateCharacter(character.id, { active: !character.active }).catch(() => undefined)
  }

  const busy = tracking || saving

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelEdit()
        setDialogOpen(next)
      }}
    >
      <DialogContent
        className="max-h-[86vh] max-w-[calc(100%-2rem)] overflow-y-auto border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 sm:max-w-[820px]"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px] text-[var(--text-heading)]">
            <Users size={16} className="text-[var(--text-secondary)]" />
            Active characters
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            The cast that is still part of the story. Absence from a scene is not an exit;
            inactive characters stay here until you delete them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">
            {activeCharacters.length} active
            {inactiveCharacters.length > 0
              ? ` · ${inactiveCharacters.length} inactive`
              : ''}
          </span>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <Switch
              size="sm"
              checked={settings.character_tracking !== false}
              onCheckedChange={(checked) =>
                updateSettings({ character_tracking: checked })
              }
              aria-label="Track characters automatically"
            />
            Auto-track
          </label>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void rescanLastChapter()}
            disabled={busy || !target || editing}
            title={
              editing
                ? 'Finish or cancel the current edit first'
                : target
                  ? `Rescan ${targetName}`
                  : 'Open a chapter first, then rescan the last-focused chapter'
            }
          >
            {tracking ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Rescan{targetName ? ` ${targetName}` : ''}
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={startAdd}
            disabled={busy || editing || characters.length >= MAX_TRACKED_CHARACTERS}
            title={
              characters.length >= MAX_TRACKED_CHARACTERS
                ? `The cast is limited to ${MAX_TRACKED_CHARACTERS} characters`
                : 'Add a character manually'
            }
          >
            <Plus size={12} />
            Add
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-[8px] border border-red-500/25 bg-red-500/5 px-2.5 py-2 text-[11px] text-red-500">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 rounded p-0.5 hover:bg-red-500/10"
              title="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {stale && (
          <div className="rounded-[8px] border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-600">
            New text finished while you were editing. Rescan when you are done to catch
            any changes.
          </div>
        )}

        {loading && !characterState && (
          <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            Loading characters…
          </div>
        )}

        {!loading && !characterState && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Users size={22} className="text-[var(--text-muted)]" />
            <p className="text-[12px] text-[var(--text-secondary)]">
              No cast list yet.
            </p>
            <p className="max-w-[420px] text-[11px] text-[var(--text-muted)]">
              Run a generation with auto-track on, rescan a chapter, or add someone
              manually.
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void fetchState()}
            >
              <RefreshCw size={12} />
              Retry
            </Button>
          </div>
        )}

        {draft && editing && (
          <div className="rounded-[10px] border border-[var(--accent-brown)]/30 bg-[var(--bg-hover)]/35 p-3">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <Field
                label="Name"
                value={draft.name}
                onChange={(name) => patchDraft({ name })}
                placeholder="Required"
              />
              <Field
                label="Aliases"
                value={draft.aliases}
                onChange={(aliases) => patchDraft({ aliases })}
                placeholder="Comma separated"
              />
              <Field
                label="Role"
                value={draft.role}
                onChange={(role) => patchDraft({ role })}
                placeholder="Protagonist, antagonist, supporting…"
              />
              <label className="flex items-center gap-2 pt-5 text-[11px] text-[var(--text-secondary)]">
                <Switch
                  size="sm"
                  checked={draft.active}
                  onCheckedChange={(active) => patchDraft({ active })}
                  aria-label="Active in story"
                />
                Active in the story
              </label>
              <TextAreaField
                label="Summary"
                value={draft.summary}
                onChange={(summary) => patchDraft({ summary })}
                className="sm:col-span-2"
              />
              <TextAreaField
                label="Clothes"
                value={draft.clothes}
                onChange={(clothes) => patchDraft({ clothes })}
                className="sm:col-span-2"
              />
              <Field
                label="Hair"
                value={draft.appearance.hair}
                onChange={(value) => patchAppearance('hair', value)}
              />
              <Field
                label="Eyes"
                value={draft.appearance.eyes}
                onChange={(value) => patchAppearance('eyes', value)}
              />
              <Field
                label="Face"
                value={draft.appearance.face}
                onChange={(value) => patchAppearance('face', value)}
              />
              <Field
                label="Height"
                value={draft.appearance.height}
                onChange={(value) => patchAppearance('height', value)}
              />
              <Field
                label="Build"
                value={draft.appearance.build}
                onChange={(value) => patchAppearance('build', value)}
              />
              <Field
                label="Skin"
                value={draft.appearance.skin}
                onChange={(value) => patchAppearance('skin', value)}
              />
              <TextAreaField
                label="Accessories"
                value={draft.accessories}
                onChange={(accessories) => patchDraft({ accessories })}
                className="sm:col-span-2"
              />
            </div>

            {formError && (
              <p className="mt-2 text-[11px] text-red-500">{formError}</p>
            )}

            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={cancelEdit}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" size="xs" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : null}
                {isNew ? 'Add character' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}

        {characterState && characters.length === 0 && !draft && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Users size={22} className="text-[var(--text-muted)]" />
            <p className="text-[12px] text-[var(--text-secondary)]">
              The cast list is empty.
            </p>
            <p className="max-w-[420px] text-[11px] text-[var(--text-muted)]">
              Auto-track records characters after a generation. You can also rescan the
              last-focused chapter or add someone manually.
            </p>
          </div>
        )}

        {activeCharacters.length > 0 && (
          <div className="space-y-2">
            {activeCharacters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                disabled={busy || editing}
                onEdit={() => startEdit(character)}
                onDelete={() => void remove(character)}
                onToggleActive={() => toggleActive(character)}
              />
            ))}
          </div>
        )}

        {inactiveCharacters.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowInactive((value) => !value)}
              className="flex w-full items-center gap-1 rounded-md py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              {showInactive ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Inactive ({inactiveCharacters.length})
            </button>
            {showInactive &&
              inactiveCharacters.map((character) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  disabled={busy || editing}
                  onEdit={() => startEdit(character)}
                  onDelete={() => void remove(character)}
                  onToggleActive={() => toggleActive(character)}
                />
              ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-1 border-t border-[var(--border-subtle)] pt-2 text-[10px] text-[var(--text-muted)]">
          <span>
            {characterState?.source_path
              ? `Last scanned: ${characterState.source_path}`
              : 'No chapter scanned yet.'}
          </span>
          {lastChapter?.path && (
            <span>
              Last focused: {lastChapter.name}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
