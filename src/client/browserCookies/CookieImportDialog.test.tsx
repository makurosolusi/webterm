/** @vitest-environment jsdom */
// Import dialog: detection, preview with per-site pick, Google blocked inline, results, errors per kind, focus and
// Escape rules, stored cookies (remove / clear all with confirm). The cookie value canary must never reach the DOM or logs.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CookiePreviewResp } from '../../shared/browser.contract'
import { BrowserApiError } from '../browser.api'
import { OPEN_SETTINGS_EVENT } from '../settings.link'
import CookieImportDialog from './CookieImportDialog'
import type { CookieTarget } from './cookieImport.target'
import { CI } from './cookieImport.text'

const CANARY = 'CANARY-COOKIE-VALUE-123' // test-only: synthetic value that must never be shown or logged
const TAB = '\t'
const JSON_FILE = `{"cookies":[{"name":"a","value":"${CANARY}","domain":"a.com"}]}`
const NETSCAPE_FILE = `# Netscape HTTP Cookie File\n.a.com${TAB}TRUE${TAB}/${TAB}TRUE${TAB}1900000000${TAB}sid${TAB}${CANARY}\n`
const PREVIEW: CookiePreviewResp = {
  previewId: 'p1', expiresAt: 1, googleSkipped: 3,
  domains: [{ domain: 'a.com', count: 2, hasSession: true }, { domain: 'b.org', count: 1, hasSession: false }],
  blocked: [{ domain: 'google.com', count: 3, reason: 'google_source_bound' }],
}

function target(over: Partial<CookieTarget> = {}): CookieTarget {
  return {
    name: 'Work',
    list: vi.fn().mockResolvedValue([{ domain: 'old.net', count: 3, expiresAt: Date.now() + 6.5 * 86_400_000 }]),
    preview: vi.fn().mockResolvedValue(PREVIEW),
    commit: vi.fn().mockResolvedValue({ imported: 2, domains: ['a.com'] }),
    clear: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}
const mount = (t = target(), onClose = vi.fn(), onChanged = vi.fn()) => {
  render(<CookieImportDialog target={t} onClose={onClose} onChanged={onChanged} />)
  return { t, onClose, onChanged, dialog: screen.getByRole('dialog') }
}
const upload = (content: string, name = 'c.json') =>
  fireEvent.change(screen.getByTestId('cookie-file-input'), { target: { files: [new File([content], name)] } })
const uploaded = async (content = JSON_FILE, name = 'c.json') => { upload(content, name); await screen.findByText(CI.preview.heading) }

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CookieImportDialog structure', () => {
  it('names the target, uses a calm Alert for the warning and folds the detail', async () => {
    const { dialog } = mount()
    expect(within(dialog).getByRole('heading', { name: CI.title })).toBeTruthy()
    expect(within(dialog).getByText(CI.into('Work'))).toBeTruthy()
    const alert = dialog.querySelector('[data-slot=alert]') as HTMLElement
    expect(alert.textContent).toContain(CI.security.title)
    expect(alert.className).not.toMatch(/errorForeground|destructive/)
    expect(dialog.innerHTML).not.toContain('text-(--vscode-errorForeground)') // red is for real errors only
    expect(screen.queryByText(CI.security.detail)).toBeNull()
    const more = within(alert).getByRole('button', { name: CI.security.more })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(screen.getByText(CI.security.detail)).toBeTruthy()
  })

  it('has no native select, details or visible file input; help is a Collapsible with source steps', () => {
    const { dialog } = mount()
    expect(dialog.querySelector('select, details')).toBeNull()
    const input = screen.getByTestId('cookie-file-input')
    expect(input.className).toContain('sr-only')
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText(CI.drop.hint).id)
    const help = within(dialog).getByRole('button', { name: CI.help.summary })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(help)
    for (const s of CI.help.steps) expect(screen.getByText(s.title + '.')).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/yt-dlp/)
  })

  it('focuses "Choose file…" first, and shows stored cookies with a relative expiry', async () => {
    mount()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: CI.drop.choose })))
    expect(await screen.findByText(/old\.net/)).toBeTruthy()
    expect(screen.getByText(/3 cookies · expires in \d+ days/)).toBeTruthy()
  })
})

