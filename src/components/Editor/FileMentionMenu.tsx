import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { FileText } from 'lucide-react'
import {
  filterMentionFiles,
  type ReferenceFile,
} from '../../lib/fileMentions'

export interface FileMentionMenuHandle {
  /** Returns true when the key was consumed by the menu. */
  onKeyDown: (e: KeyboardEvent) => boolean
}

interface FileMentionMenuProps {
  query: string
  range: { from: number; to: number }
  files: ReferenceFile[]
  currentPath?: string | null
  onSelect: (file: ReferenceFile) => void
  /** Escape: cancel the reference and remove the typed `@query`. */
  onCancel: () => void
}

function folderHint(file: ReferenceFile): string {
  const slash = file.path.lastIndexOf('/')
  return slash === -1 ? 'Workspace root' : file.path.slice(0, slash)
}

export const FileMentionMenu = forwardRef<
  FileMentionMenuHandle,
  FileMentionMenuProps
>(function FileMentionMenu(
  { query, range, files, currentPath, onSelect, onCancel },
  ref,
) {
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () => filterMentionFiles(files, query, currentPath),
    [files, query, currentPath],
  )

  useEffect(() => {
    setActive(0)
  }, [query, range.from, range.to])

  useEffect(() => {
    setActive((current) =>
      current < filtered.length ? current : 0,
    )
  }, [filtered.length])

  const runFile = (file: ReferenceFile) => {
    onSelect(file)
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((current) => {
          const count = filtered.length
          if (count === 0) return 0
          return e.key === 'ArrowDown'
            ? (current + 1) % count
            : (current - 1 + count) % count
        })
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const file = filtered[active]
        if (file) {
          e.preventDefault()
          runFile(file)
          return true
        }
        return false
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return true
      }
      return false
    },
  }))

  // Keep the active row visible while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="slash-menu file-mention-menu">
      <div ref={listRef} className="slash-menu__list">
        {filtered.length === 0 && (
          <div className="slash-menu__empty">No matching files</div>
        )}
        {filtered.map((file, i) => (
          <button
            key={file.path}
            type="button"
            role="option"
            aria-selected={i === active}
            data-index={i}
            onMouseDown={(e) => {
              e.preventDefault()
              runFile(file)
            }}
            onMouseEnter={() => setActive(i)}
            className={`slash-menu__item ${i === active ? 'slash-menu__item--active' : ''}`}
          >
            <FileText className="slash-menu__icon" aria-hidden="true" />
            <span className="slash-menu__text">
              <span className="slash-menu__label">{file.name}</span>
              <span className="slash-menu__hint">{folderHint(file)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
})
