// In-process host seam. The native app (src/native) runs this server inside its own process and shows
// the UI in a native window. It registers here BEFORE importing index.ts; the CLI and the compiled
// binary never register, so their behaviour is unchanged (OS browser, auto-open on a TTY).

export interface EmbedHost {
  /** Show the signed-in URL (`/auth/open?code=`) in the host's own window instead of the OS browser. */
  openUrl(url: string): Promise<void>
  /** Built UI (vite `dist/`) on disk when the host packages it somewhere other than `<repo>/dist`. */
  distDir?: string
}

let current: EmbedHost | null = null

/** Called once by the in-process host, before `import('./index')`. */
export function registerEmbedHost(host: EmbedHost): void {
  current = host
}

/** The registered host, or null when this process is the CLI/binary server. */
export function embedHost(): EmbedHost | null {
  return current
}
