import { describe, expect, it } from 'vitest'
import { ALLOWED_HOSTS_MAX, ALLOWED_HOSTS_KEY, HOST_LOG_MAX, buildAllowedHosts, hostAllowed, safeHostForLog } from './hostAllow'

const PORT = 8700
const build = (host = '127.0.0.1', allowed?: string) =>
  buildAllowedHosts({ host, port: PORT, env: allowed === undefined ? {} : { [ALLOWED_HOSTS_KEY]: allowed } })

describe('buildAllowedHosts + hostAllowed', () => {
  it('menerima loopback dengan atau tanpa port', () => {
    const list = build()
    for (const h of ['127.0.0.1:8700', '127.0.0.1', 'localhost', 'localhost:8700', '[::1]:8700', '[::1]', 'LOCALHOST.:8700']) {
      expect(hostAllowed(h, list), h).toBe(true)
    }
  })

  it('menolak Host asing walau Origin-nya cocok (rebinding)', () => {
    expect(hostAllowed('evil.example:8700', build())).toBe(false)
    expect(hostAllowed('192.168.1.5:8700', build())).toBe(false)
  })

  it('host bind efektif diterima; IP LAN lain tidak', () => {
    const list = build('192.168.1.5')
    expect(hostAllowed('192.168.1.5:8700', list)).toBe(true)
    expect(hostAllowed('192.168.1.6:8700', list)).toBe(false)
  })

  it('bind IPv6 telanjang diberi kurung; wildcard tidak pernah masuk', () => {
    expect(hostAllowed('[fd00::5]:8700', build('fd00::5'))).toBe(true)
    for (const wild of ['0.0.0.0', '::']) {
      const list = build(wild)
      expect(hostAllowed(wild, list)).toBe(false)
      expect(hostAllowed(`[${wild}]`, list)).toBe(false)
    }
  })

  it('entri tanpa port = port apa pun; host:port = tepat', () => {
    const list = build('127.0.0.1', ' Proxy.Example. , other.example:9000')
    expect(hostAllowed('proxy.example:1234', list)).toBe(true)
    expect(hostAllowed('proxy.example', list)).toBe(true)
    expect(hostAllowed('other.example:9000', list)).toBe(true)
    expect(hostAllowed('other.example:9001', list)).toBe(false)
    expect(hostAllowed('other.example', list)).toBe(false)
    expect(hostAllowed('unlisted.example', list)).toBe(false)
  })

  it('entri ngawur diabaikan dan dihitung', () => {
    const list = build('127.0.0.1', 'ok.example,*.evil.example,http://x.example,a/b,host:99999,,bad host')
    expect(list.ignored).toBe(5)
    expect(hostAllowed('ok.example', list)).toBe(true)
    expect(hostAllowed('x.example', list)).toBe(false)
  })

  it('kelebihan ALLOWED_HOSTS_MAX diabaikan dan dihitung', () => {
    const csv = Array.from({ length: ALLOWED_HOSTS_MAX + 3 }, (_, n) => `h${n}.example`).join(',')
    const list = build('127.0.0.1', csv)
    expect(list.ignored).toBe(3)
    expect(hostAllowed(`h${ALLOWED_HOSTS_MAX - 1}.example`, list)).toBe(true)
    expect(hostAllowed(`h${ALLOWED_HOSTS_MAX}.example`, list)).toBe(false)
  })

  it('Host kosong, hilang, ganda, atau tak valid ditolak', () => {
    const list = build()
    expect(hostAllowed(undefined, list)).toBe(false)
    expect(hostAllowed('', list)).toBe(false)
    expect(hostAllowed(['localhost', 'localhost'], list)).toBe(false)
    expect(hostAllowed('localhost:99999', list)).toBe(false)
    expect(hostAllowed('user@localhost', list)).toBe(false)
    expect(hostAllowed('localhost/evil', list)).toBe(false)
  })
})

describe('safeHostForLog', () => {
  it('membuang karakter kontrol dan memotong', () => {
    expect(safeHostForLog('evil\r\nX-Forged: 1')).toBe('evilX-Forged: 1')
    expect(safeHostForLog('a'.repeat(HOST_LOG_MAX + 50))).toHaveLength(HOST_LOG_MAX)
    expect(safeHostForLog(undefined)).toBe('')
  })
})
