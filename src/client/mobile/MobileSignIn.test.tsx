/** @vitest-environment jsdom */
// /m signed out: username + password (the desktop's LoginForm, same /auth/login), no token field;
// before the first account exists it hands off to the computer instead of offering a form.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGN_IN_TEXT } from '../signInLabels'
import { AUTH_LOGIN_PATH, AUTH_ME_PATH } from '../transportToken'
import { MobileApp } from './MobileApp'

function serve(setupRequired: boolean, login: { status: number; body?: unknown }) {
  const posts: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === AUTH_ME_PATH) return new Response(JSON.stringify({ signedIn: false, setupRequired, user: null, tokenSignIn: setupRequired }), { status: 200 })
    if (url === AUTH_LOGIN_PATH) {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(login.body ?? {}), { status: login.status })
    }
    return new Response(JSON.stringify({ error: 'not_signed_in' }), { status: 401 }) // every /api call while signed out
  }))
  return posts
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MobileApp sign-in', () => {
  it('signs in with username + password: 401 explains, 200 reloads', async () => {
    const posts = serve(false, { status: 401, body: { error: 'invalid_credentials' } })
    const reload = vi.fn()
    render(<MobileApp reload={reload} />)
    const user = (await screen.findByLabelText(SIGN_IN_TEXT.usernameLabel)) as HTMLInputElement
    expect(user.autocomplete).toBe('username')
    expect(screen.queryByLabelText(/token/i)).toBeNull()
    fireEvent.change(user, { target: { value: 'ada' } })
    fireEvent.change(screen.getByLabelText(SIGN_IN_TEXT.passwordLabel), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    expect((await screen.findByRole('alert')).textContent).toBe(SIGN_IN_TEXT.wrongCredentials)
    serve(false, { status: 200, body: { user: { id: 1, username: 'ada' } } })
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(posts[0]!.body).toEqual({ username: 'ada', password: 'nope' })
  })

  it('no account yet: says to create it on the computer first, no form', async () => {
    serve(true, { status: 409 })
    render(<MobileApp reload={vi.fn()} />)
    expect(await screen.findByText(SIGN_IN_TEXT.mobileSetup)).toBeTruthy()
    expect(screen.queryByLabelText(SIGN_IN_TEXT.passwordLabel)).toBeNull()
  })
})
