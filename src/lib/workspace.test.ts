import { describe, expect, it } from 'vitest'
import { rememberedFilePath, workspaceKey } from './workspace'

describe('workspaceKey', () => {
  it('uses the sample sentinel for null, blank, and sample dirs', () => {
    expect(workspaceKey(null)).toBe('sample')
    expect(workspaceKey('')).toBe('sample')
    expect(workspaceKey('  sample ')).toBe('sample')
    expect(workspaceKey('/ws')).toBe('/ws')
  })
})

describe('rememberedFilePath', () => {
  it('returns the remembered path only while it still exists', () => {
    const paths = { '/ws': 'chapters/two.md' }
    expect(rememberedFilePath(paths, '/ws', ['chapters/one.md', 'chapters/two.md'])).toBe(
      'chapters/two.md',
    )
    expect(rememberedFilePath(paths, '/ws', ['chapters/one.md'])).toBeNull()
    expect(rememberedFilePath(paths, null, ['chapters/two.md'])).toBeNull()
    expect(rememberedFilePath(undefined, '/ws', ['chapters/two.md'])).toBeNull()
  })
})
