// Resolver + node profile application + the Test endpoint (no server boot, no DB).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-launcher-data-`)
})

const { applyNodeClaudeProfile, claudeCommand, centralClaudeLaunch, registerClaudeLaunchSettings, resolveClaudeLaunch } = await import('./claudeLauncher')
const { claudeLaunchRoute } = await import('./claudeLauncher.api')
const { DEFAULT_SETTINGS } = await import('../../shared/settings')

const SETTINGS = {
  claudeLaunchProfiles: [{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus -- claude --model opus' }],
  defaultClaudeProfileId: 'm',
  centralClaudeProfileId: '',
}
afterEach(() => registerClaudeLaunchSettings(() => DEFAULT_SETTINGS))

describe('resolver', () => {
  it('claudeCommand appends args after the profile argv; central follows the default', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    expect(claudeCommand(['-p', 'hi'])).toEqual(['envman', '-e', 'claude:malik-opus', '--', 'claude', '--model', 'opus', '-p', 'hi'])
    expect(resolveClaudeLaunch('default').argv).toEqual(['claude'])
    expect(centralClaudeLaunch().profile.id).toBe('m')
  })
  it('unregistered = defaults = bare claude', () => {
    expect(claudeCommand(['--version'])).toEqual(['claude', '--version'])
  })
})

describe('applyNodeClaudeProfile', () => {
  it('a claude node with a recorded profile launches through it (client cmd ignored)', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    const r = applyNodeClaudeProfile({ agentId: 'claude', cmd: 'claude', claudeProfileId: 'm' })
    expect(r.msg.cmd).toBe('envman -e claude:malik-opus -- claude --model opus')
    expect(r.notice).toBeUndefined()
  })
  it('a deleted profile falls back to Default with a visible notice', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    const r = applyNodeClaudeProfile({ agentId: 'claude', cmd: 'envman -e old -- claude', claudeProfileId: 'gone' })
    expect(r.msg.cmd).toBe('claude')
    expect(r.notice).toMatch(/launch profile no longer exists — launching with "Default"/)
  })
  it('other agents and legacy nodes (no profile id) pass through untouched', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    const codex = { agentId: 'codex', cmd: 'codex', claudeProfileId: 'm' }
    expect(applyNodeClaudeProfile(codex).msg).toBe(codex)
    const legacy = { agentId: 'claude', cmd: 'claude-work' }
    expect(applyNodeClaudeProfile(legacy).msg).toBe(legacy)
  })
  it('quotes tokens so the login shell sees each as one argument', () => {
    registerClaudeLaunchSettings(() => ({ ...SETTINGS, claudeLaunchProfiles: [{ id: 'q', name: 'Q', command: `envman -e 'a b' -- claude` }] }))
    expect(applyNodeClaudeProfile({ agentId: 'claude', cmd: 'claude', claudeProfileId: 'q' }).msg.cmd).toBe(`envman -e 'a b' -- claude`)
  })
})

describe('POST /api/claude-launch/test', () => {
  const req = (body: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', host: 'h', origin: 'http://h' }): IncomingMessage =>
    Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers }) as unknown as IncomingMessage
  const url = new URL('http://h/api/claude-launch/test')
  const probe = vi.fn(async (launch: { profile: { id: string; name: string } }) => ({ ok: true, profile: launch.profile, steps: [] }))
  const deps = { isNodeToken: () => false, refreshCentral: vi.fn(), probe: probe as never }

  it('probes a saved profile and returns its normalisation warnings', async () => {
    registerClaudeLaunchSettings(() => ({ ...SETTINGS, claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'envman -e x claude' }] }))
    const r = await claudeLaunchRoute(req({ profileId: 'w' }), url, deps)
    expect(r?.status).toBe(200)
    expect(r?.body).toMatchObject({ ok: true, profile: { id: 'w' }, warnings: ['envman needs "--" before the command it runs.'] })
  })
  it('central: true probes the Central profile and drops the cached preflight', async () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    const r = await claudeLaunchRoute(req({ central: true }), url, deps)
    expect(r?.body).toMatchObject({ profile: { id: 'm' } })
    expect(deps.refreshCentral).toHaveBeenCalled()
  })
  it('404 for an unknown profile, 400 without a target, 403 for agents / non-browser callers', async () => {
    expect((await claudeLaunchRoute(req({ profileId: 'nope' }), url, deps))?.status).toBe(404)
    expect((await claudeLaunchRoute(req({}), url, deps))?.status).toBe(400)
    expect((await claudeLaunchRoute(req({ central: true }, {}), url, deps))?.status).toBe(403)
    expect(await claudeLaunchRoute(req({}), new URL('http://h/api/other'), deps)).toBeNull()
  })
})
