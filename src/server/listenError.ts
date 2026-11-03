// Pesan galat bind yang ramah untuk kesalahan konfigurasi paling umum, supaya boot gagal dengan
// satu kalimat yang bisa ditindaklanjuti, bukan stack mentah.

const HINTS: Readonly<Record<string, (host: string, port: number) => string>> = {
  EADDRINUSE: (host, port) => `port ${port} on ${host} is already in use. Stop the other process or set PORT to a free port.`,
  EACCES: (host, port) => `permission denied to listen on ${host}:${port} (ports below 1024 need elevated privileges). Set PORT to a higher port.`,
  EADDRNOTAVAIL: (host) => `address ${host} is not available on this machine. Check HOST.`,
}

/** Kode galat listen yang punya pesan ramah. */
export function isKnownListenError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code !== undefined && Object.hasOwn(HINTS, code)
}

/** Satu kalimat untuk galat listen yang dikenal; selain itu kode + pesan asal (tanpa stack). */
export function describeListenError(err: unknown, host: string, port: number): string {
  const { code, message } = (err ?? {}) as NodeJS.ErrnoException
  const hint = code !== undefined && Object.hasOwn(HINTS, code) ? HINTS[code] : undefined
  return `webterm: cannot start: ${hint ? hint(host, port) : `listen on ${host}:${port} failed (${code ?? message ?? 'unknown'})`}`
}
