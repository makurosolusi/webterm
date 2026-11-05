/** @vitest-environment jsdom */
// Mesin agen: status jujur (terdeteksi / belum terpasang / belum login) dan "Check again" yang memuat ulang.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { AgentEngineField } from './AgentEngineField'

type Engine = CapabilitiesResponse['advanced']['agentEngine']
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const setup = (engine: Engine, ready?: boolean) => {
  let finish: () => void = () => undefined
  const redetect = vi.fn(() => new Promise<void>((r) => { finish = r }))
  const save = vi.fn(async (_v: Engine['value']) => undefined)
  render(<AgentEngineField engine={engine} ready={ready} save={save} redetect={redetect} />)
  return { redetect, save, finish: () => finish() }
}
const status = (): string => screen.getByRole('status').textContent ?? ''

describe('AgentEngineField', () => {
  it('belum diperiksa / siap: menyebut mesin terdeteksi', () => {
    setup({ value: 'auto', detected: 'opencode' })
    expect(status()).toBe('Detected: OpenCode')
  })

  it('tidak ada CLI: belum terpasang', () => {
    setup({ value: 'auto', detected: 'off' })
    expect(status()).toBe('Not installed: install Claude Code, then check again.')
  })

  it('Claude not ready: shows the Central launch profile and the failing stage, not "not signed in"', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: false, profile: { id: 'm', name: 'Malik' }, failed: 'wrapper_not_found', warnings: [],
      steps: [{ stage: 'wrapper', ok: false, message: 'envman not found on PATH', hint: 'Install it on the server, or fix the command in the launch profile.' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened)
    setup({ value: 'auto', detected: 'claude' }, false)
    expect(await screen.findByText('Launch profile: Malik')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Launch test result' }).textContent).toContain('envman not found on PATH')
    expect(screen.queryByText(/not signed in/)).toBeNull()
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ central: true })
    fireEvent.click(screen.getByRole('button', { name: 'Edit launch profile' }))
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'agent' })
    window.removeEventListener('webterm:open-settings', opened)
  })

  it('a chosen non-Claude engine keeps the generic sentence; OpenCode is offered only to whoever chose it', () => {
    setup({ value: 'opencode', detected: 'claude' }, false)
    expect(status()).toBe('OpenCode is not ready: it is not installed or not signed in.')
    cleanup()
    setup({ value: 'auto', detected: 'claude' })
    expect(screen.queryByRole('option', { name: /OpenCode/ })).toBeNull()
  })

  it('Check again memanggil redetect dan nonaktif selama memeriksa', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const { redetect, finish } = setup({ value: 'auto', detected: 'claude' }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(redetect).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(true)
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy())
  })
})
