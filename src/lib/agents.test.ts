import { describe, expect, it } from 'vitest'
import { agentSettingsFor, defaultAgentSettings, normalizeAgentSettings, resolveAgentModel } from './agents'

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

  it('resolves default and configured model references at run time', () => {
    const settings = { endpoints: { local: { model: 'configured-model' } }, harnesses: { pi: { model: 'harness-model' } } }
    expect(resolveAgentModel(settings, { ...defaultAgentSettings().chat.chat, model_ref: 'default' }, 'active-model')).toBe('active-model')
    expect(resolveAgentModel(settings, { ...defaultAgentSettings().chat.chat, model_ref: 'endpoint:local' }, 'active-model')).toBe('configured-model')
    expect(resolveAgentModel(settings, { ...defaultAgentSettings().chat.chat, model_ref: 'harness:pi' }, 'active-model')).toBe('harness-model')
  })
})
