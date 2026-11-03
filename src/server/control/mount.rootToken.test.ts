// Deps PRODUKSI mount.ts: `rootToken` harus dibaca per pemakaian (getter), bukan di-cache saat
// import, supaya token yang di-enable/rotate lewat Settings langsung berlaku di route mint.
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '../../shared/settings'
import { handleControlHttp } from './mount'

// Dua modul berat (bun:sqlite / PTY) dimock; yang diuji hanya jalur default deps.
vi.mock('../sessions', () => ({ sessions: {} }))
vi.mock('../db', () => ({ db: { getSettings: () => mergeSettings({}) } }))

const MINT_BODY = JSON.stringify({ verb: 'node.read', resource: '*' })
const savedToken = process.env.WEBTERM_TOKEN
const savedMint = process.env.WEBTERM_ALLOW_TOKEN_MINT

beforeAll(() => {
  // Dibaca sekali saat deps default dibuat; harus sudah ada sebelum panggilan pertama.
  process.env.WEBTERM_ALLOW_TOKEN_MINT = '1'
})

afterEach(() => {
  if (savedToken === undefined) delete process.env.WEBTERM_TOKEN
  else process.env.WEBTERM_TOKEN = savedToken
  if (savedMint === undefined) delete process.env.WEBTERM_ALLOW_TOKEN_MINT
  else process.env.WEBTERM_ALLOW_TOKEN_MINT = savedMint
})

/** Panggil route mint dengan deps default (tanpa overrides) dan kembalikan status HTTP-nya. */
async function mintStatus(rootHeader?: string): Promise<number> {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', headers: rootHeader ? { 'x-webterm-token': rootHeader } : {}, resume() {} })
  process.nextTick(() => {
    req.emit('data', Buffer.from(MINT_BODY))
    req.emit('end')
  })
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse
  await handleControlHttp(req, res, new URL('/api/control/token', 'http://x'), async () => MINT_BODY)
  return res.statusCode
}

describe('control/mount rootToken (getter)', () => {
  it('mengikuti token yang berlaku sekarang, bukan nilai saat import', async () => {
    delete process.env.WEBTERM_TOKEN
    expect(await mintStatus('first-token-value')).toBe(404) // belum ada root token: route mint tidak ada

    process.env.WEBTERM_TOKEN = 'first-token-value' // seperti writeTokenToEnv setelah enable
    expect(await mintStatus('first-token-value')).toBe(201)

    process.env.WEBTERM_TOKEN = 'second-token-value' // seperti rotate
    expect(await mintStatus('first-token-value')).toBe(403)
    expect(await mintStatus('second-token-value')).toBe(201)
  })
})
