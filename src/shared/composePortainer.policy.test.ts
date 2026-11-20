import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Scanner: compose-portainer.yml must keep the Chrome sandbox safe and stay deployable from a repository checkout.
const root = join(__dirname, '..', '..')
const text = readFileSync(join(root, 'compose-portainer.yml'), 'utf8')
const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

describe('compose-portainer.yml', () => {
  it('has no privilege or sandbox escapes', () => {
    for (const bad of ['seccomp=unconfined', '--no-sandbox', 'cap_add', 'privileged', 'env_file', 'build:']) {
      expect(code, bad).not.toContain(bad)
    }
  })

  it('uses a relative path only for the default seccomp profile, and it exists', () => {
    const rel = code.match(/\.\/[\w./-]*/g) ?? []
    expect(rel.every((p) => p === './docker/chrome.seccomp.json')).toBe(true)
    expect(code).toContain('seccomp=${WEBTERM_SECCOMP:-./docker/chrome.seccomp.json}')
    expect(existsSync(join(root, 'docker/chrome.seccomp.json'))).toBe(true)
  })

  it('declares the named volumes it mounts', () => {
    for (const v of ['webterm-data', 'webterm-home', 'webterm-workspace']) {
      expect(code).toMatch(new RegExp(`^  ${v}:`, 'm'))
    }
  })
})
