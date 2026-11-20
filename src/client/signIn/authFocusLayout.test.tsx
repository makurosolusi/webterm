/** @vitest-environment jsdom */
// Focus after a server answer (409 -> Sign in button, 429 / network -> the alert), the 320px layout
// guards (min-w-0, wrapping text) and the sign-in.css rules (reduced motion, contrast tokens).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '../SignInForms'
import { SIGN_IN_TEXT } from '../signInLabels'
import { SetupForm } from './SetupForm'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const flush = () => act(async () => { await Promise.resolve() })
const reply = (answer: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(async () => answer()))
const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
const fillSetup = () => { type('setup-username', 'ada'); type('setup-password', 'long enough passphrase'); type('setup-confirm', 'long enough passphrase') }
const submit = async (name: string) => { fireEvent.click(screen.getByRole('button', { name })); await flush(); await flush() }

describe('focus after a server answer', () => {
  it('409 already_setup focuses the Sign in button', async () => {
    reply(async () => new Response(JSON.stringify({ error: 'already_setup' }), { status: 409 }))
    render(<SetupForm onDone={vi.fn()} onAlreadySetup={vi.fn()} />)
    fillSetup()
    await submit(SIGN_IN_TEXT.create)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
  })

  it('429 and a network failure focus the alert (tabindex -1) on setup and sign-in', async () => {
    reply(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }))
    render(<SetupForm onDone={vi.fn()} onAlreadySetup={vi.fn()} />)
    fillSetup()
    await submit(SIGN_IN_TEXT.create)
    expect(document.activeElement).toBe(screen.getByRole('alert'))
    expect(screen.getByRole('alert').getAttribute('tabindex')).toBe('-1')
    cleanup()
    reply(async () => { throw new TypeError('Failed to fetch') })
    render(<LoginForm onDone={vi.fn()} />)
    type('signin-username', 'ada')
    type('signin-password', 'pw')
    await submit(SIGN_IN_TEXT.signIn)
    expect(document.activeElement).toBe(screen.getByRole('alert'))
  })

  it('a wrong password does not steal focus from the form', async () => {
    reply(async () => new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 401 }))
    render(<LoginForm onDone={vi.fn()} />)
    type('signin-username', 'ada')
    type('signin-password', 'pw')
    await submit(SIGN_IN_TEXT.signIn)
    expect(document.activeElement).not.toBe(screen.getByRole('alert'))
  })
})

describe('320px layout', () => {
  it('fields and forms may shrink and long hints, errors and alerts wrap', async () => {
    reply(async () => new Response('{}', { status: 502 }))
    const { container } = render(<SetupForm onDone={vi.fn()} onAlreadySetup={vi.fn()} />)
    const form = container.querySelector('form')!
    expect(form.className).toMatch(/\bmin-w-0\b/)
    expect(form.className).toMatch(/\bmax-w-full\b/)
    const input = document.getElementById('setup-username')!
    expect(input.parentElement!.className).toMatch(/\bmin-w-0\b/)
    expect(input.parentElement!.parentElement!.className).toMatch(/\bmin-w-0\b/)
    expect(screen.getByText(SIGN_IN_TEXT.usernameHint).className).toMatch(/\bbreak-words\b/)
    // The password input reserves room for the 44px toggle, so the toggle never presses into the text.
    expect(document.getElementById('setup-password')!.className).toMatch(/\bpr-12\b|\bpr-24\b/)
    fillSetup()
    await submit(SIGN_IN_TEXT.create)
    expect(screen.getByText(SIGN_IN_TEXT.unreachable).className).toMatch(/\bbreak-words\b/)
  })
})

describe('sign-in.css', () => {
  const css = readFileSync(join(__dirname, '..', 'sign-in.css'), 'utf8')
  it('stops the spinner under prefers-reduced-motion', () => {
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(rm).toMatch(/\.codicon-modifier-spin\s*\{\s*animation:\s*none/)
  })
  it('colours the met checklist items with a token that has contrast on light and dark, not a hardcoded hex', () => {
    expect(css).toMatch(/data-met='true'\]\s*\{\s*color:\s*var\(--vscode-gitDecoration-addedResourceForeground\)/)
    expect(css).not.toMatch(/charts-green|#89d185/)
  })
})
