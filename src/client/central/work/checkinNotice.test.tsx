/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ChatMessages from '../../chat/chatMessages'
import type { ChatMessage } from '../../chat/chatTypes'

afterEach(cleanup)

describe('self-started check-in in the chat', () => {
  it('reads as a system notice, not as something the user said', () => {
    const notice: ChatMessage = { id: 's1', role: 'system', seq: 1, state: 'complete', parts: [{ type: 'text', text: 'Central checked in: task Login stalled' }] }
    render(<ChatMessages messages={[notice]} streaming={false} />)
    const row = screen.getByLabelText('system message')
    expect(within(row).getByText('System').className).toBe('chat-message__role')
    expect(within(row).getByText('Central checked in: task Login stalled')).toBeTruthy()
    expect(row.classList.contains('chat-bubble-row')).toBe(false)
    expect(screen.queryByLabelText('human message')).toBeNull()
    expect(screen.queryByText('You said:')).toBeNull()
  })
})
