// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  clearPendingWriteClarifications,
  getPendingWriteClarification,
  savePendingWriteClarification,
  stopSession,
  takePendingWriteClarification,
} from './sessions.server'

describe('pending write clarifications', () => {
  it('binds a pending turn to its session and allows it to be consumed once', () => {
    const pending = savePendingWriteClarification({
      sessionId: 'clarification-session',
      originalMessage: 'Write the ending.',
      context: 'The current scene ends at the station.',
      messages: [{ role: 'assistant', content: [] }],
      answers: {},
      rounds: 1,
      toolCallId: 'call-ask-user',
      toolInput: { questions: [] },
    })

    expect(pending.id).toBeTruthy()
    expect(pending.expiresAt).toBeGreaterThan(Date.now())
    expect(getPendingWriteClarification(pending.id, 'another-session')).toBeNull()
    expect(getPendingWriteClarification(pending.id, 'clarification-session')).toMatchObject({
      originalMessage: 'Write the ending.',
      context: 'The current scene ends at the station.',
    })
    expect(takePendingWriteClarification(pending.id, 'clarification-session')?.id).toBe(pending.id)
    expect(takePendingWriteClarification(pending.id, 'clarification-session')).toBeNull()
  })

  it('clears all pending questions for a cancelled or deleted session', () => {
    const sessionId = 'cancel-clarification-session'
    const first = savePendingWriteClarification({
      sessionId,
      originalMessage: 'Write the scene.',
      context: 'Scene context.',
      messages: [],
      answers: {},
      rounds: 1,
      toolCallId: 'call-one',
      toolInput: { questions: [] },
    })
    const second = savePendingWriteClarification({
      sessionId,
      originalMessage: 'Write another scene.',
      context: 'More context.',
      messages: [],
      answers: {},
      rounds: 1,
      toolCallId: 'call-two',
      toolInput: { questions: [] },
    })

    clearPendingWriteClarifications(sessionId)

    expect(getPendingWriteClarification(first.id, sessionId)).toBeNull()
    expect(getPendingWriteClarification(second.id, sessionId)).toBeNull()
  })

  it('clears pending questions when the session stop endpoint is used', () => {
    const pending = savePendingWriteClarification({
      sessionId: 'stopped-clarification-session',
      originalMessage: 'Write the scene.',
      context: 'Scene context.',
      messages: [],
      answers: {},
      rounds: 1,
      toolCallId: 'call-stop',
      toolInput: { questions: [] },
    })

    expect(stopSession('stopped-clarification-session')).toBe(false)
    expect(getPendingWriteClarification(pending.id, 'stopped-clarification-session')).toBeNull()
  })

  it('expires stale clarification turns before they can be resumed', () => {
    const pending = savePendingWriteClarification({
      sessionId: 'expired-clarification-session',
      originalMessage: 'Write the scene.',
      context: 'Scene context.',
      messages: [],
      answers: {},
      rounds: 1,
      toolCallId: 'call-expired',
      toolInput: { questions: [] },
    })
    pending.expiresAt = Date.now() - 1

    expect(takePendingWriteClarification(pending.id, pending.sessionId)).toBeNull()
  })
})
