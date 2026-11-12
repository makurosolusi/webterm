// Policy: no launch wrapper is privileged in user-facing text. A label constant that names envman must
// also name another wrapper (op run, doppler, direnv, infisical, aws-vault), so envman never reads as required.
import { describe, expect, it } from 'vitest'
import { COMMAND_TEXT } from './ClaudeProviderCommand'
import { PROVIDER_TEXT } from './ClaudeProviderCard'
import { PROFILES_TEXT } from './claudeLauncher/ClaudeLaunchProfilesCard'
import { EDITOR_TEXT } from './claudeLauncher/ClaudeProfileEditor'
import { SETUP_TEXT } from './setup/setup.labels'
import { normalizeClaudeCommand } from '../shared/claudeLaunch/claudeLaunch.normalize'

const OTHERS = /\b(op run|doppler|direnv|infisical|aws-vault)\b/

/** Every string in a label object, functions called with a sample argument. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'function') { try { strings(v('x'), out) } catch { /* label needing other args: skip */ } }
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

describe('wrapper-neutral product text', () => {
  it('no label names envman without naming another wrapper', () => {
    const texts = strings([COMMAND_TEXT, PROVIDER_TEXT, PROFILES_TEXT, EDITOR_TEXT, SETUP_TEXT])
    texts.push(...normalizeClaudeCommand('env API_KEY=abc claude').warnings) // the shared secret warning
    expect(texts.length).toBeGreaterThan(20)
    expect(texts.filter((t) => /envman/i.test(t) && !OTHERS.test(t))).toEqual([])
  })
})
