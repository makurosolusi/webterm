import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectAgentEngine, onPath } from './runtimeDetect'

const only = (...bins: string[]) => (bin: string) => bins.includes(bin)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('detectAgentEngine', () => {
  it('claude ada -> claude (walau opencode juga ada)', () => {
    expect(detectAgentEngine({}, only('claude', 'opencode'))).toBe('claude')
  })
  it('hanya opencode -> opencode', () => {
    expect(detectAgentEngine({}, only('opencode'))).toBe('opencode')
  })
  it('tak ada CLI -> mock', () => {
    expect(detectAgentEngine({}, only())).toBe('mock')
  })
  it('WEBTERM_CENTRAL_RUNTIME eksplisit menang, termasuk off', () => {
    expect(detectAgentEngine({ WEBTERM_CENTRAL_RUNTIME: ' Mock ' }, only('claude'))).toBe('mock')
    expect(detectAgentEngine({ WEBTERM_CENTRAL_RUNTIME: 'off' }, only('claude'))).toBe('off')
  })
  it('nilai eksplisit tak dikenal diabaikan: tetap deteksi', () => {
    expect(detectAgentEngine({ WEBTERM_CENTRAL_RUNTIME: 'gpt' }, only('opencode'))).toBe('opencode')
  })
})

describe('onPath', () => {
  it('menemukan berkas eksekusi di PATH palsu dan menolak yang tidak ada/tak eksekusi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rtdetect-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\n')
    chmodSync(join(dir, 'claude'), 0o755)
    writeFileSync(join(dir, 'opencode'), '')
    chmodSync(join(dir, 'opencode'), 0o644)
    expect(onPath('claude', dir)).toBe(true)
    expect(onPath('opencode', dir)).toBe(false)
    expect(onPath('nope', dir)).toBe(false)
    expect(onPath('claude', '')).toBe(false)
  })
})
