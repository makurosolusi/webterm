// `setup`: first-run wizard state. `completedAt` null = the wizard still shows; each step remembers
// whether the user finished or skipped it. Patched per step (`settings.patch.ts`): a PATCH carrying
// `{ setup: { steps: { claude: 'done' } } }` keeps the other steps, `null` clears one step.

/** Wizard steps, in the order the wizard shows them. A step added later is harmless for an install that
 *  already finished: `completedAt` alone decides whether the wizard shows, never the count of answered steps. */
export const SETUP_STEPS = ['claude', 'browser', 'commands', 'central', 'basics'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]
export const SETUP_STEP_STATES = ['done', 'skipped'] as const
export type SetupStepState = (typeof SETUP_STEP_STATES)[number]

/** Persisted wizard state (no secrets, no PII: step ids and a timestamp). */
export interface SetupState {
  /** Epoch ms the wizard was finished (or backfilled for an existing install); null = not yet. */
  completedAt: number | null
  steps: Partial<Record<SetupStep, SetupStepState>>
}

/** A setup PATCH: fields optional, `steps` merged per step, `null` step = clear it. */
export interface SetupPatch {
  completedAt?: number | null
  steps?: Partial<Record<SetupStep, SetupStepState | null>>
}

export const DEFAULT_SETUP: SetupState = { completedAt: null, steps: {} }

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const isStep = (k: string): k is SetupStep => (SETUP_STEPS as readonly string[]).includes(k)
const isState = (v: unknown): v is SetupStepState => typeof v === 'string' && (SETUP_STEP_STATES as readonly string[]).includes(v)

/** Load/PUT boundary: unknown steps and values dropped; completedAt a non-negative integer or null. */
export function normalizeSetup(v: unknown): SetupState {
  const src = rec(v)
  const c = src.completedAt
  const completedAt = typeof c === 'number' && Number.isFinite(c)
    ? Math.min(Math.max(Math.trunc(c), 0), Number.MAX_SAFE_INTEGER)
    : null
  const steps: SetupState['steps'] = {}
  for (const [k, s] of Object.entries(rec(src.steps))) if (isStep(k) && isState(s)) steps[k] = s
  return { completedAt, steps }
}

/** `patch` written onto a stored/viewed `setup` (raw shapes tolerated; normalize afterwards). */
export function applySetupPatch(current: unknown, patch: unknown): Record<string, unknown> {
  const cur = rec(current)
  const p = rec(patch)
  const steps = { ...rec(cur.steps) }
  for (const [k, s] of Object.entries(rec(p.steps))) {
    if (s === null) delete steps[k]
    else if (s !== undefined) steps[k] = s
  }
  return { ...cur, ...('completedAt' in p && p.completedAt !== undefined ? { completedAt: p.completedAt } : {}), steps }
}

/** Two pending setup patches as one (`b` wins per field / per step). */
export function mergeSetupPatches(a: SetupPatch, b: SetupPatch): SetupPatch {
  const out: SetupPatch = { ...a, ...b }
  if (a.steps || b.steps) out.steps = { ...a.steps, ...b.steps }
  return out
}
