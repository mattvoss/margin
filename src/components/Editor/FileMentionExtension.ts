import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEditorStore } from '../../stores/editorStore'
import { buildMentionAliases, createMentionMatcher } from '../../lib/fileMentions'

const fileMentionPluginKey = new PluginKey('fileMention')

/**
 * View-only chips for `@file` references.
 *
 * The document keeps plain `@filename` text; this plugin decorates matches
 * against the current workspace files. Because nothing is added to the schema,
 * markdown round-trips are byte-identical and stale references simply stop
 * being chips instead of corrupting the text.
 */
export const FileMentionExtension = Extension.create({
  name: 'fileMention',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: fileMentionPluginKey,
        props: {
          decorations(state) {
            const { openedFiles, currentFilePath } = useEditorStore.getState()
            const aliases = buildMentionAliases(openedFiles, currentFilePath)
            if (aliases.length === 0) return null

            const matcher = createMentionMatcher(aliases)
            const decorations: Decoration[] = []

            state.doc.descendants((node, pos) => {
              // Code is literal; don't chip references inside fenced blocks.
              if (node.type.name === 'codeBlock') return false
              if (!node.isText || !node.text) return
              // Inline code is literal too.
              if (node.marks.some((mark) => mark.type.name === 'code')) return
              for (const match of matcher.findRanges(node.text)) {
                const from = pos + match.from
                const to = pos + match.to
                const { name, path } = match.target
                const length = to - from

                decorations.push(
                  Decoration.inline(from, to, {
                    class: 'file-mention',
                    'data-path': path,
                    title: `Open ${path}`,
                  }),
                  Decoration.widget(
                    to,
                    (view, getPos) => {
                      const button = document.createElement('button')
                      button.type = 'button'
                      button.contentEditable = 'false'
                      button.className = 'file-mention__remove'
                      button.setAttribute('aria-label', `Remove reference to ${name}`)
                      button.title = `Remove reference to ${name}`
                      button.textContent = '×'
                      button.addEventListener('mousedown', (event) => {
                        // Keep the editor focused, but delete on click so the
                        // click that follows cannot land on a neighbouring chip.
                        event.preventDefault()
                        event.stopPropagation()
                      })
                      button.addEventListener('click', (event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const end = getPos()
                        if (typeof end !== 'number') return
                        const start = end - length
                        if (start < 0) return
                        view.dispatch(view.state.tr.delete(start, end))
                        view.focus()
                      })
                      return button
                    },
                    // `length` belongs in the key: the same file can be
                    // written as a basename or a path, and a reused DOM node
                    // would otherwise keep a stale delete range.
                    {
                      side: 1,
                      key: `file-mention-remove:${path}:${from}:${length}`,
                    },
                  ),
                )
              }
            })

            return DecorationSet.create(state.doc, decorations)
          },

          handleDOMEvents: {
            click(view, event) {
              if (event.defaultPrevented || event.button !== 0) return false
              const target = event.target as HTMLElement | null
              const chip = target?.closest?.('.file-mention') as HTMLElement | null
              const path = chip?.dataset.path
              if (!path) return false
              // Let a click that is ending a text selection behave normally.
              if (!view.state.selection.empty) return false

              event.preventDefault()
              if (useEditorStore.getState().currentFilePath !== path) {
                void useEditorStore.getState().openFile(path)
              }
              return true
            },
          },
        },
      }),
    ]
  },
})
