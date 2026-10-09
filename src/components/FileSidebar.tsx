import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { FileText, Loader, Check, ChevronDown, FilePlus, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useEditorStore, type FileEntry } from '../stores/editorStore'
import { useSettingsStore } from '../stores/settingsStore'
import { toast } from '../stores/toastStore'
import { confirmDialog, promptDialog } from '../stores/dialogStore'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { API_BASE, apiFetch } from '../lib/api'
import { selectedWorkspaceDir, workspacePayload } from '../lib/workspace'

interface FolderNode {
  type: 'folder'
  name: string
  path: string
  children: TreeNode[]
}

interface FileNode {
  type: 'file'
  name: string
  path: string
  file: FileEntry
}

type TreeNode = FolderNode | FileNode

const TREE_BASE_PADDING = 6
const TREE_GUIDE_OFFSET = 7
const TREE_GUIDE_LINE = 'bg-[var(--text-muted)]/70'
const TREE_HOVER_GAP = 4

function buildTree(files: FileEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = []

  const getOrCreateFolder = (nodes: TreeNode[], name: string, path: string): FolderNode => {
    let folder = nodes.find((n) => n.type === 'folder' && n.name === name) as FolderNode
    if (!folder) {
      folder = {
        type: 'folder',
        name,
        path,
        children: [],
      }
      nodes.push(folder)
    }
    return folder
  }

  files.forEach((file) => {
    if (file.path.startsWith('prompts/') || file.path.startsWith('.')) {
      return
    }

    const parts = file.path.split('/')
    if (parts.length === 1) {
      return // see rootFiles, we render separately outside the tree.
    }

    let currentLevel = rootNodes
    let currentPath = ''

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part

      const folder = getOrCreateFolder(currentLevel, part, currentPath)
      currentLevel = folder.children
    }

    const fileName = parts[parts.length - 1]
    currentLevel.push({
      type: 'file',
      name: fileName,
      path: file.path,
      file,
    })
  })

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((node) => {
      if (node.type === 'folder') {
        sortNodes(node.children)
      }
    })
  }

  sortNodes(rootNodes)
  return rootNodes
}

function FileIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5.086a1 1 0 0 1 .707.293l2.914 2.914A1 1 0 0 1 13.5 5v8A1.5 1.5 0 0 1 12 14.5H4.5A1.5 1.5 0 0 1 3 13V2.5Z" fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M9.5 1v3a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function FolderClosedIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" />
    </svg>
  )
}

function FolderOpenIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="m3.882 18.043l4.041-5.623a4 4 0 0 1 3.249-1.665h8.752M3.882 18.043a3.65 3.65 0 0 0 2.777 1.277h8.343a4 4 0 0 0 3.405-1.9l2.918-4.734a1.287 1.287 0 0 0-1.115-1.931h-.286M3.882 18.043A3.65 3.65 0 0 1 3 15.661V7.424A2.744 2.744 0 0 1 5.744 4.68h2.653c.607 0 1.189.24 1.618.67l.911.91a1.83 1.83 0 0 0 1.294.537l4.044-.001a3.66 3.66 0 0 1 3.66 3.66v.299" />
    </svg>
  )
}

// Tree guides: one straight vertical spine per level, running through every
// child down to the content bottom edge of the last child. Segments abut
// exactly (no overlaps) so the translucent line never double-draws.
function TreeGuides({ depth, guides, isLast }: { depth: number; guides: boolean[]; isLast: boolean }) {
  if (depth === 0) return null
  const spineX = (depth - 1) * 12 + TREE_BASE_PADDING + TREE_GUIDE_OFFSET
  return (
    <>
      {guides.slice(0, depth - 1).map((on, i) =>
        on ? (
          <span key={i} aria-hidden="true" className={`absolute top-0 bottom-0 w-px ${TREE_GUIDE_LINE}`} style={{ left: `${i * 12 + TREE_BASE_PADDING + TREE_GUIDE_OFFSET}px` }} />
        ) : null
      )}
      <span aria-hidden="true" className={`absolute top-0 w-px ${TREE_GUIDE_LINE} ${isLast ? 'bottom-2' : 'bottom-0'}`} style={{ left: `${spineX}px` }} />
    </>
  )
}

