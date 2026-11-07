// Runtime-neutral pieces shared by the Central runtimes: the model env key and the
// one-line stderr reason used in failure messages.
import { redactSecrets } from '../../redactSecrets'

/** Env key naming the Central model (read on every turn). */
export const CENTRAL_MODEL_FLAG = 'WEBTERM_CENTRAL_MODEL'

const MAX_REASON_CHARS = 200

/**
 * One-line reason from captured stderr: the last `Error:` line (CLIs print the cause last),
 * else the last non-empty line; redacted and capped. Empty string when stderr has nothing.
 */
export function stderrReason(stderr: string, secrets: ReadonlyArray<string | undefined> = []): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const pick = [...lines].reverse().find((line) => /^error\b/i.test(line)) ?? lines.at(-1) ?? ''
  return redactSecrets(pick, secrets).slice(0, MAX_REASON_CHARS)
}
