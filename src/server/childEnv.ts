// Env for a non-interactive child that runs user or repo code (setup scripts, routine prechecks, rg,
// the naming CLI). Same filter as the PTY (`ptyEnv`): the server's own vars (WEBTERM_TOKEN, bot token,
// PORT, keys loaded from .env) never reach a child. git has its own wrapper (`gitEnv` in gitExec.ts),
// built on the same filter. sec-208-7: these spawns used to inherit `process.env` whole.
import { ptyEnv } from './ptyShell'

/** Filtered `source` plus `extra` (extras win, so a caller may hand a child an explicit WEBTERM_* var). */
export function childEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...ptyEnv(source, { interactive: false }), ...extra }
}
