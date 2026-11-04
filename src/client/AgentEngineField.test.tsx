/** @vitest-environment jsdom */
// Mesin agen: status jujur (terdeteksi / belum terpasang / belum login) dan "Periksa lagi" yang memuat ulang.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { AgentEngineField } from './AgentEngineField'

type Engine = CapabilitiesResponse['advanced']['agentEngine']
afterEach(cleanup)

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
    expect(status()).toBe('Terdeteksi: OpenCode')
  })

  it('tidak ada CLI: belum terpasang', () => {
    setup({ value: 'auto', detected: 'off' }, false)
    expect(status()).toMatch(/^Belum terpasang: pasang Claude Code atau OpenCode/)
  })

  it('terpasang tapi tidak siap: belum login; pilihan lain dari yang terdeteksi tidak diklaim terpasang', () => {
    setup({ value: 'auto', detected: 'claude' }, false)
    expect(status()).toMatch(/^Claude terpasang, tapi belum login/)
    cleanup()
    setup({ value: 'opencode', detected: 'claude' }, false)
    expect(status()).toBe('OpenCode belum siap: belum terpasang atau belum login.')
  })

  it('Periksa lagi memanggil redetect dan nonaktif selama memeriksa', async () => {
    const { redetect, finish } = setup({ value: 'auto', detected: 'claude' }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Periksa lagi' }))
    expect(redetect).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Memeriksa…' }) as HTMLButtonElement).disabled).toBe(true)
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Periksa lagi' })).toBeTruthy())
  })
})
