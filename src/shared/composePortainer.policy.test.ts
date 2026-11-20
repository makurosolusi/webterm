import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Scanner: the three compose files share one hardening posture. Seccomp defaults to unconfined (so the Portainer
// Web editor works without a file) but ONLY through ${WEBTERM_SECCOMP:-unconfined}; Chrome's own sandbox stays on.
const root = join(__dirname, '..', '..')
const stripComments = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
const files = ['compose-portainer.yml', 'compose.ghcr.yml', 'docker-compose.yml']
const code = (f: string) => stripComments(readFileSync(join(root, f), 'utf8'))

describe.each(files)('%s', (f) => {
  const c = code(f)

  it('defaults seccomp to unconfined only through WEBTERM_SECCOMP', () => {
    expect(c).toContain('seccomp=${WEBTERM_SECCOMP:-unconfined}')
    expect(c.replace('seccomp=${WEBTERM_SECCOMP:-unconfined}', '')).not.toMatch(/seccomp|unconfined/)
  })

  it('keeps the hardening and has no privilege escapes', () => {
    expect(c).toMatch(/cap_drop:\s*\[ALL\]/)
    expect(c).toContain('no-new-privileges:true')
    for (const bad of ['cap_add', 'privileged', 'network_mode', 'docker.sock', 'no-sandbox']) {
      expect(c, bad).not.toContain(bad)
    }
  })
})

describe.each(files)('%s healthcheck', (f) => {
  const test = /test: \[.*\]/.exec(code(f))?.[0] ?? ''
  it('probes GET / with -f, never the token-gated /api (each probe would log an auth rejection)', () => {
    expect(test).toMatch(/curl -f\S* .*:\$\$\{PORT:-8700\}\/"/)
    expect(test).not.toContain('/api')
  })
})

describe('auth gate leaves the static UI alone', () => {
  it('only /api paths reach the gate that logs a rejection', () => {
    const src = readFileSync(join(root, 'src/server/server.main.ts'), 'utf8')
    expect(src).toContain('url.pathname.startsWith(API_PREFIX) && !allowed(req, url)')
    expect(src).not.toMatch(/resolveAsset[^\n]*allowed\(/)
  })
})

describe('compose-portainer.yml', () => {
  const c = code('compose-portainer.yml')

  it('needs no file from a checkout and declares no env_file or build', () => {
    expect(c).not.toMatch(/\.\//)
    for (const bad of ['env_file', 'build:']) expect(c, bad).not.toContain(bad)
  })

  it('declares the named volumes it mounts', () => {
    for (const v of ['webterm-data', 'webterm-home', 'webterm-workspace']) {
      expect(c).toMatch(new RegExp(`^  ${v}:`, 'm'))
    }
  })
})

describe('chrome sandbox stays on', () => {
  it('keeps the strict profile in the repo', () => {
    expect(existsSync(join(root, 'docker/chrome.seccomp.json'))).toBe(true)
  })

  it('never passes no-sandbox in the Dockerfile, docker/ scripts or compose env', () => {
    const dockerDir = readdirSync(join(root, 'docker')).filter((n) => !n.endsWith('.json') && statSync(join(root, 'docker', n)).isFile())
    const paths = ['Dockerfile', ...dockerDir.map((n) => `docker/${n}`), ...files]
    for (const p of paths) expect(stripComments(readFileSync(join(root, p), 'utf8')), p).not.toMatch(/no-sandbox/i)
  })
})
