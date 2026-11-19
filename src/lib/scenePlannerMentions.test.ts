import { describe, expect, it } from 'vitest'
import { plannerMentionOptions } from './scenePlannerMentions'

describe('plannerMentionOptions', () => {
  const files = [
    { name: 'scene.md', path: 'chapters/scene.md' },
    { name: 'notes.md', path: 'notes.md' },
  ]

  it('lists actions and every referenceable file, including the active file', () => {
    const options = plannerMentionOptions(files, '', 'chapters/scene.md')
    expect(options.filter(option => option.kind === 'action')).not.toHaveLength(0)
    expect(options.filter(option => option.kind === 'file').map(option => option.path)).toEqual(['chapters/scene.md', 'notes.md'])
  })

  it('filters both files and actions from the same query', () => {
    expect(plannerMentionOptions(files, 'draft').map(option => option.kind === 'action' ? option.id : option.path)).toEqual(['draft-scene'])
    expect(plannerMentionOptions(files, 'notes').map(option => option.kind === 'action' ? option.id : option.path)).toEqual(['notes.md'])
  })
})
