/** @vitest-environment jsdom */
// "Open in canvas browser" saat browser mati: host menampilkan tawaran, lalu membuka link begitu
// `openBrowserAt` terbit (kemampuan menyala, status browser dimuat ulang).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLinkOfferHost, requestBrowserOffer } from './browserLinkOffer'
import { NodeActionsProvider } from './nodeActions'
import type { NodeActions } from './nodeActions'
import { resetCapabilitiesCache } from './useCapabilities'

const caps = (status: string) => new Response(JSON.stringify({
  capabilities: [{ id: 'browser', title: 'Browser di kanvas', blurb: 'Buka halaman web sebagai node di kanvas.', status }], advanced: {},
}))
const actions = (openBrowserAt?: NodeActions['openBrowserAt']): NodeActions =>
  ({ onSession: vi.fn(), onToggleHideLinks: vi.fn(), openBrowserAt }) as unknown as NodeActions

beforeEach(resetCapabilitiesCache)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BrowserLinkOfferHost', () => {
  it('tawaran muncul atas permintaan; setelah Nyalakan link dibuka sekali begitu openBrowserAt ada', async () => {
    const f = vi.fn().mockResolvedValueOnce(caps('off')).mockResolvedValue(caps('on'))
    vi.stubGlobal('fetch', f)
    const tree = (a: NodeActions) => <NodeActionsProvider value={a}><BrowserLinkOfferHost /></NodeActionsProvider>
    const { rerender } = render(tree(actions()))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => requestBrowserOffer({ url: 'https://example.com/', anchorNodeId: 'n1' }))
    expect(await screen.findByRole('dialog', { name: 'Nyalakan Browser di kanvas' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Nyalakan' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const open = vi.fn(() => ({ status: 'created', nodeId: 'b1' }) as const)
    rerender(tree(actions(open)))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com/', anchorNodeId: 'n1' })
  })
})
