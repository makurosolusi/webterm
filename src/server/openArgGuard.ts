// Guard for the server's own OS-opener calls (`open` / `xdg-open` / `explorer.exe`): they take a file PATH, never a URL.
// A URL here would open the machine browser from the server process (docs/decisions/canvas-containment.md).

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:(\/\/|[^\\/])/i
/** A Windows drive path (`C:\x`, `C:/x`) is a path, not a URL scheme. */
const DRIVE_PATH = /^[a-z]:[\\/]/i

/** Throw when `arg` looks like a URL (any scheme://, mailto:, javascript:, ...); returns `arg` otherwise. */
export function assertPathArg(arg: string, who: string): string {
  if (!DRIVE_PATH.test(arg) && URL_SCHEME.test(arg)) throw new Error(`${who}: refusing to hand a URL to the OS opener (it would open the machine browser)`)
  return arg
}