// Row action menus share the same items as the right-click ContextMenu below.
function FolderRowMenu({ folder, onNewFile, onNewFolder, onRename, onDelete }: {
  folder: string
  onNewFile: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button
            title="Folder actions"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-center w-4 h-4 text-[var(--text-secondary)]/60 hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[4px] transition-all cursor-pointer active:scale-[0.9] opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal className="w-3 h-3" strokeWidth={2.25} />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-40 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
        <DropdownMenuItem onClick={onNewFile} title={folder ? `New file in ${folder}` : undefined} className="text-[11px]">
          <FilePlus className="w-3.5 h-3.5" strokeWidth={2} />
          New file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onNewFolder} title={folder ? `New folder inside ${folder}` : undefined} className="text-[11px]">
          <FolderPlus className="w-3.5 h-3.5" strokeWidth={2} />
          New folder
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename} title={folder ? `Rename ${folder}` : undefined} className="text-[11px]">
          <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} title={folder ? `Delete ${folder} and everything inside it` : undefined} variant="destructive" className="text-[11px]">
          <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FileRowMenu({ onRename, onDelete }: {
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button
            title="File actions"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-center w-4 h-4 text-[var(--text-secondary)]/60 hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[4px] transition-all cursor-pointer active:scale-[0.9] opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal className="w-3 h-3" strokeWidth={2.25} />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-40 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
        <DropdownMenuItem onClick={onRename} className="text-[11px]">
          <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} variant="destructive" className="text-[11px]">
          <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FileSidebar({
  onSaveCurrentFile,
  filesPanelOpen,
  setFilesPanelOpen,
  aiPanelOpen,
  setAiPanelOpen,
}: {
  onSaveCurrentFile?: () => Promise<void>
  filesPanelOpen?: boolean
  setFilesPanelOpen?: (open: boolean) => void
  aiPanelOpen?: boolean
  setAiPanelOpen?: (open: boolean) => void
}) {
  const {
    workspaceDir, setWorkspaceDir,
    openedFiles, addFile,
    setContent, clearFiles,
  } = useEditorStore()

  const { settings, setShowSettings, setSettingsTab, updateSettings } = useSettingsStore()

  const [loading, setLoading] = useState(true)
  const linkedWorkspaceDir = settings?.linked_workspace_dir ?? null
  const [previousLinkedWorkspaceDir, setPreviousLinkedWorkspaceDir] = useState(linkedWorkspaceDir)
  if (previousLinkedWorkspaceDir !== linkedWorkspaceDir) {
    setPreviousLinkedWorkspaceDir(linkedWorkspaceDir)
    setLoading(true)
  }
  const initialLoadDone = useRef(false)

  const [showLayoutDropdown, setShowLayoutDropdown] = useState(false)

  const [showSwitcher, setShowSwitcher] = useState(false)

  const setCurrentFilePath = useEditorStore((s) => s.setCurrentFilePath)
  const updateFileContent = useEditorStore((s) => s.updateFileContent)
  const removeFile = useEditorStore((s) => s.removeFile)
  const currentFilePath = useEditorStore((s) => s.currentFilePath)

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set()
  )

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const hasAutoExpanded = useRef(false)

  // Auto-expand top-level folders once on initial load
  useEffect(() => {
    if (openedFiles.length === 0 || hasAutoExpanded.current) return
    hasAutoExpanded.current = true
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      openedFiles.forEach((file) => {
        const parts = file.path.split('/')
        if (parts.length > 1) {
          const topLevel = parts[0]
          if (topLevel !== 'prompts' && !topLevel.startsWith('.')) {
            next.add(topLevel)
          }
        }
      })
      return next
    })
  }, [openedFiles])

  const treeNodes = useMemo(() => {
    return buildTree(openedFiles)
  }, [openedFiles])

  // Selected workspace: this client's linked dir from settings (hydrated from
  // localStorage). Null = sample workspace default.
  const effectiveWorkspaceDir = selectedWorkspaceDir(settings?.linked_workspace_dir)

  // Auto-fetch from backend whenever linked workspace directory changes
  useEffect(() => {
    let active = true
    useEditorStore.getState().cancelAutoSave()
    clearFiles()
    initialLoadDone.current = true
    hasAutoExpanded.current = false

    const fetchWorkspaceFiles = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/workspace/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workspacePayload(effectiveWorkspaceDir)),
        })
        if (!res.ok) throw new Error()
        const files = await res.json()
        if (!active) return
        setWorkspaceDir(effectiveWorkspaceDir ? 'custom' : 'sample')
        for (const file of files) {
          addFile({ name: file.name, path: file.path, content: '', originalContent: '' })
        }
      } catch {
        // skip
      }
    }

    fetchWorkspaceFiles()
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [effectiveWorkspaceDir, clearFiles, addFile, setWorkspaceDir])

  const handleFileClick = useCallback(async (path: string) => {
    const store = useEditorStore.getState()
    if (store.aiPendingEdit && store.currentFilePath) {
      const previous = store.aiPendingEdit.previousContent
      store.editor?.commands.clearAiHighlight()
      store.setContent(previous)
      store.setAiPendingEdit(null)
    }

    await store.flushSave()
    if (onSaveCurrentFile) {
      await onSaveCurrentFile()
    }
    const updatedStore = useEditorStore.getState()
    const { currentFilePath, content } = updatedStore
    if (currentFilePath) {
      updateFileContent(currentFilePath, content)
    }
    
    let file = openedFiles.find((f) => f.path === path)
    if (file) {
      // Lazy load content if it hasn't been fetched yet
      if (!file.content && !file.originalContent) {
        try {
          const res = await apiFetch(`${API_BASE}/api/workspace/files/${encodeURIComponent(path)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              workspacePayload(useSettingsStore.getState().selectedWorkspaceDir()),
            ),
          })
          if (res.ok) {
            const data = await res.json()
            useEditorStore.getState().loadFileContent(path, data.content)
            file = { ...file, content: data.content, originalContent: data.content }
          }
        } catch (err) {
          console.error("Failed to fetch file content", err)
          toast.error(`Could not open "${path}" — showing last known content.`)
        }
      }

      setContent(file.content || '')
      setCurrentFilePath(path)
    }
  }, [openedFiles, setContent, setCurrentFilePath, updateFileContent, onSaveCurrentFile])

  const handleCreateFile = useCallback(async (folder: string) => {
    const trimmed = await promptDialog({
      title: 'New file',
      description: folder ? `Will be saved to ${folder}/` : 'Will be saved to workspace root',
      initialValue: 'new-file.md',
      placeholder: 'new-file.md',
      confirmLabel: 'Create',
      validate: (v) => (!v ? 'Enter a file name.' : null),
    })
    if (!trimmed) return

    try {
      const res = await apiFetch(`${API_BASE}/api/workspace/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder,
          name: trimmed,
          content: '',
          ...workspacePayload(useSettingsStore.getState().selectedWorkspaceDir()),
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to create file: ${err.detail || res.statusText}`)
        return
      }
      const data = await res.json()
      addFile({ name: data.name, path: data.path, content: data.content, originalContent: data.content })
      setContent(data.content)
      setCurrentFilePath(data.path)
    } catch (err) {
      toast.error(`Failed to create file: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [addFile, setContent, setCurrentFilePath])

  const handleCreateFolder = useCallback(async (parent?: string | null) => {
    const raw = await promptDialog({
      title: 'New folder',
      description: parent ? `Inside '${parent}' (lowercase, numbers, - and _ only)` : "E.g. 'world_building'",
      placeholder: 'world_building',
      confirmLabel: 'Create',
      validate: (v) => {
        const slug = v.toLowerCase().replace(/[^a-z0-9_-]/g, '')
        if (!slug) return 'Use letters, numbers, - or _.'
        return null
      },
    })
    if (!raw) return
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!slug) return
    const folder = parent ? `${parent}/${slug}` : slug

    const defaultManifestName = `${slug.toUpperCase()}.md`
    try {
      const res = await apiFetch(`${API_BASE}/api/workspace/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder,
          name: defaultManifestName,
          content: `# Available ${raw.trim()}\n\n`,
          ...workspacePayload(useSettingsStore.getState().selectedWorkspaceDir()),
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to create folder: ${err.detail || res.statusText}`)
        return
      }
      const data = await res.json()
      addFile({ name: data.name, path: data.path, content: data.content, originalContent: data.content })
    } catch (err) {
      toast.error(`Failed to create folder: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [addFile])

  const handleDeleteFile = useCallback(async (path: string) => {
    const isActive = currentFilePath === path
    const confirmed = await confirmDialog({
      title: `Delete "${path}"?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
    })
    if (!confirmed) return

    try {
      useEditorStore.getState().cancelAutoSave()
      const res = await apiFetch(`${API_BASE}/api/workspace/files/${encodeURIComponent(path)}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to delete file: ${err.detail || res.statusText}`)
        return
      }
      removeFile(path)
      if (isActive) {
        useEditorStore.getState().cancelAutoSave()
        setContent('')
        setCurrentFilePath(null)
      }
    } catch (err) {
      toast.error(`Failed to delete file: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [currentFilePath, removeFile, setContent, setCurrentFilePath])

  const handleRenameFile = useCallback(async (path: string) => {
    const oldName = path.split('/').pop() ?? path
    const newName = await promptDialog({
      title: `Rename "${oldName}"`,
      initialValue: oldName,
      confirmLabel: 'Rename',
      validate: (v) => (!v ? 'Enter a name.' : null),
    })
    if (!newName || newName === oldName) return

    try {
      await useEditorStore.getState().flushSave()
      const res = await apiFetch(`${API_BASE}/api/workspace/files/${encodeURIComponent(path)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to rename: ${err.detail || res.statusText}`)
        return
      }
      const data = await res.json()
      const store = useEditorStore.getState()
      const existing = store.openedFiles.find((f) => f.path === path)
      if (existing) {
        removeFile(path)
        addFile({ ...existing, name: data.name, path: data.path })
        if (store.currentFilePath === path) {
          setCurrentFilePath(data.path)
        }
      }
    } catch (err) {
      toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [removeFile, addFile, setCurrentFilePath])

  const handleRenameFolder = useCallback(async (folder: string) => {
    const oldName = folder.split('/').pop() ?? folder
    const trimmed = await promptDialog({
      title: `Rename "${oldName}"`,
      initialValue: oldName,
      confirmLabel: 'Rename',
      validate: (v) => (!v ? 'Enter a name.' : null),
    })
    if (!trimmed) return

    try {
      await useEditorStore.getState().flushSave()
      const res = await apiFetch(`${API_BASE}/api/workspace/folders/${encodeURIComponent(folder)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to rename: ${err.detail || res.statusText}`)
        return
      }
      const data = await res.json()
      const newPrefix: string = data.path
      const store = useEditorStore.getState()
      const affected = store.openedFiles.filter(
        (f) => f.path === folder || f.path.startsWith(`${folder}/`)
      )
      for (const f of affected) {
        removeFile(f.path)
        addFile({ ...f, path: `${newPrefix}${f.path.slice(folder.length)}` })
      }
      if (store.currentFilePath && (
        store.currentFilePath === folder ||
        store.currentFilePath.startsWith(`${folder}/`)
      )) {
        setCurrentFilePath(`${newPrefix}${store.currentFilePath.slice(folder.length)}`)
      }
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (next.has(folder)) {
          next.delete(folder)
          next.add(newPrefix)
        }
        return next
      })
    } catch (err) {
      toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [removeFile, addFile, setCurrentFilePath])

  const handleDeleteFolder = useCallback(async (folder: string) => {
    const store = useEditorStore.getState()
    const inside = store.openedFiles.filter(
      (f) => f.path === folder || f.path.startsWith(`${folder}/`)
    )
    const confirmed = await confirmDialog({
      title: `Delete "${folder}"?`,
      description: `${inside.length > 0 ? `${inside.length} file${inside.length > 1 ? 's' : ''} inside will be deleted. ` : ''}This cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!confirmed) return

    try {
      store.cancelAutoSave()
      const res = await apiFetch(`${API_BASE}/api/workspace/folders/${encodeURIComponent(folder)}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to delete folder: ${err.detail || res.statusText}`)
        return
      }
      for (const f of inside) {
        removeFile(f.path)
      }
      const current = useEditorStore.getState().currentFilePath
      if (current && (current === folder || current.startsWith(`${folder}/`))) {
        useEditorStore.getState().cancelAutoSave()
        setContent('')
        setCurrentFilePath(null)
      }
    } catch (err) {
      toast.error(`Failed to delete folder: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [removeFile, setContent, setCurrentFilePath])

  const rootFiles = openedFiles.filter((f) => !f.path.includes('/'))

  const profiles = settings?.workspace_profiles || []
  const [activeName, setActiveName] = useState('sample-workspace')

  useEffect(() => {
    const linked = settings?.linked_workspace_dir
    if (!linked) {
      setActiveName('sample-workspace')
      return
    }
    const match = profiles.find((p) => p.path === linked)
    if (match) {
      setActiveName(match.name)
      return
    }
    const base = linked.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    setActiveName(base || linked)
  }, [settings?.linked_workspace_dir, profiles])

  const handleSwitchWorkspace = useCallback(async (path: string | null) => {
    setShowSwitcher(false)
    try {
      await updateSettings({ linked_workspace_dir: path })
      toast.success(path ? 'Workspace switched.' : 'Reset to default fallback workspace.')
    } catch {
      toast.error('Could not switch workspace.')
    }
  }, [updateSettings])

  return (
    <div
      className="flex flex-col gap-3 w-full h-full overflow-y-auto select-none"
    >
      {/* Workspace switcher + layout row */}
      <div className="flex items-center gap-1.5 pb-2.5 border-b border-[var(--border-sidebar)] shrink-0 select-none animate-fade-in">
        <div className='w-1/2'>
        <DropdownMenu open={showSwitcher} onOpenChange={setShowSwitcher}>
          <DropdownMenuTrigger
            render={
              <button
                className={`flex items-center gap-1.5 min-w-0 max-w-full px-1.5 py-1 rounded-[6px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 transition-all cursor-pointer active:scale-[0.98] ${showSwitcher ? 'bg-[var(--border-sidebar)]/60 text-[var(--text-heading)]' : ''}`}
                title="Switch workspace"
              >
                <span className="truncate font-sans font-medium text-[12px]">{activeName}</span>
                <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={2} />
              </button>
            }
          />
          <DropdownMenuContent align="start" className="w-52 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
            <DropdownMenuItem
              onClick={() => handleSwitchWorkspace(null)}
              className="text-[11px] font-medium"
            >
              <span className="flex-1 min-w-0 truncate">sample-workspace</span>
              {!settings?.linked_workspace_dir && <Check size={13} className="shrink-0 text-[var(--accent-brown)]" />}
            </DropdownMenuItem>
            {profiles.map((p) => {
              const isActive = settings?.linked_workspace_dir === p.path
              return (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => isActive || handleSwitchWorkspace(p.path)}
                  title={p.path}
                  className="text-[11px] font-medium"
                >
                  <span className="flex-1 min-w-0 truncate">{p.name}</span>
                  {isActive && <Check size={13} className="shrink-0 text-[var(--accent-brown)]" />}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator className="bg-[var(--border-sidebar)]/60" />
            <DropdownMenuItem
              onClick={() => {
                setShowSwitcher(false)
                setSettingsTab('workspaces')
                setShowSettings(true)
              }}
              className="text-[11px] text-[var(--text-secondary)]"
            >
              Manage workspaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        <div className='ml-auto w-1/2 flex justify-end'>
        {workspaceDir && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleCreateFile('')}
              className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-heading)]"
              title="New file in workspace root"
            >
              <FilePlus className="w-3.5 h-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleCreateFolder(null)}
              className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-heading)]"
              title="New folder"
            >
              <FolderPlus className="w-3.5 h-3.5" strokeWidth={1.75} />
            </Button>
          </>
        )}
        <DropdownMenu open={showLayoutDropdown} onOpenChange={setShowLayoutDropdown}>
          <DropdownMenuTrigger
            render={
              <button
                className={`flex items-center justify-center w-7 h-7 text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--border-sidebar)]/60 rounded-[6px] transition-all cursor-pointer active:scale-[0.95] ${showLayoutDropdown ? 'bg-[var(--border-sidebar)]/60 text-[var(--text-heading)]' : ''}`}
                title="Layout Options"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-36 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
            <DropdownMenuCheckboxItem
              checked={!!filesPanelOpen}
              onCheckedChange={() => setFilesPanelOpen?.(!filesPanelOpen)}
              className="text-[11px]"
            >
              Files Panel
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={!!aiPanelOpen}
              onCheckedChange={() => setAiPanelOpen?.(!aiPanelOpen)}
              className="text-[11px]"
            >
              AI Assist
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>


      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-secondary)]">
          <Loader className="w-4 h-4 animate-spin" strokeWidth={2} />
          <span>Loading files...</span>
        </div>
      )}

      {/* Empty state — only when there's truly no workspace at all */}
      {!loading && !workspaceDir && (
        <div className="flex flex-col items-center justify-center py-8 text-center select-none flex-1">
          <FileText className="w-8 h-8 text-[var(--text-muted)] mb-3" strokeWidth={1} />
          <p className="text-[11px] text-[var(--text-secondary)] font-medium">No folder opened</p>
          <p className="text-[10px] text-[var(--text-muted)] mt-1 max-w-[180px]">
            Open a folder to browse and tag reference files
          </p>
        </div>
      )}

      {/* File list — always show section headers once a workspace is linked */}
      {!loading && workspaceDir && (
        <div className="flex flex-col gap-0">
          {rootFiles.length > 0 && (
            <div className="flex flex-col gap-0">
              {rootFiles.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  depth={0}
                  onSelect={handleFileClick}
                  onRename={() => handleRenameFile(file.path)}
                  onDelete={() => handleDeleteFile(file.path)}
                />
              ))}
            </div>
          )}

          {treeNodes.map((node, i) => (
            <TreeNodeComponent
              key={node.path}
              node={node}
              depth={0}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              handleFileClick={handleFileClick}
              onCreateFile={handleCreateFile}
              onCreateFolder={handleCreateFolder}
              onRenameFile={handleRenameFile}
              onRenameFolder={handleRenameFolder}
              onDeleteFile={handleDeleteFile}
              onDeleteFolder={handleDeleteFolder}
              guides={[]}
              isLast={i === treeNodes.length - 1}
            />
          ))}



          {openedFiles.length === 0 && (
            <p className="text-[10px] text-[var(--text-muted)] px-2 pt-1 select-none">
              Empty workspace — use the buttons above to create your first file or folder.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function FolderRow({
  name,
  path,
  depth,
  isExpanded,
  hasChildren = false,
  onToggle,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  guides = [],
  isLast = true,
}: {
  name: string
  path: string
  depth: number
  isExpanded: boolean
  hasChildren?: boolean
  onToggle: () => void
  onNewFile: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
  guides?: boolean[]
  isLast?: boolean
}) {
  const hoverInset = depth === 0 ? 0 : (depth - 1) * 12 + TREE_BASE_PADDING + TREE_GUIDE_OFFSET + TREE_HOVER_GAP
  const hoverPadding = depth * 12 + TREE_BASE_PADDING - hoverInset
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          onClick={onToggle}
          data-folderpath={path}
          className="group relative select-none"
          title={isExpanded ? 'Collapse folder' : 'Expand folder'}
        >
          <TreeGuides depth={depth} guides={guides} isLast={isLast} />
          <div
            style={{ marginLeft: `${hoverInset}px`, paddingLeft: `${hoverPadding}px` }}
            className={`flex items-center gap-1 pr-2.5 py-2 rounded-[6px] text-xs transition-colors duration-150 cursor-pointer ${isExpanded
              ? 'text-[var(--text)] hover:bg-[var(--border-sidebar)]/30'
              : 'text-[var(--text-secondary)] hover:bg-[var(--border-sidebar)]/30 hover:text-[var(--text)]'
              }`}
          >
            {hasChildren ? (
              <ChevronDown className={`w-3 h-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${isExpanded ? '' : '-rotate-90'}`} strokeWidth={2} />
            ) : (
              <span className="w-3 shrink-0" aria-hidden="true" />
            )}
            <div className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
              {isExpanded
                ? <FolderOpenIcon className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
                : <FolderClosedIcon className="w-4 h-4 shrink-0 text-[var(--text-secondary)]/60" />}
              <span className="truncate font-sans font-medium">{name}</span>
            </div>
            <FolderRowMenu
              folder={path}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onRename={onRename}
              onDelete={onDelete}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
        <ContextMenuItem onClick={onNewFile} title={path ? `New file in ${path}` : undefined} className="text-[11px]">
          <FilePlus className="w-3.5 h-3.5" strokeWidth={2} />
          New file
        </ContextMenuItem>
        <ContextMenuItem onClick={onNewFolder} title={path ? `New folder inside ${path}` : undefined} className="text-[11px]">
          <FolderPlus className="w-3.5 h-3.5" strokeWidth={2} />
          New folder
        </ContextMenuItem>
        <ContextMenuItem onClick={onRename} title={path ? `Rename ${path}` : undefined} className="text-[11px]">
          <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator className="bg-[var(--border-sidebar)]/60" />
        <ContextMenuItem onClick={onDelete} title={path ? `Delete ${path} and everything inside it` : undefined} variant="destructive" className="text-[11px]">
          <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function TreeNodeComponent({
  node,
  depth,
  expandedFolders,
  toggleFolder,
  handleFileClick,
  onCreateFile,
  onCreateFolder,
  onRenameFile,
  onRenameFolder,
  onDeleteFile,
  onDeleteFolder,
  guides = [],
  isLast = true,
}: {
  node: TreeNode
  depth: number
  expandedFolders: Set<string>
  toggleFolder: (path: string) => void
  handleFileClick: (path: string) => void
  onCreateFile: (folder: string) => void
  onCreateFolder: (parent?: string | null) => void
  onRenameFile: (path: string) => void
  onRenameFolder: (folder: string) => void
  onDeleteFile: (path: string) => void
  onDeleteFolder: (folder: string) => void
  guides?: boolean[]
  isLast?: boolean
}) {
  if (node.type === 'file') {
    return (
      <FileRow
        file={node.file}
        depth={depth}
        onSelect={handleFileClick}
        onRename={() => onRenameFile(node.file.path)}
        onDelete={() => onDeleteFile(node.file.path)}
        guides={guides}
        isLast={isLast}
      />
    )
  }

  const isExpanded = expandedFolders.has(node.path)

  return (
    <div>
      <FolderRow
        name={node.name}
        path={node.path}
        depth={depth}
        isExpanded={isExpanded}
        hasChildren={node.children.length > 0}
        onToggle={() => toggleFolder(node.path)}
        onNewFile={() => onCreateFile(node.path)}
        onNewFolder={() => onCreateFolder(node.path)}
        onRename={() => onRenameFolder(node.path)}
        onDelete={() => onDeleteFolder(node.path)}
        guides={guides}
        isLast={isLast}
      />
      {isExpanded && (
        <div className="flex flex-col gap-0">
          {node.children.map((child, i) => (
            <TreeNodeComponent
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              handleFileClick={handleFileClick}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onRenameFile={onRenameFile}
              onRenameFolder={onRenameFolder}
              onDeleteFile={onDeleteFile}
              onDeleteFolder={onDeleteFolder}
              guides={[...guides, i < node.children.length - 1]}
              isLast={i === node.children.length - 1}
            />
          ))}
        </div>
      )}
      {isExpanded && node.children.length === 0 && (
        <div
          style={{ paddingLeft: `${(depth + 1) * 12 + TREE_BASE_PADDING}px` }}
          className="text-[10px] text-[var(--text-muted)] py-1 select-none italic"
        >
          Empty folder
        </div>
      )}
    </div>
  )
}

function FileRow({
  file,
  depth = 0,
  onSelect,
  onRename,
  onDelete,
  guides = [],
  isLast = true,
}: {
  file: FileEntry
  depth?: number
  onSelect: (path: string) => void
  onRename: () => void
  onDelete: () => void
  guides?: boolean[]
  isLast?: boolean
}) {
  const isActive = useEditorStore((s) => s.currentFilePath === file.path)
  const hoverInset = depth === 0 ? 0 : (depth - 1) * 12 + TREE_BASE_PADDING + TREE_GUIDE_OFFSET + TREE_HOVER_GAP
  const hoverPadding = depth * 12 + TREE_BASE_PADDING - hoverInset

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          onClick={() => onSelect(file.path)}
          onContextMenu={() => onSelect(file.path)}
          data-filepath={file.path}
          className="group relative select-none"
        >
          <TreeGuides depth={depth} guides={guides} isLast={isLast} />
          <div
            style={{ marginLeft: `${hoverInset}px`, paddingLeft: `${hoverPadding}px` }}
            className={`flex items-center gap-1 pr-2.5 py-2 rounded-[6px] text-xs transition-colors duration-150 cursor-pointer ${isActive
              ? 'text-[var(--text)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--border-sidebar)]/30 hover:text-[var(--text)]'
              }`}
          >
            <span className="w-3 shrink-0" aria-hidden="true" />
            <div
              className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
              title={file.path}
            >
            <FileIcon className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]/60'}`} />
            <span className="truncate font-sans font-medium">{file.name}</span>
          </div>
          <FileRowMenu onRename={onRename} onDelete={onDelete} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 bg-[var(--bg-elevated)] border-[var(--border-sidebar)]/70">
        <ContextMenuItem onClick={onRename} className="text-[11px]">
          <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator className="bg-[var(--border-sidebar)]/60" />
        <ContextMenuItem onClick={onDelete} variant="destructive" className="text-[11px]">
          <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
