// Kabel boot in-process: env palsu + WEBTERM_DATA_DIR tmp; process.env/token state dipulihkan tiap tes.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeTokenToEnv } from './auth'
import { bootWiring, HOST_DENIED_ERROR, onListenError, refuseRequest } from './bootWiring'
import { buildAllowedHosts } from './hostAllow'
import { getTokenState, setTokenState } from './tokenBootstrap'

// Logger dipalsukan: sink konsol/file tak terjamin aktif di vitest, yang diuji adalah apa yang DIKIRIM ke logger.
const logged = vi.hoisted(() => [] as unknown[][])
vi.mock('./logs', () => {
  const rec = (...a: unknown[]) => void logged.push(a)
  return { createLogger: () => ({ info: rec, warn: rec, error: rec, debug: rec }) }
})

const ENV_KEYS = ['WEBTERM_DATA_DIR', 'WEBTERM_TOKEN'] as const
const PADDED_TOKEN = '  Abc-padded-token-0123456789  '
const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
let dir: string
let written: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootwiring-'))
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  written = ''
  logged.length = 0
  for (const s of [process.stdout, process.stderr]) vi.spyOn(s, 'write').mockImplementation((c: unknown) => ((written += String(c)), true))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v)
  setTokenState({ token: undefined, source: 'none', created: false })
})

const fakeRes = () => {
  const r = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { r.headers[k] = v }, end(b: string) { r.body = b } }
  return r
}
const refuse = (headers: Record<string, string>, hosts: Parameters<typeof refuseRequest>[2]) => {
  const res = fakeRes()
  refuseRequest({ headers } as unknown as IncomingMessage, res as unknown as ServerResponse, hosts)
  return res
}

describe('refuseRequest', () => {
  it('Host ditolak => 403 JSON host_not_allowed tanpa memantulkan Host', () => {
    const res = refuse({ host: 'evil.example:9000' }, buildAllowedHosts({ host: '127.0.0.1', port: 9000, env: {} }))
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: HOST_DENIED_ERROR })
    expect(res.body).not.toContain('evil.example')
  })

  it('penolakan selain Host => 403 plain forbidden', () => {
    expect(refuse({ host: 'localhost:9000' }, () => undefined).body).toBe('forbidden')
  })
})

describe('bootWiring', () => {
  it('loopback is credentialed too: a token is minted on the default bind', () => {
    const { port } = bootWiring({ PORT: '9000' }, dir)
    expect(port).toBe(9000)
    expect(getTokenState()).toMatchObject({ source: 'file', created: true })
  })

  it('TTY: one line names the token file path, never the value; every boot', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    bootWiring({ PORT: '9000' }, dir)
    bootWiring({ PORT: '9000' }, dir)
    const token = getTokenState().token as string
    expect(getTokenState().created).toBe(false)
    expect(written.match(new RegExp(join(dir, 'data', 'secrets', 'WEBTERM_TOKEN'), 'g'))).toHaveLength(2)
    expect(written + JSON.stringify(logged)).not.toContain(token)
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true })
  })

  it('non-loopback non-TTY: token dibuat, log memuat path+panjang tapi bukan nilai token', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true })
    bootWiring({ HOST: '0.0.0.0', PORT: '9000' }, dir)
    const { token, created } = getTokenState()
    expect(created).toBe(true)
    expect(process.env.WEBTERM_TOKEN).toBe(token)
    const out = JSON.stringify(logged)
    expect(out).toContain(join(dir, 'data', 'secrets', 'WEBTERM_TOKEN'))
    expect(out).toContain(`"len":${(token as string).length}`)
    expect(out + written).not.toContain(token as string)
  })

  it('WEBTERM_ALLOWED_HOSTS rusak => satu warn berisi JUMLAH, bukan isinya', () => {
    bootWiring({ PORT: '9000', WEBTERM_ALLOWED_HOSTS: 'ok.example,bad host!' }, dir)
    const warns = logged.filter((a) => a[0] === 'hosts.ignored')
    expect(warns).toHaveLength(1)
    expect(warns[0][2]).toEqual({ count: 1 })
    expect(JSON.stringify(logged)).not.toContain('bad host!')
  })

  it('PORT ngawur melempar sebelum menyentuh disk', () => {
    expect(() => bootWiring({ PORT: 'abc' }, dir)).toThrow('PORT="abc"')
    expect(getTokenState().source).toBe('none')
  })
})

describe('writeTokenToEnv', () => {
  it('menulis token apa adanya dan menghapus env saat undefined', () => {
    writeTokenToEnv(PADDED_TOKEN.trim())
    expect(process.env.WEBTERM_TOKEN).toBe(PADDED_TOKEN.trim())
    writeTokenToEnv(undefined)
    expect('WEBTERM_TOKEN' in process.env).toBe(false)
  })

  it('bootWiring mengkanonkan token env berspasi sebelum ditulis ke process.env', () => {
    bootWiring({ PORT: '9000', WEBTERM_TOKEN: PADDED_TOKEN }, dir)
    expect(process.env.WEBTERM_TOKEN).toBe(PADDED_TOKEN.trim())
  })
})

describe('onListenError', () => {
  it('galat dikenal => pesan ramah + exit 1', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    onListenError('h', 80)(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))
    expect(exit).toHaveBeenCalledWith(1)
    expect(written).toContain('port 80 on h is already in use')
  })

  it('galat lain dilempar ulang dengan konteks', () => {
    expect(() => onListenError('h', 80)(Object.assign(new Error('boom'), { code: 'EMFILE' }))).toThrow('listen on h:80 failed')
  })
})
