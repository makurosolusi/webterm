// Source scanner: the files that write prose about what an agent can do must not hand-write a NEGATIVE web/browser
// statement. Such sentences go stale against enforcement (an author was once told it cannot browse while it could);
// capability wording lives in the registry (agentCapabilities.data.ts) and is rendered into these files at runtime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  'server/central/chat/conversationMode.ts',
  'server/agentChat/agentChat.role.ts',
  'client/central/centralLabels.ts',
  'client/agentChat/skillAuthor.preset.ts',
  'client/central/CentralSkillAuthorBanner.tsx',
  'server/agentChat/agentChat.capabilities.ts',
  'server/agentChat/agentChat.options.ts',
  'server/capabilityNote.ts',
  'server/central/context/capabilityMap.ts',
  'server/central/chat/turnNotes.ts',
]
// The steward prompt is long hand-written prose; only its web sentences (browser_read / browser_act) are guarded here.
const STEWARD_WEB_LINES = /browser_(?:read|act|open|status)|playbook\.web_research/

const NEG = String.raw`(?:cannot|can't|can not|\bno\b|not able|unable|\bnot\b|nothing|tidak (?:bisa|punya)|tak bisa)`
const WEB = String.raw`(?:brows|\bweb\b|open (?:a|the) (?:site|page)|website|membuka)`
const NEAR = String.raw`[^.\n]{0,60}`
export const NEGATIVE_WEB = new RegExp(`${NEG}${NEAR}${WEB}|${WEB}${NEAR}${NEG}`, 'i')

describe('no hand-written negative web/browser capability prose', () => {
  it('the pattern catches the sentences that went stale before', () => {
    for (const s of ['it cannot run agents, use the canvas or browse', 'you are not able to open a site', 'no projects, agents, canvas, browser, memory', 'Anda tidak bisa membuka website', 'You can do nothing else on the web']) expect(NEGATIVE_WEB.test(s), s).toBe(true)
    for (const s of ['Can read public web pages (read-only).', 'Sources: <host>|none']) expect(NEGATIVE_WEB.test(s), s).toBe(false)
  })

  it('server/central/runtime/claudeOptions.ts: the steward web lines hand-write no negative sentence', () => {
    const lines = readFileSync(join(SRC, 'server/central/runtime/claudeOptions.ts'), 'utf8').split('\n').map((line, i) => ({ line, n: i + 1 }))
    const hits = lines.filter(({ line }) => STEWARD_WEB_LINES.test(line) && NEGATIVE_WEB.test(line))
    expect(hits.map((h) => `${h.n}: ${h.line.trim().slice(0, 120)}`)).toEqual([])
  })

  for (const f of FILES) {
    it(f, () => {
      const hits = readFileSync(join(SRC, f), 'utf8').split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => NEGATIVE_WEB.test(line))
      expect(hits.map((h) => `${f}:${h.n}: ${h.line.trim().slice(0, 120)}`)).toEqual([])
    })
  }
})
