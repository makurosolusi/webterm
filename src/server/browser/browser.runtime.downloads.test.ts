import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDownloadWiring, downloadModeOf } from './browser.runtime.downloads'
import type { Workspace } from '../../shared/workspace'

let root: string | undefined
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

describe('downloadModeOf (Settings > Browser switch)', () => {
  it('saves by default and asks only when the switch is explicitly off', () => {
    expect(downloadModeOf({})).toBe('save')
    expect(downloadModeOf({ WEBTERM_BROWSER_DOWNLOADS_AUTO: 'on' })).toBe('save')
    expect(downloadModeOf({ WEBTERM_BROWSER_DOWNLOADS_AUTO: 'banana' })).toBe('save')
    expect(downloadModeOf({ WEBTERM_BROWSER_DOWNLOADS_AUTO: 'off' })).toBe('ask')
  })

  it('is read live: a flip applies to the next download without a restart', () => {
    const env: Record<string, string | undefined> = {}
    root = mkdtempSync(join(tmpdir(), 'wt-dlw-'))
    const w = createDownloadWiring({ env, dataRoot: root, now: () => 1, workspaces: () => [], profileOf: () => 'p' })
    expect(w.deps.mode()).toBe('save')
    env.WEBTERM_BROWSER_DOWNLOADS_AUTO = 'off'
    expect(w.deps.mode()).toBe('ask')
    w.stop()
  })
})

describe('createDownloadWiring', () => {
  it('finds the profile of a node the host has not opened yet from the board', () => {
    root = mkdtempSync(join(tmpdir(), 'wt-dlw-'))
    const ws = { id: 'w1', nodes: [{ id: 'n1' }] } as unknown as Workspace
    const w = createDownloadWiring({ env: {}, dataRoot: root, now: () => 1, workspaces: () => [ws], profileOf: (n, wsId) => `${wsId}-${n}` })
    expect(w.deps.profileOfNode?.('n1')).toBe('w1-n1')
    expect(w.deps.profileOfNode?.('nope')).toBeUndefined()
    w.stop()
  })
})
