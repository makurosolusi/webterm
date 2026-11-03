// Token akses root tanpa .env: env menang, lalu berkas <secretsDir>/WEBTERM_TOKEN (0600), lalu
// dibangkitkan otomatis hanya bila bind non-loopback. Modul ini TIDAK mencetak apa pun dan tidak
// menulis process.env — cetak TTY dan writeTokenToEnv dikabel di boot (index.ts).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopbackHost } from './auth'
import { createFileSecretStore, type SecretStore } from './envSecrets.store'

export type TokenSource = 'env' | 'file' | 'none'
export interface TokenState {
  readonly token: string | undefined
  readonly source: TokenSource
  /** true bila proses ini yang membuat berkas (supaya token dicetak sekali). */
  readonly created: boolean
}

/** Nama berkas di dir secrets; sengaja bukan kunci registry, jadi overlay Settings tak menyentuhnya. */
export const TOKEN_SECRET_KEY = 'WEBTERM_TOKEN'
const TOKEN_BYTES = 32
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/

const NO_TOKEN: TokenState = { token: undefined, source: 'none', created: false }
let current: TokenState = NO_TOKEN

/** State token proses ini (awal: none). */
export function getTokenState(): TokenState {
  return current
}

/** Ganti state token; hanya dipanggil bootstrap, enable, dan rotate. */
export function setTokenState(next: TokenState): void {
  current = next
}

/** Path berkas token di dalam `secretsDir`. */
export function tokenFilePath(secretsDir: string): string {
  return join(secretsDir, TOKEN_SECRET_KEY)
}

/** Token acak TOKEN_BYTES byte dalam base64url (43 karakter); `generate` = seam tes. */
export function mintToken(generate?: () => string): string {
  return generate ? generate() : randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Tulis token ke berkas 0600, baca ulang, dan cocokkan. Melempar bila isi di disk beda (mis. proses
 * lain menimpa) supaya pemanggil tak memegang token yang tidak ada di disk. `store` = seam tes.
 */
export function persistToken(
  secretsDir: string,
  token: string,
  store: SecretStore = createFileSecretStore(secretsDir),
): void {
  store.write(TOKEN_SECRET_KEY, token)
  if (store.read(TOKEN_SECRET_KEY) !== token) {
    throw new Error(`token file verification failed after write: ${tokenFilePath(secretsDir)}`)
  }
}

/** Tentukan token boot; berhenti di langkah pertama yang cocok (env, berkas, bangkitkan, none). */
export function bootstrapToken(i: {
  host: string
  env: NodeJS.ProcessEnv
  secretsDir: string
  generate?: () => string
}): TokenState {
  const fromEnv = (i.env.WEBTERM_TOKEN ?? '').trim()
  if (fromEnv) return { token: fromEnv, source: 'env', created: false }

  const path = tokenFilePath(i.secretsDir)
  if (existsSync(path)) {
    const stored = createFileSecretStore(i.secretsDir).read(TOKEN_SECRET_KEY)
    // Fail-closed: berkas rusak/mode longgar jangan membuka akses dan jangan ditimpa diam-diam.
    if (stored === null || !TOKEN_SHAPE.test(stored)) {
      throw new Error(`token file unreadable or malformed: ${path}`)
    }
    return { token: stored, source: 'file', created: false }
  }

  // Loopback tanpa token tetap terbuka sampai pengguna mengaktifkannya (enable).
  if (isLoopbackHost(i.host)) return NO_TOKEN

  const token = mintToken(i.generate)
  persistToken(i.secretsDir, token)
  return { token, source: 'file', created: true }
}
