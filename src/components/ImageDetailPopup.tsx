import { useState } from 'react'
import { API_BASE, apiFetch } from '../lib/api'
import { toDisplaySrc } from '../lib/media'
import { toast } from '../stores/toastStore'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface ImageLogEntry {
  id?: string
  timestamp?: string
  prompt?: string
  final_prompt?: string
  style?: string | null
  provider?: string
  reference_path?: string | null
  seed?: number | null
  path?: string
}

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] w-16 shrink-0 pt-0.5">{label}</span>
      <span className={`text-[11px] text-[var(--text-secondary)] break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

export function ImageDetailPopup({ log, onClose }: { log: ImageLogEntry; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [revealMsg, setRevealMsg] = useState<string | null>(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(log.final_prompt || log.prompt || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy image prompt:', err)
      toast.error('Could not copy to clipboard.')
    }
  }

  const handleReveal = async () => {
    setRevealMsg(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/images/reveal`, { method: 'POST' })
      if (!res.ok) {
        let detail = 'Could not open folder'
        try {
          const data = await res.json()
          if (data?.detail) detail = data.detail
        } catch { /* ignore */ }
        throw new Error(detail)
      }
    } catch (err) {
      setRevealMsg(err instanceof Error ? err.message : 'Could not open folder')
      setTimeout(() => setRevealMsg(null), 4000)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md max-h-[85vh] bg-[var(--bg-elevated)] border-[var(--border-subtle)] p-5 font-sans sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle className="text-[14px] font-medium text-[var(--text-heading)] truncate font-sans">
            {(log.prompt || log.final_prompt || 'Generated image').slice(0, 80)}
          </DialogTitle>
          <DialogDescription className="text-[11px] text-[var(--text-muted)]">
            {log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}
            {log.provider ? ` · ${log.provider}` : ''}
            {log.reference_path ? ' · imagined again' : ''}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh]">
          <div className="mt-1 flex gap-3 pr-3">
            {log.reference_path && (
              <div className="flex-1 min-w-0">
                <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Input</div>
                <img
                  src={toDisplaySrc(log.reference_path)}
                  alt="Reference"
                  className="w-full rounded-[6px] border border-[var(--border-subtle)] object-cover"
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Output</div>
              {log.path ? (
                <img
                  src={toDisplaySrc(log.path)}
                  alt=""
                  className="w-full rounded-[6px] border border-[var(--border-subtle)] object-cover"
                />
              ) : (
                <div className="w-full h-24 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-hover)]" />
              )}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Submitted prompt</div>
            <div className="text-[12px] text-[var(--text)] leading-relaxed whitespace-pre-wrap break-words max-h-[140px] overflow-y-auto">
              {log.final_prompt || log.prompt || '—'}
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {log.seed != null && <MetaRow label="Seed" value={String(log.seed)} mono />}
            {log.style ? <MetaRow label="Style" value={log.style} /> : null}
            {log.path ? <MetaRow label="Output" value={log.path} mono /> : null}
            {log.reference_path ? <MetaRow label="Input" value={log.reference_path} mono /> : null}
          </div>
        </ScrollArea>

        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReveal}>
            Open folder
          </Button>
          {revealMsg && <span className="text-[11px] text-red-500">{revealMsg}</span>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
