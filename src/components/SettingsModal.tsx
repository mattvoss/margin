import { useState, useEffect } from 'react'
import { X, Search, SlidersHorizontal, Folder, Palette, Image as ImageIcon, BookOpen, SquareTerminal } from 'lucide-react'
import { useSettingsStore, type SettingsTabId } from '../stores/settingsStore'
import { toast } from '../stores/toastStore'
import { API_BASE, apiFetch } from '../lib/api'
import { EndpointLogo } from './settings/shared'
import { matchesQuery } from './settings/query'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GeneralSettings } from './settings/GeneralTab'
import { WorkspacesSettings } from './settings/WorkspacesTab'
import { AppearanceSettings } from './settings/AppearanceTab'
import { ContextSettings } from './settings/ContextTab'
import { EndpointsSettings } from './settings/EndpointsTab'
import { HarnessesSettings } from './settings/HarnessTab'
import { ImagesSettings } from './settings/ImagineTab'
interface SettingsModalProps {
  onClose: () => void
}

const TABS: { id: SettingsTabId; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }>; title: string; keywords: string }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, title: 'General', keywords: 'general mode verbosity stats files tokens activity' },
  { id: 'workspaces', label: 'Workspaces', icon: Folder, title: 'Workspaces', keywords: 'workspace workspaces directory folder path link browse create git active saved switch recent' },
  { id: 'appearance', label: 'Appearance', icon: Palette, title: 'Appearance', keywords: 'appearance theme light dark system color font text style stats palette' },
  { id: 'images', label: 'Imagine', icon: ImageIcon, title: 'Imagine', keywords: 'images image imagine provider comfyui comfy styles style model key' },
  { id: 'context', label: 'Context', icon: BookOpen, title: 'Context', keywords: 'context agent prompt prompts memory session files reference outline' },
  { id: 'endpoints', label: 'Endpoints', icon: EndpointLogo, title: 'Endpoints', keywords: 'endpoints endpoint api provider model url key' },
  { id: 'harnesses', label: 'Harness', icon: SquareTerminal, title: 'Harness', keywords: 'harness terminal executable model context agent' },
]

// Forgiving multi-term match: every query token must appear in the haystack.

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { settings, updateSettings, settingsTab, setSettingsTab } = useSettingsStore()
  // Deep-link target from the store (e.g. the panel's "Manage endpoints…"):
  // consumed once as the initial tab, then cleared.
  const [activeTab, setActiveTab] = useState<SettingsTabId>(settingsTab ?? 'general')
  useEffect(() => { setSettingsTab(null) }, [setSettingsTab])
  const [availableFiles, setAvailableFiles] = useState<{ name: string; path: string }[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    apiFetch(`${API_BASE}/api/workspace/files`)
      .then(res => res.json())
      .then(data => setAvailableFiles(data))
      .catch(err => {
        console.error(err)
        toast.error('Could not list workspace files for context pinning.')
      })
  }, [])

  const visibleTabs = TABS.filter((t) => matchesQuery(query, `${t.label} ${t.keywords}`))

  // When searching filters the current tab out, jump to the first match.
  if (query.trim() && visibleTabs.length > 0 && !visibleTabs.some((t) => t.id === activeTab)) {
    setActiveTab(visibleTabs[0].id)
  }

  const active = TABS.find((t) => t.id === activeTab) ?? TABS[0]

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-4xl! w-full p-0 gap-0 bg-[var(--bg)] border-[var(--border-subtle)] rounded-[16px] h-[720px] max-h-[90vh] overflow-hidden font-sans sm:max-w-4xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex flex-1 overflow-hidden h-full max-h-[90vh]">
          {/* Sidebar Tabs */}
          <div className="w-[200px] border-r border-[var(--border-subtle)] p-3 flex flex-col gap-1 shrink-0">
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings"
                className="pl-8 pr-7 py-1.5 text-[12px] bg-[var(--bg-input)] border-[var(--border-subtle)] rounded-[8px]"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-heading)] transition-colors cursor-pointer"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {visibleTabs.map((t) => (
              <TabButton key={t.id} active={activeTab === t.id} onClick={() => setActiveTab(t.id)} label={t.label} icon={t.icon} />
            ))}
            {query.trim() && visibleTabs.length === 0 && (
              <p className="text-[12px] text-[var(--text-muted)] px-3 py-2">No matching settings.</p>
            )}
          </div>

          {/* Content Area */}
          <div className="flex-1 min-w-0 bg-[var(--bg)] text-[var(--text)] relative flex flex-col">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="absolute top-5 right-6 z-10 text-[var(--text-muted)]"
            >
              <X size={15} />
            </Button>
            <ScrollArea className="flex-1 h-full">
              <div className="px-6 py-8">
                <div className="mb-5">
                  <h2 className="text-[20px] font-medium text-[var(--text-heading)]">{active.title}</h2>
                </div>
                {activeTab === 'general' && <GeneralSettings settings={settings} updateSettings={updateSettings} query={query} />}
                {activeTab === 'workspaces' && <WorkspacesSettings settings={settings} updateSettings={updateSettings} query={query} />}
                {activeTab === 'appearance' && <AppearanceSettings settings={settings} updateSettings={updateSettings} query={query} />}
                {activeTab === 'images' && <ImagesSettings settings={settings} updateSettings={updateSettings} query={query} />}
                {activeTab === 'context' && <ContextSettings settings={settings} updateSettings={updateSettings} availableFiles={availableFiles} query={query} />}
                {activeTab === 'endpoints' && <EndpointsSettings settings={settings} updateSettings={updateSettings} query={query} />}
                {activeTab === 'harnesses' && <HarnessesSettings settings={settings} updateSettings={updateSettings} query={query} />}
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({ active, onClick, label, icon: Icon }: { active: boolean, onClick: () => void, label: string, icon: React.ComponentType<{ size?: number | string; className?: string }> }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={`justify-start gap-2.5 px-3 py-2 text-[13px] rounded-[8px] ${active
        ? 'bg-[var(--bg-hover)] text-[var(--text-heading)] font-medium'
        : 'text-[var(--text-secondary)]'
        }`}
    >
      <Icon size={15} className="shrink-0 opacity-80" />
      {label}
    </Button>
  )
}
