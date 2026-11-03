// Focused tests for the pure payload model split out of orchestratorRunApi.
// Route-level behavior stays covered by orchestratorRunApi.test.ts.
import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATOR_RUN_FLAG,
  ORCHESTRATOR_RUN_PATH,
  parseRunBody,
  orchestratorRunEnabled,
  orchestratorRunRequireApproval,
  resolveWorkerKind,
} from './orchestratorRunModel'
import {
  parseRunBody as parseViaApi,
  orchestratorRunEnabled as enabledViaApi,
  ORCHESTRATOR_RUN_FLAG as flagViaApi,
  ORCHESTRATOR_RUN_PATH as pathViaApi,
} from './orchestratorRunApi'

const valid = { projectId: 'p1', itemId: 'i1', expectedVersion: 1 }

describe('orchestratorRunModel', () => {
  it('is re-exported verbatim by orchestratorRunApi so importers keep working', () => {
    expect(parseViaApi).toBe(parseRunBody)
    expect(enabledViaApi).toBe(orchestratorRunEnabled)
    expect(flagViaApi).toBe(ORCHESTRATOR_RUN_FLAG)
    expect(pathViaApi).toBe(ORCHESTRATOR_RUN_PATH)
    expect(ORCHESTRATOR_RUN_FLAG).toBe('WEBTERM_ORCHESTRATOR_RUN')
    expect(ORCHESTRATOR_RUN_PATH).toBe('/api/orchestrator/run')
  })

  it('gates on the exact flag value "on", and only while central is on (implies)', () => {
    const central = { WEBTERM_CENTRAL: 'on' }
    expect(orchestratorRunEnabled({})).toBe(false)
    expect(orchestratorRunEnabled({ ...central, WEBTERM_ORCHESTRATOR_RUN: '1' })).toBe(true)
    expect(orchestratorRunEnabled({ ...central, WEBTERM_ORCHESTRATOR_RUN: 'yes' })).toBe(false)
    expect(orchestratorRunEnabled({ ...central, WEBTERM_ORCHESTRATOR_RUN: 'on' })).toBe(true)
    expect(orchestratorRunEnabled({ WEBTERM_ORCHESTRATOR_RUN: 'on' })).toBe(false)
  })

  it('reads the env per call (hot): flipping the same env object flips the answer', () => {
    const env: Record<string, string | undefined> = { WEBTERM_CENTRAL: 'on' }
    expect(orchestratorRunEnabled(env)).toBe(false)
    env.WEBTERM_ORCHESTRATOR_RUN = 'on'
    expect(orchestratorRunEnabled(env)).toBe(true)
    env.WEBTERM_ORCHESTRATOR_RUN = 'off'
    expect(orchestratorRunEnabled(env)).toBe(false)
  })

  it('approval policy defaults ON and is off only when set explicitly', () => {
    expect(orchestratorRunRequireApproval({})).toBe(true)
    expect(orchestratorRunRequireApproval({ WEBTERM_RUN_REQUIRE_APPROVAL: 'typo' })).toBe(true)
    expect(orchestratorRunRequireApproval({ WEBTERM_RUN_REQUIRE_APPROVAL: 'off' })).toBe(false)
    expect(orchestratorRunRequireApproval({ WEBTERM_RUN_REQUIRE_APPROVAL: '0' })).toBe(false)
  })

  it('explains why server-resolved fields are refused', () => {
    const parsed = parseRunBody({ ...valid, repo: '/tmp/evil' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.result).toEqual({
        status: 400,
        body: {
          error: 'client_controlled_field',
          message: 'repo is resolved server-side and must not be sent',
        },
      })
    }
  })

  it('rejects non-object bodies, arrays and unknown git-hostile baseRefs', () => {
    for (const body of [null, 'x', 1, [valid]]) {
      const parsed = parseRunBody(body)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result).toMatchObject({ status: 400, body: { error: expect.any(String) } })
    }
    for (const baseRef of ['a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b']) {
      const parsed = parseRunBody({ ...valid, baseRef })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toMatchObject({ error: 'invalid_base_ref' })
    }
  })

  it('keeps the prompt byte-for-byte and ignores unknown optional fields', () => {
    const parsed = parseRunBody({ ...valid, prompt: '  spaced  ', extra: true })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.prompt).toBe('  spaced  ')
  })

  it('trims and bounds baseRef', () => {
    const trimmed = parseRunBody({ ...valid, baseRef: '  main  ' })
    expect(trimmed.ok && trimmed.value.baseRef).toBe('main')
    expect(parseRunBody({ ...valid, baseRef: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('rejects non-finite and non-numeric timeouts', () => {
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, '5000', null]) {
      const parsed = parseRunBody({ ...valid, timeoutMs })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toMatchObject({ error: 'invalid_timeout' })
    }
  })
})

describe('resolveWorkerKind', () => {
  it('picks the first configured kind: claude, then opencode, then other builtins', () => {
    expect(resolveWorkerKind({ codex: 'codex', claude: 'claude-work' })).toBe('claude')
    expect(resolveWorkerKind({ codex: 'codex', opencode: 'opencode' })).toBe('opencode')
    expect(resolveWorkerKind({ gemini: 'gemini', codex: 'codex' })).toBe('codex')
    expect(resolveWorkerKind({ claude: '   ', gemini: 'gemini' })).toBe('gemini')
  })

  it('keeps legacy claude when nothing is configured, and falls back to opencode without claude', () => {
    expect(resolveWorkerKind({})).toBe('claude')
    expect(resolveWorkerKind({}, true)).toBe('claude')
    expect(resolveWorkerKind({}, false)).toBe('opencode')
    expect(resolveWorkerKind({ codex: 'codex' }, false)).toBe('codex')
  })
})
