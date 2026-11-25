import { describe, expect, it } from 'vitest'
import { agentSettingsFor, defaultAgentSettings, normalizeAgentSettings } from './agents'

describe('agent settings', () => {
  it('provides independent defaults for each mode', () => {
    const settings = defaultAgentSettings()
    settings.write.prose.enabled = false

    expect(settings.edit.writer.enabled).toBe(true)
    expect(settings.chat.chat.enabled).toBe(true)
    expect(settings.write.prose.enabled).toBe(false)
  })

  it('preserves settings while normalizing temperature and thinking level', () => {
    const settings = normalizeAgentSettings({
      edit: { writer: { enabled: false, temperature: 4, thinking_level: 'invalid', model: 'custom-model' } },
    })

    expect(settings.edit.writer.enabled).toBe(false)
    expect(settings.edit.writer.temperature).toBe(2)
    expect(settings.edit.writer.thinking_level).toBe('medium')
    expect(settings.edit.writer.model).toBe('custom-model')
  })

  it('returns a safe disabled configuration for unknown agents', () => {
    expect(agentSettingsFor({}, 'chat', 'missing').enabled).toBe(false)
  })
})
