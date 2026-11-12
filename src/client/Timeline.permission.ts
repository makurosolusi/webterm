// Readable Activity lines for permission, Central guard and policy events, so actions an agent took
// without asking (Auto / Danger modes, rules, the auto-reviewer) are visible next to everything else.
// Payload shapes come from the server producers: permission/permission.wait.ts + permission.loop.ts,
// central/guard/controlGuard.ts, policy/policy.classifier.ts, policy/policy.decide.ts.

type Rec = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export type LineTone = 'warning'
export interface PermissionLine { text: string; tone?: LineTone }

/** Event kinds the "Permissions" filter covers. */
export const isPermissionKind = (kind: string): boolean =>
  kind.startsWith('permission.') || kind.startsWith('policy.') || kind === 'central.guard'

/** Approval levels (`always|risky|never`) as the user sees them in Settings. */
export const MODE_NAMES: Record<string, string> = { always: 'Ask', risky: 'Auto', never: 'Danger', ask: 'Ask', auto: 'Auto', danger: 'Danger' }
const modeName = (m: unknown): string => MODE_NAMES[String(m)] ?? (str(m) ?? '?')

/** Danger = never ask (hook `mode` is 'danger'; raw level 'never' and Claude's `bypassPermissions` mean the same). */
export const isDangerMode = (m: unknown): boolean => m === 'danger' || m === 'never' || m === 'bypassPermissions'
export const isAutoMode = (m: unknown): boolean => m === 'auto' || m === 'risky' || m === 'acceptEdits'

const CAP_PREFIX = 'claude.tool:'
const capName = (c: unknown): string => { const s = str(c) ?? 'an action'; return s.startsWith(CAP_PREFIX) ? s.slice(CAP_PREFIX.length) : s }
const warn = (text: string): PermissionLine => ({ text, tone: 'warning' })

function decisionText(p: Rec, label: string): PermissionLine {
  const behavior = str(p.behavior)
  const by = str(p.by)
  // An 'ask' rule the server skipped under Danger: the agent went ahead without asking.
  if (by === 'rule' && p.skipped === true) return warn(`Skipped asking (Danger): ${label}`)
  if (by === 'rule') return behavior === 'deny' ? { text: `Blocked by your rule: ${label}` } : { text: `Allowed by your rule: ${label}` }
  if (behavior === 'none') {
    if (by === 'timeout') return { text: `No answer in time, asked in the terminal: ${label}` }
    if (by === 'hook_closed') return { text: `Request closed before an answer: ${label}` }
    return { text: `Approval not used: ${label}` }
  }
  // A human `by` (approver id) always reads "by you", whatever the mode was.
  if (by === 'classifier') return behavior === 'deny' ? { text: `Auto-denied: ${label}` } : { text: `Auto-allowed: ${label}` }
  return behavior === 'deny' ? { text: `Denied by you: ${label}` } : { text: `Approved by you: ${label}` }
}

function guardText(p: Rec): PermissionLine {
  const tool = str(p.tool) ?? str(p.action) ?? 'an action'
  const verdict = str(p.verdict)
  if (verdict === 'deny') {
    if (str(p.rule)) return { text: `Blocked by your rule: Central ${tool}` }
    const reason = str(p.reason)
    return { text: reason ? `Central was blocked: ${tool} (${reason})` : `Central was blocked: ${tool}` }
  }
  if (verdict === 'needs_approval') return { text: `Central asked you: ${tool}` }
  if (p.skipped === true) return warn(`Skipped asking (Danger): Central ${tool}`)
  return { text: `Central allowed: ${tool}` }
}

function policyText(kind: string, p: Rec): PermissionLine {
  const cap = capName(p.capability)
  const reason = str(p.reason)
  const why = reason ? ` (${reason})` : ''
  switch (kind) {
    case 'policy.classifier': return p.effect === 'allow' ? { text: `Auto-allowed: ${cap}${why}` } : { text: `Auto-review asked you: ${cap}${why}` }
    case 'policy.classifier_switch': return { text: `Auto-review: Central ${p.central === true ? 'on' : 'off'}, permission prompts ${p.permissions === true ? 'on' : 'off'}` }
    case 'policy.decision': {
      const effect = str(p.effect)
      if (effect === 'deny') return { text: `Blocked by policy: ${cap}${why}` }
      return effect === 'ask' ? { text: `Policy asks you: ${cap}` } : { text: `Policy allowed: ${cap}` }
    }
    default: return { text: `Policy: ${kind.slice('policy.'.length).replace(/_/g, ' ')}${p.capability ? ` ${cap}` : ''}` }
  }
}

/** Human line for a permission-family event; null when `kind` is not one. */
export function permissionText(kind: string, p: Rec): PermissionLine | null {
  const label = str(p.label) ?? str(p.tool) ?? 'a tool'
  switch (kind) {
    case 'permission.request': return { text: `Waiting for you: ${label}` }
    case 'permission.decision': return decisionText(p, label)
    case 'permission.doom_loop': return warn(`Stopped a repeat loop: ${label}${typeof p.count === 'number' ? ` (${p.count} times)` : ''}`)
    case 'permission.mode_change': {
      const where = p.scope === 'workspace' ? 'this project' : 'all projects'
      const text = `Mode changed: ${modeName(p.from)} → ${modeName(p.to)} (${where})`
      return isDangerMode(p.to) ? warn(text) : { text }
    }
    case 'central.guard': return guardText(p)
    default: break
  }
  if (kind.startsWith('policy.')) return policyText(kind, p)
  if (kind.startsWith('permission.')) return { text: `Permission: ${kind.slice('permission.'.length).replace(/_/g, ' ')} ${label}` }
  return null
}
