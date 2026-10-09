import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../../stores/editorStore'
import { useImageGenStore } from '../../stores/imageGenStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { toast } from '../../stores/toastStore'
import { generateImage, insertStoredImageAt } from '../../lib/media'
import { imageStyleOptions } from './imageStyleOptions'
import { SearchableSelect } from '../ui/themed-select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

export function ImageGenerateDialogHost() {
  const dialog = useImageGenStore((s) => s.dialog)
  if (!dialog) return null
  return <ImageGenerateDialog key={dialog.anchorPos ?? 0} />
}

// Slash-entry dialog for fresh images only (empty start, required prompt).
// Imagine from a text selection uses the bubble's inline morph instead,
// and Imagine again uses the image pill's input bar — both require typed
// content, so this dialog never deals with references.
function ImageGenerateDialog() {
  const dialog = useImageGenStore((s) => s.dialog)
  const closeDialog = useImageGenStore((s) => s.closeDialog)
  const settings = useSettingsStore((s) => s.settings)
  const setShowSettings = useSettingsStore((s) => s.setShowSettings)

  const [prompt, setPrompt] = useState(dialog?.initialPrompt ?? '')
  const options = useMemo(
    () => imageStyleOptions(settings?.image_custom_styles, settings?.image_deleted_styles),
    [settings?.image_custom_styles, settings?.image_deleted_styles],
  )
  const defaultStyle = settings?.image_default_style ?? 'None'
  const [styleName, setStyleName] = useState(
    defaultStyle && options.some((o) => o.toLowerCase() === String(defaultStyle).toLowerCase())
      ? options.find((o) => o.toLowerCase() === String(defaultStyle).toLowerCase())!
      : 'None',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const cancelledRef = useRef(false)
  // Captured once per mount (the host remounts per dialog via `key`) so a
  // mid-generation file switch drops the insert instead of landing the
  // image in the wrong document.
  const fileAtStartRef = useRef<string | null>(useEditorStore.getState().currentFilePath)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  if (!dialog) return null
  const canSubmit = !busy && prompt.trim().length > 0

  const handleCancel = () => {
    if (busy) {
      cancelledRef.current = true
      abortRef.current?.abort()
    }
    closeDialog()
  }

  const handleGenerate = async () => {
    const editor = useEditorStore.getState().editor
    if (!editor || editor.isDestroyed || busy) return
    // Empty never submits — the button is disabled, so this is a guard.
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    cancelledRef.current = false
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const { path } = await generateImage({
        prompt: prompt.trim(),
        styleName: styleName === 'None' ? null : styleName,
        referencePath: null,
        signal: ctrl.signal,
      })
      if (cancelledRef.current || ctrl.signal.aborted) return
      if (editor.isDestroyed) return
      if (useEditorStore.getState().currentFilePath !== fileAtStartRef.current) {
        console.warn('Margin: image target file changed mid-generation — dropping image')
        return
      }
      const anchor = dialog.anchorPos ?? editor.state.selection.to
      // Fixed alt: deriving it from the prompt sliced raw text (mid-word
      // cuts, newlines, Markdown-significant chars) into the image markup.
      insertStoredImageAt(editor, anchor, path, 'generated image')
      // Runs are recorded server-side (prompt, seed, asset) and viewable in
      // Settings → Images → Recent generations — the dialog stays minimal.
      closeDialog()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      const msg = err instanceof Error ? err.message : 'Image generation failed'
      setError(msg)
      toast.error(msg)
    } finally {
      if (!cancelledRef.current) setBusy(false)
      abortRef.current = null
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) closeDialog() }}>
      <DialogContent className="max-w-md bg-[var(--bg-elevated)] border-[var(--border-subtle)] p-5 sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle className="text-[14px] font-medium text-[var(--text-heading)]">
            Imagine
          </DialogTitle>
        </DialogHeader>
        <Label className="mt-1 block text-[12px] font-medium text-[var(--text-secondary)]">
          Describe the image you want
        </Label>
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleGenerate()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              handleCancel()
            }
            e.stopPropagation()
          }}
          rows={4}
          placeholder="A cozy cabin in a snowy forest…"
          disabled={busy}
          className="mt-1.5 bg-[var(--bg-input)] border-[var(--border-subtle)] text-[13px]"
        />
        <Label className="mt-3 block text-[12px] font-medium text-[var(--text-secondary)]">Look</Label>
        <SearchableSelect
          value={styleName}
          onChange={setStyleName}
          disabled={busy}
          options={options.map((n) => ({ value: n, label: n }))}
          className="mt-1.5"
          searchPlaceholder="Search looks..."
        />
        <Button
          type="button"
          variant="link"
          onClick={() => {
            if (!busy) closeDialog()
            setShowSettings(true)
          }}
          className="mt-1.5 h-auto p-0 text-[11px] text-[var(--text-muted)] justify-start"
        >
          Manage looks in Settings
        </Button>
        {error && (
          <p className="mt-3 text-[12px] leading-relaxed text-red-500">{error}</p>
        )}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!canSubmit}
            className="bg-[var(--accent-brown)] text-[var(--text-inverse)] hover:bg-[var(--accent-brown-hover)]"
          >
            {busy ? 'Imagining…' : 'Imagine ✦'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
