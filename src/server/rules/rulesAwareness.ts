// Project rules in the hook reply. The hook path is synchronous and must not wait on git, so rules
// and touched files live in a per-folder cache warmed in the background: every hook call peeks (and
// re-warms a stale entry); SessionStart sends the block that is cached, and a later UserPromptSubmit
// sends it again only when what is in force changed (first warm finished, a new glob rule matched).
import { type RuleFile, discoverRules, rulesBlock } from './rulesLoader'

/** Re-read rules and touched files at most this often per folder. */
export const RULES_TTL_MS = 30_000
/** Rules share the 10k `additionalContext` reply with card, awareness and procedural blocks. */
export const RULES_HOOK_MAX_CHARS = 3000
export const RULES_CHANGED_HEADER = 'Project rules in force changed (webterm):'

export interface RulesSnapshot { rules: RuleFile[]; touched: string[] }

export interface RulesCacheDeps {
  load(cwd: string): Promise<RulesSnapshot>
  now(): number
  onError(cwd: string, err: unknown): void
}

/** Rules of the repo `cwd` sits in (the folder itself when it is not a repo) plus its dirty files. */
export async function loadRules(cwd: string): Promise<RulesSnapshot> {
  // Lazy: the knowledge modules pull bun:sqlite, and the hook module importing this one is loaded by vitest too.
  const [{ git }, { readGitState }] = await Promise.all([import('../knowledge/knowledgeScan'), import('../knowledge/knowledgeFresh')])
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || cwd
  const [rules, state] = await Promise.all([discoverRules(root), readGitState(root)])
  return { rules, touched: state.dirty }
}

export function createRulesAwareness(deps: RulesCacheDeps) {
  const cache = new Map<string, { snap: RulesSnapshot; at: number }>()
  const inflight = new Map<string, Promise<void>>()
  const delivered = new Map<string, string>()

  const warm = (cwd: string): Promise<void> => {
    const running = inflight.get(cwd)
    if (running) return running
    const p = deps.load(cwd)
      .then((snap) => { cache.set(cwd, { snap, at: deps.now() }) })
      // A failing folder is cached empty for one TTL: no retry storm, no stale rules either.
      .catch((err: unknown) => { cache.set(cwd, { snap: { rules: [], touched: [] }, at: deps.now() }); deps.onError(cwd, err) })
      .finally(() => { inflight.delete(cwd) })
    inflight.set(cwd, p)
    return p
  }

  const peek = (cwd: string): RulesSnapshot | undefined => {
    const hit = cache.get(cwd)
    if (!hit || deps.now() - hit.at >= RULES_TTL_MS) void warm(cwd)
    return hit?.snap
  }

  return {
    warm,
    /** Text to add to this hook reply, or null. Never throws, never waits. */
    next(nodeId: string, event: string | undefined, cwd: string): string | null {
      if (!cwd) return null
      const snap = peek(cwd)
      if (event === 'SessionStart') delivered.delete(nodeId)
      if (!snap || (event !== 'SessionStart' && event !== 'UserPromptSubmit')) return null
      const block = rulesBlock(snap.rules, snap.touched, RULES_HOOK_MAX_CHARS)
      const sig = [...block.included, '|', ...block.listed].join('\0')
      const prior = delivered.get(nodeId)
      if (event === 'UserPromptSubmit' && (prior === sig || (prior === undefined && !block.text))) return null
      delivered.set(nodeId, sig)
      if (!block.text) return null
      return event === 'SessionStart' ? block.text : `${RULES_CHANGED_HEADER}\n${block.text}`
    },
    forget(nodeId: string): void { delivered.delete(nodeId) },
  }
}

export type RulesAwareness = ReturnType<typeof createRulesAwareness>
