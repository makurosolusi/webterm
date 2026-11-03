// resolveHostPort: presedensi host & parsing port, pakai env palsu agar tak menyentuh process.env.
import { test, expect } from 'bun:test'
import { DEFAULT_PORT, parsePort, resolveHostPort } from './serverConfig'

/** Pesan galat yang dilempar fn, atau undefined bila tidak melempar (typings bun:test tak punya toThrow). */
function thrown(fn: () => unknown): string | undefined {
  try { fn() } catch (e) { return (e as Error).message }
  return undefined
}

test('HOST menang atas WEBTERM_HOST dan default', () => {
  const { host } = resolveHostPort({ HOST: 'a.example', WEBTERM_HOST: 'b.example' } as NodeJS.ProcessEnv)
  expect(host).toBe('a.example')
})

test('WEBTERM_HOST dipakai saat HOST kosong', () => {
  const { host } = resolveHostPort({ WEBTERM_HOST: 'b.example' } as NodeJS.ProcessEnv)
  expect(host).toBe('b.example')
})

test('default 127.0.0.1 saat keduanya absen', () => {
  const { host } = resolveHostPort({} as NodeJS.ProcessEnv)
  expect(host).toBe('127.0.0.1')
})

test('PORT numerik di-parse ke number', () => {
  expect(resolveHostPort({ PORT: '9000' } as NodeJS.ProcessEnv).port).toBe(9000)
})

test('PORT hilang/kosong jatuh ke DEFAULT_PORT', () => {
  expect(resolveHostPort({} as NodeJS.ProcessEnv).port).toBe(DEFAULT_PORT)
  expect(resolveHostPort({ PORT: '' } as NodeJS.ProcessEnv).port).toBe(DEFAULT_PORT)
})

test('PORT ngawur di resolveHostPort melempar, tidak jatuh senyap ke default', () => {
  expect(thrown(() => resolveHostPort({ PORT: 'abc' } as NodeJS.ProcessEnv))).toBe('PORT="abc" is not a valid port (1-65535)')
})

test('parsePort menerima kosong dan bilangan bulat 1..65535', () => {
  expect(parsePort(undefined)).toBe(DEFAULT_PORT)
  expect(parsePort('')).toBe(DEFAULT_PORT)
  expect(parsePort('8700')).toBe(8700)
  expect(parsePort('1')).toBe(1)
  expect(parsePort('65535')).toBe(65535)
})

test('parsePort menolak 0, di atas 65535, non-angka, desimal, dan negatif', () => {
  for (const raw of ['0', '65536', 'abc', '80.5', '-1']) {
    expect(thrown(() => parsePort(raw))).toBe(`PORT="${raw}" is not a valid port (1-65535)`)
  }
})
