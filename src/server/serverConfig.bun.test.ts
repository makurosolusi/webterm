// resolveHostPort: presedensi host & parsing port, pakai env palsu agar tak menyentuh process.env.
import { test, expect } from 'bun:test'
import { resolveHostPort } from './serverConfig'

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

test('PORT hilang/kosong/non-numerik jatuh ke 8700', () => {
  expect(resolveHostPort({} as NodeJS.ProcessEnv).port).toBe(8700)
  expect(resolveHostPort({ PORT: '' } as NodeJS.ProcessEnv).port).toBe(8700)
  expect(resolveHostPort({ PORT: 'abc' } as NodeJS.ProcessEnv).port).toBe(8700)
})
