import { useEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
} from '@floating-ui/dom'

/**
 * Position a portal-rendered menu at the caret.
 *
 * Flips above the cursor near the viewport bottom, shifts inside horizontal
 * edges, constrains height to the available space, and repositions on
 * scroll/resize through Floating UI's autoUpdate. Coordinates are read from
 * the live cursor on every update so the anchor tracks while typing.
 */
export function useCursorMenuPosition(
  editor: Editor | null,
  range: { from: number; to: number } | null,
  elRef: RefObject<HTMLDivElement | null>,
) {
  const anchorPos = range?.to ?? null

  useEffect(() => {
    if (!editor || anchorPos == null) return
    const el = elRef.current
    if (!el) return

    const anchor = {
      getBoundingClientRect: () => {
        try {
          const coords = editor.view.coordsAtPos(anchorPos)
          return {
            x: coords.left,
            y: coords.bottom,
            width: 0,
            height: 0,
            top: coords.bottom,
            left: coords.left,
            bottom: coords.bottom,
            right: coords.left,
            toJSON: () => ({}),
          } as DOMRect
        } catch {
          return new DOMRect(-9999, -9999, 0, 0)
        }
      },
    }

    const update = () => {
      void computePosition(anchor, el, {
        placement: 'bottom-start',
        middleware: [
          offset(6),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(160, Math.min(320, availableHeight))}px`
            },
          }),
        ],
      }).then(({ x, y }) => {
        el.style.left = `${x}px`
        el.style.top = `${y}px`
      })
    }

    update()
    return autoUpdate(anchor, el, update)
  }, [editor, anchorPos, elRef])
}
