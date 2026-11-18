/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { CHALLENGE_BANNER } from '../shared/browser.challenge'
import type { BrowserChallenge } from '../shared/browser.challenge'
import BrowserChallengeBanner from './BrowserChallengeBanner'

afterEach(cleanup)
const CHECK: BrowserChallenge = { kind: 'google_unusual_traffic', url: 'https://www.google.com/sorry/index' }

describe('BrowserChallengeBanner', () => {
  it('says the site is checking for a human and that agents are paused; "I\'m done" calls onDone', () => {
    const onDone = vi.fn()
    render(<BrowserChallengeBanner challenge={CHECK} onDone={onDone} />)
    expect(screen.getByRole('status').textContent).toContain("This site is checking that you're human. Solve it here; agents are paused until you continue.")
    fireEvent.click(screen.getByRole('button', { name: CHALLENGE_BANNER.doneLabel }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('renders nothing on an ordinary page', () => {
    const { container } = render(<BrowserChallengeBanner challenge={undefined} onDone={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
