// Resolusi host/port dari env, dipisah sebagai fungsi murni agar bisa diuji tanpa bind port.
import { DEFAULT_HOST } from './auth'

/**
 * `HOST` adalah nama yang diminta user; `WEBTERM_HOST` dipertahankan agar board lama tak putus.
 * 8700 adalah default yang sudah mapan — satu-satunya literal default, jangan sebar ke tempat lain.
 */
export function resolveHostPort(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const host = env.HOST || env.WEBTERM_HOST || DEFAULT_HOST
  const port = Number(env.PORT) || 8700
  return { host, port }
}
