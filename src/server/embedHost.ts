// In-process host seam. The native app (src/native) runs this server inside its own process and shows
// the UI in a native window. It registers here BEFORE importing index.ts; the CLI and the compiled
// binary never register, so their behaviour is unchanged (OS browser, auto-open on a TTY).

export interface EmbedHost {
  /** Load the 0600 sign-in redirect file (uiOpen.ts) in the host's own window instead of the OS browser.
   *  A path, never the code-bearing URL: the host's logs (Electrobun prints every loadURL) stay code-free. */
  openFile(path: string): Promise<void>
  /** Built UI (vite `dist/`) on disk when the host packages it somewhere other than `<repo>/dist`. */
  distDir?: string
  /** The JS bundle this host's runtime (`process.execPath`) runs, when the server lives in one: children
   *  re-enter it as `execPath <selfEntry> <hidden subcommand>` (selfLaunch.ts). */
  selfEntry?: string
}

let current: EmbedHost | null = null

/** Called once by the in-process host, before `import("./index")`; null unregisters (tests). */
export function registerEmbedHost(host: EmbedHost | null): void {
  current = host
}

/** The registered host, or null when this process is the CLI/binary server. */
export function embedHost(): EmbedHost | null {
  return current
}
