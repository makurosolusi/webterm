// Context filter for agent-to-agent handoffs (F4-c; OpenAI Agents SDK `handoff(input_filter=...)`):
// whatever one agent passes to the next is masked of known secret values (broker store + caller
// supplied, raw and encoded forms) and credential shapes, then trimmed. Masking runs BEFORE trimming
// so a cut can never leave half a secret that no longer matches.
import { createLogger } from '../logs'
import { maskSecrets } from '../secrets/secret.redact'
import { createBrokerStore } from '../secrets/secret.store'

const log = createLogger('verifier')

export interface HandoffTurn {
  role: string
  text: string
}

export interface HandoffFilterOptions {
  /** Secret values to mask; default = every value held by the secret broker. */
  knownSecrets?: readonly string[]
  /** Cap of the whole result (chars). */
  maxChars?: number
  /** Transcripts: only the newest N turns travel. */
  maxTurns?: number
  /** Transcripts: cap per turn (chars). */
  maxTurnChars?: number
}

export const HANDOFF_MAX_CHARS = 8000
export const HANDOFF_MAX_TURNS = 20
export const HANDOFF_MAX_TURN_CHARS = 2000
const TRIMMED = '…[trimmed]'

/** Values in the secret broker; an unreadable store masks nothing extra (credential shapes still apply). */
export function knownSecretValues(): string[] {
  try {
    const store = createBrokerStore()
    return store.names().map((name) => store.read(name)).filter((v): v is string => !!v)
  } catch (err) {
    log.warn('verifier.handoff.secrets', 'secret broker unreadable; masking credential shapes only', { cause: err instanceof Error ? err.name : 'unknown' })
    return []
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(0, max - TRIMMED.length))}${TRIMMED}` : text)

/** Filtered handoff context: secrets masked, transcript cut to the newest turns, length capped. */
export function filterHandoffContext(input: string | readonly HandoffTurn[], opts: HandoffFilterOptions = {}): string {
  const secrets = opts.knownSecrets ?? knownSecretValues()
  const maxChars = opts.maxChars ?? HANDOFF_MAX_CHARS
  if (typeof input === 'string') return clip(maskSecrets(input, secrets), maxChars)
  const maxTurns = opts.maxTurns ?? HANDOFF_MAX_TURNS
  const kept = input.slice(-maxTurns)
  const lines = kept.map((t) => `${t.role}: ${clip(maskSecrets(t.text, secrets), opts.maxTurnChars ?? HANDOFF_MAX_TURN_CHARS)}`)
  const omitted = input.length - kept.length
  return clip([...(omitted > 0 ? [`[${omitted} earlier turns omitted]`] : []), ...lines].join('\n'), maxChars)
}
