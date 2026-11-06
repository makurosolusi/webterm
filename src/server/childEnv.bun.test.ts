// sec-208-7 lock. (1) Behaviour: a repo setup script and a routine precheck run user code, and must
// not see the server's own vars (token, bot secrets, anything WEBTERM_*). They used to inherit
// `process.env` whole. (2) Policy: every child_process call in server code passes an explicit `env`
// (built by childEnv / gitEnv / ptyEnv / an allowlist), except the reasoned exceptions below.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { childEnv } from './childEnv'
import { runSetupScript } from './workspaceWorktree.setup'
import { runPrecheck } from './routines/routinePrecheck'

/** test-only canaries: a WEBTERM_* var and the bot token name, both stripped by the PTY filter. */
const CANARIES = ['WEBTERM_CHILDENV_CANARY_227', 'TELEGRAM_BOT_TOKEN'] as const
const saved = CANARIES.map((k) => process.env[k])
for (const k of CANARIES) process.env[k] = 'test-only-value'
const dir = mkdtempSync(join(tmpdir(), 'wt-childenv-'))
afterAll(() => {
  CANARIES.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
  rmSync(dir, { recursive: true, force: true })
})

/** Shell that prints only whether each canary is set (never its value). */
const PROBE = CANARIES.map((k) => `echo "${k}=\${${k}:+set}"`).join('; ')
const NONE_SET = CANARIES.map((k) => `${k}=`)

describe('children that run user code get the filtered env (sec-208-7)', () => {
  test('childEnv drops server vars, keeps PATH, and lets explicit extras through', () => {
    const env = childEnv({ WEBTERM_ROOT_PATH: '/r' })
    for (const k of CANARIES) expect(k in env).toBe(false)
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.WEBTERM_ROOT_PATH).toBe('/r')
  })

  test('a repo setup script does not see server secrets', async () => {
    writeFileSync(join(dir, 'webterm.yaml'), `scripts:\n  setup: |\n    ${PROBE}\n`)
    const r = await runSetupScript(dir, dir)
    expect(r.ok).toBe(true)
    expect(r.output.trim().split('\n')).toEqual(NONE_SET)
  })

  test('a routine precheck does not see server secrets', async () => {
    const r = await runPrecheck(PROBE, dir, 10)
    expect(r.exitCode).toBe(0)
    expect(r.output.trim().split('\n')).toEqual(NONE_SET)
  })
})

// ---- policy: no child_process call without an explicit env ----

const SERVER = import.meta.dirname
const TEST_FILE = /\.(test|testutil)\.ts$/
/** `file:callee` -> why inheriting the server env is acceptable there. */
const INHERITS_OK = new Map<string, string>([
  ['pty.ts:execFileSync', 'fixed system `ps` lookup of a pid, no user code'],
  ['routines/routinesRuntime.ts:spawnProcess', 'fixed system `caffeinate -w <pid>`, no user code'],
])

function sources(at: string): string[] {
  return readdirSync(at).flatMap((name) => {
    const p = join(at, name)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') && !TEST_FILE.test(p) ? [p] : []
  })
}

/** Text between the `(` at `open` and its matching `)`. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** `callee` of every child_process call in `src` (incl. promisify aliases) that passes no `env`. */
function callsWithoutEnv(raw: string): string[] {
  // Comments mention `execFile (...)` in prose; a `//` inside a string ('http://') is kept.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const imported = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/.exec(src)?.[1] ?? ''
  const names = imported.split(',').map((s) => s.trim().split(/\s+as\s+/).pop() ?? '').filter((n) => n && !n.startsWith('type '))
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*promisify\(\s*(\w+)\s*\)/g)) if (names.includes(m[2])) names.push(m[1])
  const found: string[] = []
  for (const name of names) {
    for (const m of src.matchAll(new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g'))) {
      const open = (m.index ?? 0) + m[0].length - 1
      const args = argsAt(src, open)
      const after = src.slice(open + args.length + 2).trimStart()
      if (/function\s*$/.test(src.slice(0, m.index)) || after.startsWith('{')) continue // a definition, not a call
      if (!/\benv\b/.test(args)) found.push(name)
    }
  }
  return found
}

/** Files that may copy the whole server env, and why. */
const SPREADS_OK = new Map<string, string>([
  ['secrets/secret.broker.ts', 'copies then deletes every SECRET_ENV_NAMES entry itself'],
])

// An explicit `env` is not enough: `env: { ...process.env, X }` is how setup scripts leaked before.
test('no spawning server file copies the whole process.env into a child env', () => {
  const offenders = sources(SERVER)
    .map((p) => relative(SERVER, p))
    .filter((rel) => !SPREADS_OK.has(rel))
    .filter((rel) => {
      const src = readFileSync(join(SERVER, rel), 'utf8')
      return src.includes("'node:child_process'") && /\.\.\.process\.env\b(?!\s*\[)|env:\s*process\.env\b/.test(src)
    })
  expect(offenders).toEqual([])
})

test('every child_process call in server code passes an explicit env', () => {
  const offenders = sources(SERVER).flatMap((p) => {
    const rel = relative(SERVER, p)
    const src = readFileSync(p, 'utf8')
    if (!src.includes("'node:child_process'")) return []
    return callsWithoutEnv(src).filter((callee) => !INHERITS_OK.has(`${rel}:${callee}`)).map((callee) => `${rel}:${callee}`)
  })
  expect(offenders).toEqual([])
})
