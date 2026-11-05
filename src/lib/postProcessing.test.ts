import { describe, it, expect } from 'vitest'
import {
  LEGACY_FIX_SLOP_PROMPT,
  MAX_POST_PROCESS_PASSES,
  POST_PROCESSING_VERSION,
  STARTER_PASSES,
  activePostProcessPreset,
  createDefaultPostProcessing,
  enabledPostProcessPasses,
  normalizePostProcessing,
  postProcessingForMode,
} from './postProcessing'

describe('post-processing defaults', () => {
  it('ships one preset with five disabled starter passes', () => {
    const config = createDefaultPostProcessing()
    expect(config.version).toBe(POST_PROCESSING_VERSION)
    expect(config.enabled).toBe(false)
    expect(config.review).toBe(true)
    expect(config.min_chars).toBe(60)
    expect(config.apply_to_edit).toBe(true)
    expect(config.apply_to_chat).toBe(false)
    expect(config.apply_to_harness).toBe(true)
    expect(config.presets).toHaveLength(1)
    expect(STARTER_PASSES).toHaveLength(5)
    expect(activePostProcessPreset(config).name).toBe('Default')
    expect(activePostProcessPreset(config).passes).toHaveLength(STARTER_PASSES.length)
    expect(activePostProcessPreset(config).passes.map((p) => p.name)).toContain(
      'Fix Slop',
    )
    expect(activePostProcessPreset(config).passes.every((p) => !p.enabled)).toBe(true)
    expect(enabledPostProcessPasses(config)).toHaveLength(0)
  })

  it('returns independent pass objects each time', () => {
    const a = createDefaultPostProcessing()
    const b = createDefaultPostProcessing()
    a.presets[0].passes[0].name = 'changed'
    expect(b.presets[0].passes[0].name).not.toBe('changed')
  })
})

describe('normalizePostProcessing', () => {
  it('falls back to defaults for non-objects', () => {
    expect(normalizePostProcessing(null).presets).toHaveLength(1)
    expect(normalizePostProcessing('nope').enabled).toBe(false)
    expect(normalizePostProcessing([]).presets[0].passes).toHaveLength(STARTER_PASSES.length)
  })

  it('clamps values and preserves valid ids', () => {
    const pass = { ...STARTER_PASSES[0], id: 'mine', enabled: true, temperature: 9 }
    const config = normalizePostProcessing({
      enabled: 'yes',
      review: false,
      min_chars: -4,
      active_preset: 'other',
      presets: [{ id: 'other', name: 'Other', passes: [pass] }],
    })
    expect(config.review).toBe(false)
    expect(config.enabled).toBe(false)
    expect(config.min_chars).toBe(0)
    expect(config.active_preset).toBe('other')
    expect(config.presets[0].passes[0].id).toBe('mine')
    expect(config.presets[0].passes[0].temperature).toBe(2)
    expect(enabledPostProcessPasses(config)).toHaveLength(1)
  })

  it('falls back to the first preset when active_preset is stale', () => {
    const config = normalizePostProcessing({
      active_preset: 'missing',
      presets: [{ id: 'a', name: 'A', passes: [] }],
    })
    expect(config.active_preset).toBe('a')
  })

  it('creates a default preset when every stored preset is invalid', () => {
    const config = normalizePostProcessing({ presets: [{}, null, 3] })
    // `{}` is a valid preset with zero passes, so it survives; migration
    // appends the new starter pass to it.
    expect(config.presets).toHaveLength(1)
    expect(config.presets[0].passes.map((p) => p.id)).toEqual(['starter_fix_slop'])
  })

  it('drops passes without prompts and caps the list', () => {
    const passes = Array.from({ length: MAX_POST_PROCESS_PASSES + 5 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      prompt: `Prompt ${i}`,
    }))
    passes.splice(1, 0, { id: 'empty', name: 'Empty', prompt: '   ' })
    const config = normalizePostProcessing({
      presets: [{ id: 'x', name: 'X', passes }],
    })
    expect(config.presets[0].passes).toHaveLength(MAX_POST_PROCESS_PASSES)
    expect(config.presets[0].passes.some((p) => p.id === 'empty')).toBe(false)
  })

  it('dedupes pass and preset ids without random churn', () => {
    const config = normalizePostProcessing({
      version: POST_PROCESSING_VERSION,
      presets: [
        {
          id: 'same',
          name: 'One',
          passes: [
            { id: 'p', prompt: 'a' },
            { id: 'p', prompt: 'b' },
          ],
        },
        { id: 'same', name: 'Two', passes: [] },
      ],
    })
    expect(config.presets.map((p) => p.id)).toEqual(['same', 'same_2'])
    expect(config.presets[0].passes.map((p) => p.id)).toEqual(['p', 'p_2'])
    expect(normalizePostProcessing(config)).toEqual(config)
  })
})

describe('starter pass migration', () => {
  it('appends Fix Slop to a version-less preset once', () => {
    const config = normalizePostProcessing({
      presets: [
        {
          id: 'default',
          name: 'Default',
          passes: [STARTER_PASSES[0]],
        },
      ],
    })

    expect(config.version).toBe(POST_PROCESSING_VERSION)
    expect(config.presets[0].passes.map((p) => p.id)).toEqual([
      STARTER_PASSES[0].id,
      'starter_fix_slop',
    ])
    expect(config.presets[0].passes[1].enabled).toBe(false)
    expect(normalizePostProcessing(config)).toEqual(config)
  })

  it('does not re-add Fix Slop after the version is current', () => {
    const config = normalizePostProcessing({
      version: POST_PROCESSING_VERSION,
      presets: [
        {
          id: 'default',
          name: 'Default',
          passes: [STARTER_PASSES[0]],
        },
      ],
    })

    expect(config.presets[0].passes.map((p) => p.id)).toEqual([STARTER_PASSES[0].id])
  })

  it('upgrades the original Fix Slop prompt once', () => {
    const config = normalizePostProcessing({
      version: 2,
      presets: [
        {
          id: 'default',
          name: 'Default',
          passes: [
            {
              id: 'starter_fix_slop',
              name: 'Fix Slop',
              enabled: true,
              prompt: LEGACY_FIX_SLOP_PROMPT,
            },
          ],
        },
      ],
    })

    const expected = STARTER_PASSES.find((p) => p.id === 'starter_fix_slop')?.prompt
    expect(config.presets[0].passes[0].prompt).toBe(expected)
    expect(config.presets[0].passes[0].enabled).toBe(true)
    expect(normalizePostProcessing(config)).toEqual(config)
  })

  it('does not overwrite an edited Fix Slop prompt', () => {
    const config = normalizePostProcessing({
      version: 2,
      presets: [
        {
          id: 'default',
          name: 'Default',
          passes: [
            {
              id: 'starter_fix_slop',
              name: 'Fix Slop',
              prompt: 'My custom slop prompt.',
            },
          ],
        },
      ],
    })

    expect(config.presets[0].passes[0].prompt).toBe('My custom slop prompt.')
  })
})

describe('postProcessingForMode', () => {
  it('respects the master switch and per-mode flags', () => {
    const config = createDefaultPostProcessing()
    expect(postProcessingForMode(config, 'edit')).toBe(false)
    config.enabled = true
    expect(postProcessingForMode(config, 'edit')).toBe(true)
    expect(postProcessingForMode(config, 'chat')).toBe(false)
    expect(postProcessingForMode(config, 'harness')).toBe(true)
    config.apply_to_chat = true
    expect(postProcessingForMode(config, 'chat')).toBe(true)
  })
})
