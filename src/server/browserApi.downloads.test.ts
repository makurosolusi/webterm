import { describe, expect, it, vi } from 'vitest'
import { downloadsRoute } from './browserApi.downloads'
import type { DownloadsApiDeps } from './browserApi.downloads'
import { handleBrowserApi } from './browserApi'
import type { BrowserApiDeps } from './browserApi'
import { attachmentHeader } from './routes/browser.routes'

const deps = (o: Partial<DownloadsApiDeps> = {}): DownloadsApiDeps => ({
  list: vi.fn(() => []), cancel: vi.fn(() => true), remove: vi.fn(() => true), keep: vi.fn(() => true), file: vi.fn(() => ({ path: '/data/downloads/p/a.txt', name: 'a.txt' })), ...o,
})

describe('downloadsRoute', () => {
  it('lists the node\'s downloads', () => {
    const d = deps({ list: vi.fn(() => [{ id: 'g1' } as never]) })
    expect(downloadsRoute('GET', 'n1', [], d)).toEqual({ status: 200, body: { items: [{ id: 'g1' }] } })
    expect(d.list).toHaveBeenCalledWith('n1')
  })

  it('cancel, keep and remove answer 204 and 404 for an unknown id', () => {
    const d = deps({ cancel: vi.fn(() => false) })
    expect(downloadsRoute('POST', 'n1', ['g1', 'keep'], d)).toEqual({ status: 204 })
    expect(downloadsRoute('DELETE', 'n1', ['g1'], d)).toEqual({ status: 204 })
    expect(downloadsRoute('POST', 'n1', ['g1', 'cancel'], d)).toMatchObject({ status: 404 })
    expect(d.keep).toHaveBeenCalledWith('n1', 'g1')
    expect(d.remove).toHaveBeenCalledWith('n1', 'g1')
  })

  it('reveal-path returns only the location; nothing is opened', () => {
    expect(downloadsRoute('GET', 'n1', ['g1', 'path'], deps())).toEqual({ status: 200, body: { path: '/data/downloads/p/a.txt' } })
  })

  it('export hands the stored file to the route as an attachment source, GET only', () => {
    expect(downloadsRoute('GET', 'n1', ['g1', 'file'], deps())).toEqual({ status: 200, file: { path: '/data/downloads/p/a.txt', name: 'a.txt' } })
    expect(downloadsRoute('POST', 'n1', ['g1', 'file'], deps())).toMatchObject({ status: 405 })
    expect(downloadsRoute('GET', 'n1', ['g1', 'file'], deps({ file: vi.fn(() => undefined) }))).toMatchObject({ status: 404 })
  })

  it('rejects a bad node id, a bad download id and wrong methods before touching anything', () => {
    const d = deps()
    expect(downloadsRoute('GET', '../x', [], d)).toMatchObject({ status: 400 })
    for (const id of ['../g1', 'a b', 'g1%2f', 'x'.repeat(65)]) expect(downloadsRoute('GET', 'n1', [id, 'file'], d)).toMatchObject({ status: 400 })
    expect(downloadsRoute('PUT', 'n1', [], d)).toMatchObject({ status: 405 })
    expect(downloadsRoute('GET', 'n1', ['g1'], d)).toMatchObject({ status: 405 })
    expect(downloadsRoute('GET', 'n1', ['g1', 'nope'], d)).toBeNull()
    expect(downloadsRoute('GET', 'n1', ['g1', 'file', 'extra'], d)).toBeNull()
    expect(d.file).not.toHaveBeenCalled()
    expect(d.list).not.toHaveBeenCalled()
  })
})

describe('mounted under /api/browser', () => {
  const api = (downloads?: DownloadsApiDeps) => ({ status: () => ({ enabled: true }), downloads }) as unknown as BrowserApiDeps
  const call = (path: string, d: BrowserApiDeps) => handleBrowserApi('GET', `/api/browser/${path}`, async () => '', d)

  it('routes to the downloads handler and answers 404 when downloads are not wired', async () => {
    expect(await call('n1/downloads', api(deps()))).toEqual({ status: 200, body: { items: [] } })
    expect(await call('n1/downloads', api())).toMatchObject({ status: 404 })
  })
})

describe('attachmentHeader', () => {
  it('forces a download with a quote-free ASCII fallback and the UTF-8 name', () => {
    expect(attachmentHeader('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
    const h = attachmentHeader('laporán "x".pdf')
    expect(h.startsWith('attachment; filename="lapor_n _x_.pdf"')).toBe(true)
    expect(h).toContain(`filename*=UTF-8''lapor%C3%A1n%20%22x%22.pdf`)
    expect(h).not.toMatch(/[\r\n]/)
  })
})
