/** @vitest-environment jsdom */
// Dialog cookie: hanya domain+jumlah di DOM (canary), Import nonaktif sebelum pilih, peringatan, hapus, gate flag.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const api = vi.hoisted(() => ({
  listCookieDomains: vi.fn(), previewCookies: vi.fn(), commitCookies: vi.fn(), clearCookies: vi.fn(),
}))
vi.mock('./browser.api', async (orig) => ({ ...(await orig<typeof import('./browser.api')>()), ...api }))

import BrowserCookieDialog from './BrowserCookieDialog'
import { BrowserApiError } from './browser.api'
import { COOKIE_TEXT as T } from './browser.uxText'

const CANARY = 'CANARY-SECRET-VALUE-123'
const PREVIEW = { previewId: 'p1', expiresAt: 1, domains: [{ domain: 'a.com', count: 2, hasSession: true }, { domain: 'b.org', count: 1, hasSession: false }] }

beforeEach(() => {
  api.listCookieDomains.mockResolvedValue({ domains: [{ domain: 'old.net', count: 3 }] })
  api.previewCookies.mockResolvedValue(PREVIEW)
  api.commitCookies.mockResolvedValue({ imported: 2, domains: ['a.com'] })
  api.clearCookies.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const open = (props: Partial<Parameters<typeof BrowserCookieDialog>[0]> = {}) =>
  render(<BrowserCookieDialog cookieImportEnabled workspaceId="w1" open onClose={vi.fn()} {...props} />)

async function upload(content = `{"cookies":[{"value":"${CANARY}"}]}`) {
  const input = screen.getByLabelText(T.fileLabel) as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([content], 'c.json')] } })
  await screen.findByText(T.domainsHeading)
}

describe('BrowserCookieDialog', () => {
  it('renders nothing and makes no request when cookie import is disabled', () => {
    open({ cookieImportEnabled: false })
    expect(document.body.textContent).not.toContain(T.title)
    expect(api.listCookieDomains).not.toHaveBeenCalled()
  })

  it('shows the explicit warning and the stored domains with counts', async () => {
    open()
    expect(screen.getByRole('note').textContent).toBe(T.warning)
    expect(await screen.findByText(`old.net · ${T.cookieCount(3)}`)).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('previews domains only, keeps Import disabled until one is picked, and the canary never reaches the DOM', async () => {
    open()
    await upload()
    expect(api.previewCookies).toHaveBeenCalledWith('w1', { format: 'storageState', content: expect.stringContaining(CANARY) })
    expect(document.body.innerHTML).not.toContain(CANARY)
    expect(screen.getByText('a.com')).toBeTruthy()
    const importBtn = screen.getByRole('button', { name: T.import }) as HTMLButtonElement
    expect(importBtn.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(T.selectLabel('a.com')))
    expect(importBtn.disabled).toBe(false)
  })

  it('commits only the picked subset and reports the result', async () => {
    open()
    await upload()
    fireEvent.click(screen.getByLabelText(T.selectLabel('a.com')))
    fireEvent.click(screen.getByRole('button', { name: T.import }))
    await screen.findByText(T.imported(2, 1))
    expect(api.commitCookies).toHaveBeenCalledExactlyOnceWith('w1', { previewId: 'p1', domains: ['a.com'] })
    expect(screen.queryByText(T.domainsHeading)).toBeNull()
    expect(document.body.innerHTML).not.toContain(CANARY)
  })

  it('select-all picks every domain', async () => {
    open()
    await upload()
    fireEvent.click(screen.getByLabelText(T.selectAll))
    fireEvent.click(screen.getByRole('button', { name: T.import }))
    await waitFor(() => expect(api.commitCookies).toHaveBeenCalled())
    expect(api.commitCookies.mock.calls[0]![1].domains).toEqual(['a.com', 'b.org'])
  })

  it('removes one domain, or all', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: T.removeLabel('old.net') }))
    await waitFor(() => expect(api.clearCookies).toHaveBeenCalledWith('w1', 'old.net'))
    fireEvent.click(await screen.findByRole('button', { name: T.removeAll }))
    await waitFor(() => expect(api.clearCookies).toHaveBeenLastCalledWith('w1', undefined))
  })

  it('rejects an oversized file client-side without uploading', async () => {
    open()
    const big = new File(['x'], 'big.json')
    Object.defineProperty(big, 'size', { value: 2_000_000 })
    fireEvent.change(screen.getByLabelText(T.fileLabel), { target: { files: [big] } })
    expect((await screen.findByRole('alert')).textContent).toBe(T.tooLarge)
    expect(api.previewCookies).not.toHaveBeenCalled()
  })

  it('shows a fixed message for a server error, never the response detail', async () => {
    api.previewCookies.mockRejectedValue(new BrowserApiError(`POST failed ${CANARY}`, 400, 'bad_request'))
    open()
    fireEvent.change(screen.getByLabelText(T.fileLabel), { target: { files: [new File(['{}'], 'c.json')] } })
    expect((await screen.findByRole('alert')).textContent).toBe(T.errors.bad_request)
    expect(document.body.innerHTML).not.toContain(CANARY)
  })
})