describe('detection and preview', () => {
  it('detects JSON, previews domains with counts, ticks every importable site, and never shows a value', async () => {
    const { t, dialog } = mount()
    await uploaded()
    expect(t.preview).toHaveBeenCalledWith({ format: 'storageState', content: JSON_FILE })
    expect(within(dialog).getByText(CI.format.detected('storageState'))).toBeTruthy()
    expect(within(dialog).getByText(CI.preview.summary(3, 2))).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: CI.action.import(3) })).toBeTruthy()
    expect(dialog.innerHTML).not.toContain(CANARY)
  })

  it('detects Netscape and sends that format', async () => {
    const { t } = mount()
    await uploaded(NETSCAPE_FILE, 'cookies.txt')
    expect(t.preview).toHaveBeenCalledWith(expect.objectContaining({ format: 'netscape' }))
    expect(screen.getByText(CI.format.detected('netscape'))).toBeTruthy()
  })

  it('asks for a format (and does not call the server) when detection is ambiguous', async () => {
    const { t } = mount()
    upload('hello there', 'notes.txt')
    expect(await screen.findByText(CI.errors.invalid.title)).toBeTruthy()
    expect(screen.getByText(CI.format.label)).toBeTruthy()
    expect(t.preview).not.toHaveBeenCalled()
  })

  it('flags Google domains inline with the reason, does not block the rest, and cannot tick them', async () => {
    mount()
    await uploaded()
    const row = screen.getByText('google.com').closest('li') as HTMLElement
    expect(row.textContent).toContain(CI.preview.blocked.google_source_bound)
    expect((within(row).getByRole('checkbox') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: CI.action.import(3) })).toBeTruthy()
  })

  it('sends only the picked sites; the count follows the picks; zero disables with a reason', async () => {
    const { t } = mount()
    await uploaded()
    fireEvent.click(screen.getByRole('checkbox', { name: CI.preview.pick('a.com') }))
    const btn = screen.getByRole('button', { name: CI.action.import(1) }) as HTMLButtonElement
    fireEvent.click(screen.getByRole('button', { name: CI.preview.selectNone }))
    expect((screen.getByRole('button', { name: CI.action.import(0) }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(CI.action.pickOne)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: CI.preview.selectAll }))
    fireEvent.click(screen.getByRole('checkbox', { name: CI.preview.pick('b.org') }))
    fireEvent.click(screen.getByRole('button', { name: CI.action.import(2) }))
    await screen.findByText(CI.result.title)
    expect(t.commit).toHaveBeenCalledExactlyOnceWith({ previewId: 'p1', domains: ['a.com'] })
    expect(btn).toBeTruthy()
  })

  it('shows a filter only for long lists', async () => {
    const many = { ...PREVIEW, domains: Array.from({ length: 9 }, (_, i) => ({ domain: `s${i}.com`, count: 1, hasSession: false })) }
    mount(target({ preview: vi.fn().mockResolvedValue(many) }))
    await uploaded()
    fireEvent.change(screen.getByLabelText(CI.preview.filter), { target: { value: 's3' } })
    expect(screen.queryByText('s4.com')).toBeNull()
    expect(screen.getByText('s3.com')).toBeTruthy()
  })
})

