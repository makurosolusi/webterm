/** @vitest-environment jsdom */
// LoginForm and SetupForm on their own against a stubbed /auth/login and /auth/setup: the in-input
// show/hide toggle, the live password checklist and match check, inline errors (blur + submit) with
// aria wiring and focus, the in-flight state without double submit, autofill attributes, Enter submits.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_SETUP_PATH } from '../account.api.client'
import { LoginForm } from '../SignInForms'
import { SIGN_IN_TEXT } from '../signInLabels'
import { AUTH_LOGIN_PATH } from '../transportToken'
import { SetupForm } from './SetupForm'

let posts: { url: string; body: Record<string, unknown> }[] = []
let answer: () => Promise<Response>

beforeEach(() => {
  posts = []
  answer = async () => new Response(JSON.stringify({ user: { id: 1, username: 'ada' } }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return answer()
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const field = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } })
const flush = () => act(async () => { await Promise.resolve() })
const describedText = (id: string) => (field(id).getAttribute('aria-describedby') ?? '').split(' ').map((d) => document.getElementById(d)?.textContent ?? '').join(' | ')
const met = (label: string) => screen.getByText(label).closest('li')!.dataset.met

function setup(withCode = false) {
  const onDone = vi.fn()
  render(<SetupForm withCode={withCode} autoFocus onDone={onDone} onAlreadySetup={vi.fn()} />)
  return onDone
}

describe('SetupForm', () => {
  it('autofocuses the first field and asks the browser for a new password', () => {
    setup()
    expect(document.activeElement).toBe(field('setup-username'))
    expect(field('setup-username').autocomplete).toBe('username')
    expect(field('setup-password').autocomplete).toBe('new-password')
    expect(field('setup-confirm').autocomplete).toBe('new-password')
  })

  it('the show/hide toggle is an icon button inside each password input, with aria-pressed', () => {
    setup()
    const toggles = screen.getAllByRole('button', { name: SIGN_IN_TEXT.show('password') })
    expect(toggles).toHaveLength(1) // Password; Confirm has its own name
    const toggle = toggles[0]!
    expect(toggle.closest('.relative')?.contains(field('setup-password'))).toBe(true)
    expect(toggle.textContent).toBe('') // glyph only, the name is the aria-label (tooltip per policy)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(field('setup-password').type).toBe('text')
    expect(field('setup-confirm').type).toBe('password')
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.hide('password') }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.show('confirm password') })).toBeDefined()
  })

  it('the checklist ticks each requirement live and Confirm shows the match check', () => {
    setup()
    expect([met(SIGN_IN_TEXT.checkLength), met(SIGN_IN_TEXT.checkMatch)]).toEqual(['false', 'false'])
    type('setup-password', '12345678901')
    expect(met(SIGN_IN_TEXT.checkLength)).toBe('false')
    type('setup-password', '123456789012')
    expect(met(SIGN_IN_TEXT.checkLength)).toBe('true')
    expect(screen.queryByRole('img', { name: SIGN_IN_TEXT.matches })).toBeNull()
    type('setup-confirm', '123456789012')
    expect(met(SIGN_IN_TEXT.checkMatch)).toBe('true')
    expect(screen.getByRole('img', { name: SIGN_IN_TEXT.matches })).toBeDefined()
    expect(describedText('setup-password')).toContain(SIGN_IN_TEXT.checkLength)
    type('setup-confirm', '12345678901x')
    expect(met(SIGN_IN_TEXT.checkMatch)).toBe('false')
  })

  it('blur shows a format error once the field was typed in; fixing it clears the error', () => {
    setup()
    fireEvent.blur(field('setup-password')) // empty and untouched: stays quiet
    expect(field('setup-password').getAttribute('aria-invalid')).toBeNull()
    type('setup-username', 'a b')
    fireEvent.blur(field('setup-username'))
    expect(field('setup-username').getAttribute('aria-invalid')).toBe('true')
    expect(describedText('setup-username')).toContain(SIGN_IN_TEXT.invalidUsername)
    type('setup-username', 'ada')
    expect(field('setup-username').getAttribute('aria-invalid')).toBeNull()
  })

  it('an empty submit shows every error inline, focuses the first invalid field and sends nothing', async () => {
    setup(true)
    const create = screen.getByRole('button', { name: SIGN_IN_TEXT.create }) as HTMLButtonElement
    expect(create.disabled).toBe(false) // enabled: the submit is what explains what is missing
    fireEvent.click(create)
    await flush()
    expect(document.activeElement).toBe(field('setup-remote-code'))
    expect(describedText('setup-remote-code')).toContain(SIGN_IN_TEXT.needCode)
    expect(describedText('setup-remote-username')).toContain(SIGN_IN_TEXT.needUsername)
    expect(describedText('setup-remote-password')).toContain(SIGN_IN_TEXT.weakPassword)
    expect(describedText('setup-remote-confirm')).toContain(SIGN_IN_TEXT.needConfirm)
    for (const id of ['code', 'username', 'password', 'confirm']) expect(field(`setup-remote-${id}`).getAttribute('aria-invalid')).toBe('true')
    expect(posts).toEqual([])
    type('setup-remote-code', 'ABCD')
    fireEvent.click(create)
    await flush()
    expect(document.activeElement).toBe(field('setup-remote-username'))
  })

  it('while creating: spinner + "Creating account…", fields frozen, a second submit sends nothing', async () => {
    let finish: (r: Response) => void = () => undefined
    answer = () => new Promise((r) => { finish = r })
    const onDone = setup()
    type('setup-username', 'ada')
    type('setup-password', 'long enough passphrase')
    type('setup-confirm', 'long enough passphrase')
    fireEvent.submit(field('setup-username').form!) // Enter in a field submits the form
    await flush()
    const busy = screen.getByRole('button', { name: SIGN_IN_TEXT.creating })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.querySelector('.codicon-modifier-spin')).not.toBeNull()
    expect(field('setup-password').readOnly).toBe(true)
    fireEvent.click(busy)
    await flush()
    expect(posts).toEqual([{ url: AUTH_SETUP_PATH, body: { username: 'ada', password: 'long enough passphrase' } }])
    await act(async () => { finish(new Response(JSON.stringify({ user: { id: 1, username: 'ada' } }), { status: 201 })) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a server refusal lands in the alert above the button, with the retry time for 429', async () => {
    answer = async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '7' } })
    setup()
    type('setup-username', 'ada')
    type('setup-password', 'long enough passphrase')
    type('setup-confirm', 'long enough passphrase')
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.create }))
    await flush()
    await flush()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(SIGN_IN_TEXT.tooMany(7))
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: SIGN_IN_TEXT.create }))
  })
})

describe('LoginForm', () => {
  it('autofocus, current-password autofill, inline required errors with focus, Enter submits', async () => {
    const onDone = vi.fn()
    render(<LoginForm onDone={onDone} />)
    expect(document.activeElement).toBe(field('signin-username'))
    expect(field('signin-password').autocomplete).toBe('current-password')
    const button = screen.getByRole('button', { name: SIGN_IN_TEXT.signIn })
    expect(button.getAttribute('type')).toBe('submit')
    expect((button as HTMLButtonElement).form).toBe(field('signin-password').form)
    fireEvent.click(button)
    await flush()
    expect(describedText('signin-username')).toContain(SIGN_IN_TEXT.needUsername)
    expect(describedText('signin-password')).toContain(SIGN_IN_TEXT.needPassword)
    expect(posts).toEqual([])
    type('signin-username', 'ada')
    fireEvent.submit(field('signin-username').form!)
    await flush()
    expect(document.activeElement).toBe(field('signin-password'))
    type('signin-password', 'correct horse battery')
    fireEvent.submit(field('signin-password').form!)
    await flush()
    await flush()
    expect(posts).toEqual([{ url: AUTH_LOGIN_PATH, body: { username: 'ada', password: 'correct horse battery' } }])
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
