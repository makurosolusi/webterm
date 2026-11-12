import { describe, expect, it } from 'vitest'
import { ChatApiError, RUNTIME_UNAVAILABLE_MESSAGE, chatErrorMessage } from './chatTransport'

describe('chatErrorMessage', () => {
  it('maps runtime_unavailable to friendly text regardless of HTTP status', () => {
    for (const status of [409, 500, 503]) {
      expect(chatErrorMessage(new ChatApiError('x', status, 'runtime_unavailable'))).toBe(RUNTIME_UNAVAILABLE_MESSAGE)
    }
    expect(RUNTIME_UNAVAILABLE_MESSAGE).toContain('Claude Code')
  })

  it('keeps the existing messages unchanged', () => {
    const msg = (status: number, code: string) => chatErrorMessage(new ChatApiError('x', status, code))
    expect(msg(401, 'x')).toBe('Not allowed. Reload and sign in again.')
    expect(msg(409, 'conversation_busy')).toBe('Another turn is running. Stop it or wait for it to finish.')
    expect(msg(503, 'central_runtime_off')).toBe('Central needs Claude. Set up Claude in Settings › Claude and press Test.')
    expect(msg(409, 'turn_not_active')).toBe('This turn already finished.')
    expect(msg(404, 'conversation_not_found')).toBe('This conversation no longer exists.')
    expect(msg(404, 'http_404')).toBe('Central chat is not enabled on this server.')
    expect(msg(500, 'central_chat_internal')).toBe('The server could not answer. Try again.')
    expect(msg(502, 'whatever')).toBe('The server could not answer. Try again.')
    expect(msg(400, 'whatever')).toBe('The message could not be sent.')
    expect(chatErrorMessage(new TypeError('f'))).toBe('Could not reach the server.')
    expect(chatErrorMessage('boom')).toBe('Something went wrong. Try again.')
  })
})