describe('result and errors', () => {
  it('summarizes imported sites, skipped cookies with the reason, and offers Done / Import another', async () => {
    const { onClose, onChanged } = mount()
    await uploaded()
    fireEvent.click(screen.getByRole('button', { name: CI.action.import(3) }))
    expect(await screen.findByText(CI.result.imported(2, 1))).toBeTruthy()
    expect(screen.getByText(CI.result.skipped(3))).toBeTruthy()
    expect(screen.getByText(CI.result.reasons.google_source_bound)).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: CI.result.another }))
    expect(screen.getByRole('button', { name: CI.drop.choose })).toBeTruthy()
    upload(JSON_FILE)
    await screen.findByText(CI.preview.heading)
    fireEvent.click(screen.getByRole('button', { name: CI.action.cancel }))
    expect(screen.getByRole('button', { name: CI.drop.choose })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rejects an oversized file and a wrong type before any request', async () => {
    const { t } = mount()
    const big = new File(['x'], 'big.json')
    Object.defineProperty(big, 'size', { value: 2_000_000 })
    fireEvent.change(screen.getByTestId('cookie-file-input'), { target: { files: [big] } })
    expect(await screen.findByText(CI.errors.too_large.title)).toBeTruthy()
    upload('x', 'pic.png')
    expect(await screen.findByText(CI.errors.wrong_type.title)).toBeTruthy()
    expect(t.preview).not.toHaveBeenCalled()
  })

  it.each([
    ['bad_request', 400, 'invalid'], ['cookie_import_empty', 400, 'empty'], ['payload_too_large', 413, 'too_large'], ['not_found', 404, 'expired'],
  ] as const)('shows specific copy and a next step for %s', async (code, status, kind) => {
    mount(target({ preview: vi.fn().mockRejectedValue(new BrowserApiError(`x ${CANARY}`, status, code)) }))
    upload(JSON_FILE)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(CI.errors[kind].title)
    expect(alert.textContent).toContain(CI.errors[kind].body)
    expect(document.body.innerHTML).not.toContain(CANARY)
  })

  it('says the network failed on a failed fetch', async () => {
    mount(target({ preview: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }))
    upload(JSON_FILE)
    expect((await screen.findByRole('alert')).textContent).toContain(CI.errors.network.title)
  })

  it('cookie_import_disabled shows the explanation, a Settings link and no file zone', async () => {
    const seen: unknown[] = []
    window.addEventListener(OPEN_SETTINGS_EVENT, (e) => seen.push((e as CustomEvent).detail), { once: true })
    const { onClose } = mount(target({ preview: vi.fn().mockRejectedValue(new BrowserApiError('x', 404, 'cookie_import_disabled')) }))
    upload(JSON_FILE)
    expect(await screen.findByText(CI.errors.disabled.title)).toBeTruthy()
    expect(screen.queryByTestId('cookie-file-input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: CI.settings }))
    expect(seen).toEqual([{ section: 'browser', field: 'browser-profiles' }])
    expect(onClose).toHaveBeenCalled()
  })
})

describe('busy and Escape', () => {
  it('locks inputs and ignores Escape while importing, then closes on Escape when idle', async () => {
    let finish: (v: { imported: number; domains: string[] }) => void = () => {}
    const { onClose } = mount(target({ commit: vi.fn(() => new Promise<{ imported: number; domains: string[] }>((r) => { finish = r })) }))
    await uploaded()
    fireEvent.click(screen.getByRole('button', { name: CI.action.import(3) }))
    expect((await screen.findByRole('button', { name: CI.action.importing }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: CI.preview.pick('a.com') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    finish({ imported: 2, domains: ['a.com'] })
    await screen.findByText(CI.result.title)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('stored cookies', () => {
  it('removes one site, and clears all only after confirmation', async () => {
    const { t } = mount()
    fireEvent.click(await screen.findByRole('button', { name: CI.stored.remove('old.net') }))
    await waitFor(() => expect(t.clear).toHaveBeenCalledWith('old.net'))
    expect(await screen.findByText(CI.stored.removed('old.net'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: CI.stored.clearAll }))
    expect(t.clear).toHaveBeenCalledTimes(1) // not yet: the confirmation comes first
    fireEvent.click(await screen.findByRole('button', { name: CI.stored.confirm }))
    await waitFor(() => expect(t.clear).toHaveBeenLastCalledWith(undefined))
  })

  it('shows the empty state with its hint', async () => {
    mount(target({ list: vi.fn().mockResolvedValue([]) }))
    expect(await screen.findByText(CI.stored.empty)).toBeTruthy()
  })
})
