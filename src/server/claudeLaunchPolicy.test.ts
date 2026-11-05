// Policy: every server path that runs Claude builds its argv from the launch profile
// (server/claudeLauncher), so a user's `envman -e claude:x -- claude` applies everywhere. Static scan
// of non-test server sources for a bare `claude` spawn, argv literal, shell line or PATH check.
// Only server/claudeLauncher/** may spell those; an exception elsewhere is a bug, not an allowlist entry.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname)
const ALLOWED_DIR = 'claudeLauncher/'
const Q = `['"\`]`
const PATTERNS: RegExp[] = [
  // spawn('claude', ...), spawn(opts.bin ?? 'claude', ...), Bun.spawn(['claude', ...]), exec*/fork
  new RegExp(`\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\\s*\\(\\s*[^,)]*?${Q}claude${Q}`),
  // argv literal: ['claude', '-p', ...]
  new RegExp(`\\[\\s*${Q}claude${Q}\\s*,\\s*${Q}-`),
  // login-shell line: [shell, '-l', '-c', 'claude -p']
  new RegExp(`${Q}-l?c${Q}\\s*,\\s*${Q}claude\\b`),
  // PATH checks: which('claude'), onPath('claude'), binaryOnPath('claude')
  new RegExp(`\\b(?:which|onPath|binaryOnPath)\\s*\\(\\s*${Q}claude${Q}`),
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) ? [p] : []
  })
}

/** `file:line` of every direct Claude launch outside the launcher. */
function directClaudeLaunches(root = ROOT): string[] {
  const hits: string[] = []
  for (const file of sources(root)) {
    const rel = relative(root, file)
    if (rel.startsWith(ALLOWED_DIR)) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return // comments
      if (PATTERNS.some((re) => re.test(line))) hits.push(`src/server/${rel}:${i + 1}`)
    })
  }
  return hits
}

describe('Claude launch policy', () => {
  it('the patterns catch every known direct form', () => {
    for (const bad of [
      "spawn('claude', args)", "spawn(opts.bin ?? 'claude', argv(), {", "Bun.spawn(['claude', '-p'])",
      "const a = ['claude', '-p', prompt]", "Bun.spawn([shell, '-l', '-c', 'claude -p'], {",
      "which('claude')", "onPath('claude')", "binaryOnPath('claude')",
    ]) expect(PATTERNS.some((re) => re.test(bad)), bad).toBe(true)
    for (const ok of ["const ENGINES = ['claude', 'opencode']", "if (kind === 'claude')", "spawn(cmd, args)"]) {
      expect(PATTERNS.some((re) => re.test(ok)), ok).toBe(false)
    }
  })

  it('no server source launches or PATH-checks claude outside server/claudeLauncher', () => {
    expect(directClaudeLaunches()).toEqual([])
  })
})
