// Resolusi host/port dari env, dipisah sebagai fungsi murni agar bisa diuji tanpa bind port.
import { DEFAULT_HOST } from './auth'

/** Port bawaan; satu-satunya literal default, jangan sebar ke tempat lain. */
export const DEFAULT_PORT = 8700
const MAX_PORT = 65535
const PORT_SHAPE = /^\d{1,5}$/

/**
 * Kosong/absen => `DEFAULT_PORT`; selain itu wajib bilangan bulat 1..65535. Nilai ngawur dilempar
 * (bukan jatuh senyap ke 8700): salah ketik PORT harus terlihat, bukan mengikat port yang tak diminta.
 */
export function parsePort(raw: string | undefined): number {
  const text = (raw ?? '').trim()
  if (text === '') return DEFAULT_PORT
  const port = Number(text)
  if (!PORT_SHAPE.test(text) || port < 1 || port > MAX_PORT) {
    throw new Error(`PORT="${raw}" is not a valid port (1-${MAX_PORT})`)
  }
  return port
}

/** `HOST` adalah nama yang diminta user; `WEBTERM_HOST` dipertahankan agar board lama tak putus. */
export function resolveHostPort(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const host = env.HOST || env.WEBTERM_HOST || DEFAULT_HOST
  return { host, port: parsePort(env.PORT) }
}

/** Env override for Vite's dep-optimizer cache (dev only); empty = Vite's default `node_modules/.vite`.
 *  A second instance from the same checkout (`bun run dev:fresh`) sets it so the two dev servers never
 *  rewrite one shared cache under each other. */
export const VITE_CACHE_DIR_KEY = 'WEBTERM_VITE_CACHE_DIR'

/** `cacheDir` for the dev Vite server, or undefined to keep Vite's default. */
export function viteCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  return env[VITE_CACHE_DIR_KEY]?.trim() || undefined
}
