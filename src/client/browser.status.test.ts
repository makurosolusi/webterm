// Pesan overlay node browser (Indonesia) + tombol pemulihan `noticeAction`.
import { describe, expect, it } from 'vitest'
import type { BrowserState } from '../shared/browser.contract'
import { browserNotice, netErrorText, noticeAction } from './browser.status'

const blocked = (b: BrowserState['blocked'], url = 'https://old.example/'): BrowserState =>
  ({ id: 'n1', url, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', blocked: b })

describe('browserNotice', () => {
  it('memakai host dari galat server, bukan halaman lama di state.url', () => {
    const n = browserNotice({ state: blocked('private_host'), error: { code: 'blocked', hostname: 'localhost' }, connected: true })
    expect(n?.text).toBe('This address is on a private network and is blocked. (localhost)')
  })

  it('berbahasa Indonesia untuk sambung ulang', () => {
    expect(browserNotice({ connected: false })?.text).toBe('Reconnecting…')
  })
})

describe('noticeAction', () => {
  it('Chromium hilang / browser mati -> tawaran kemampuan', () => {
    expect(noticeAction({ state: blocked('no_binary') })).toEqual({ kind: 'offer' })
    expect(noticeAction({ error: { code: 'disabled' } })).toEqual({ kind: 'offer' })
  })

  it('localhost diblokir -> izinkan beserta alias 127.0.0.1', () => {
    expect(noticeAction({ state: blocked('private_host'), target: 'http://localhost:3000/app', error: { code: 'blocked', hostname: 'localhost' } }))
      .toEqual({ kind: 'allowHost', hostPort: 'localhost:3000', entries: ['localhost:3000', '127.0.0.1:3000'] })
  })

  it('IP LAN literal tanpa galat (galat sudah hilang) tetap ditawarkan, port default dari skema', () => {
    expect(noticeAction({ state: blocked('private_host'), target: 'https://192.168.1.5/' }))
      .toEqual({ kind: 'allowHost', hostPort: '192.168.1.5:443', entries: ['192.168.1.5:443'] })
  })

  it('tidak menawarkan metadata link-local, redirect dari nama publik, atau host yang tak cocok dengan galat', () => {
    expect(noticeAction({ state: blocked('private_host'), target: 'http://169.254.169.254/latest' })).toBeNull()
    expect(noticeAction({ state: blocked('private_host'), target: 'https://public.example/' })).toBeNull()
    expect(noticeAction({ state: blocked('private_host'), target: 'http://localhost:3000/', error: { code: 'blocked', hostname: '10.0.0.1' } })).toBeNull()
  })

  it('blokir lain (port webterm, skema) tanpa tombol', () => {
    expect(noticeAction({ state: blocked('not_allowed_port'), target: 'http://localhost:8700/' })).toBeNull()
    expect(noticeAction({ state: blocked('scheme'), target: 'file:///etc/passwd' })).toBeNull()
  })
})

describe('netErrorText', () => {
  it('maps Chromium net error names to a title + hint', () => {
    expect(netErrorText('net::ERR_NAME_NOT_RESOLVED')).toEqual({ title: "This site can't be reached", hint: 'Check the address for typos.', retryable: true })
    expect(netErrorText('net::ERR_INTERNET_DISCONNECTED')?.hint).toBe('Check your connection.')
    expect(netErrorText('net::ERR_CONNECTION_REFUSED')?.title).toBe("This site can't be reached")
    expect(netErrorText('net::ERR_CERT_AUTHORITY_INVALID')).toMatchObject({ title: 'Your connection is not private', hint: "The site's certificate isn't trusted." })
    expect(netErrorText('net::ERR_CERT_DATE_INVALID')?.title).toBe('Your connection is not private')
    expect(netErrorText('net::ERR_BLOCKED_BY_CLIENT')?.retryable).toBe(false)
  })

  it('ERR_ABORTED is not an error; unknown names fall back to a generic sentence', () => {
    expect(netErrorText('net::ERR_ABORTED')).toBeNull()
    expect(netErrorText('net::ERR_SOMETHING_NEW')).toEqual({ title: "This page couldn't load", hint: '', retryable: true })
  })

  it('noticeAction turns state.netError into a plate with the host; blocked wins', () => {
    const st = { ...blocked(undefined, 'https://nope.invalid/x?q=1'), netError: 'net::ERR_NAME_NOT_RESOLVED' }
    expect(noticeAction({ state: st })).toMatchObject({ kind: 'netError', code: 'net::ERR_NAME_NOT_RESOLVED', host: 'nope.invalid', retryable: true })
    expect(noticeAction({ state: { ...st, netError: 'net::ERR_ABORTED' } })).toBeNull()
    expect(noticeAction({ state: { ...st, blocked: 'scheme' } })).toBeNull()
  })
})
