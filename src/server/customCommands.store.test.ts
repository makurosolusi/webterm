import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CUSTOM_COMMAND_MAX_ENTRIES } from '../shared/customCommands'
import { detectCommands } from './customCommands.detect'
import { addCommand, listCommands, loadEntries, removeCommand, whichCommand, type CustomCommandsCtx } from './customCommands.store'

let root: string
let realBin: string
let ctx: CustomCommandsCtx

function tool(dir: string, name: string, body = 'echo "$0 $@"'): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cc-')))
  realBin = join(root, 'real')
  mkdirSync(realBin)
  const binDir = join(root, 'custom-bin')
  ctx = { binDir, registryFile: join(root, 'custom-commands.json'), pathEnv: () => `${binDir}:${realBin}:/usr/bin:/bin`, now: () => 1000 }
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('addCommand link', () => {
  it('symlinks to an existing executable and reports found', () => {
    const target = tool(realBin, 'envman')
    const r = addCommand(ctx, { name: 'em', kind: 'link', target, note: 'wrapper' })
    expect(r).toMatchObject({ ok: true, data: { name: 'em', found: true, resolved: target, shadows: null, note: 'wrapper' } })
    expect(lstatSync(join(ctx.binDir, 'em')).isSymbolicLink()).toBe(true)
    expect(statSync(ctx.binDir).mode & 0o777).toBe(0o700)
    expect(statSync(ctx.registryFile).mode & 0o777).toBe(0o600)
  })
  it('rejects relative, traversal, missing, non-executable and self-referencing targets', () => {
    const plain = join(realBin, 'plain'); writeFileSync(plain, 'x')
    const inside = tool(realBin, 'ok'); addCommand(ctx, { name: 'ok', kind: 'link', target: inside })
    for (const target of ['envman', `${realBin}/../real/ok`, join(realBin, 'nope'), plain, realBin, join(ctx.binDir, 'ok'), '', '\0']) {
      expect(addCommand(ctx, { name: 'bad', kind: 'link', target }), target).toMatchObject({ ok: false, code: 'invalid_target' })
    }
    expect(existsSync(join(ctx.binDir, 'bad'))).toBe(false)
  })
  it('flags a command that replaces a binary elsewhere on PATH', () => {
    tool(realBin, 'op'); const mine = tool(root, 'my-op')
    expect(addCommand(ctx, { name: 'op', kind: 'link', target: mine })).toMatchObject({ ok: true, data: { shadows: join(realBin, 'op') } })
  })
  it('reports missing once the target disappears, without running anything', () => {
    const target = tool(realBin, 'gone', `echo ran > ${join(root, 'ran')}`)
    addCommand(ctx, { name: 'gone', kind: 'link', target })
    expect(listCommands(ctx)[0].found).toBe(true)
    unlinkSync(target)
    expect(listCommands(ctx)[0]).toMatchObject({ found: false, resolved: null })
    expect(existsSync(join(root, 'ran'))).toBe(false)
  })
})

describe('addCommand shim', () => {
  it('runs a fixed argv with extra args and never interprets hostile words', () => {
    const marker = join(root, 'pwned')
    const r = addCommand(ctx, { name: 'say', kind: 'shim', argv: ['printf', '%s|', `; touch ${marker}`, "it's", '$(touch ' + marker + ')', 'a\nb', 'ünï'] })
    expect(r).toMatchObject({ ok: true, data: { found: true } })
    const out = spawnSync(join(ctx.binDir, 'say'), ['extra "$HOME"'], { encoding: 'utf8' })
    expect(out.stdout).toBe(`; touch ${marker}|it's|$(touch ${marker})|a\nb|ünï|extra "$HOME"|`)
    expect(existsSync(marker)).toBe(false)
    expect(statSync(join(ctx.binDir, 'say')).mode & 0o111).toBeTruthy()
  })
  it('stores argv only, nothing else (no env values)', () => {
    addCommand(ctx, { name: 'ce', kind: 'shim', argv: ['envman', 'run', '--', 'claude'] })
    expect(JSON.parse(readFileSync(ctx.registryFile, 'utf8')).entries[0]).toEqual({ name: 'ce', kind: 'shim', argv: ['envman', 'run', '--', 'claude'], addedAt: 1000 })
  })
  it('claude wrapping claude resolves the real one instead of looping', () => {
    tool(realBin, 'claude', 'echo "real $@"')
    expect(addCommand(ctx, { name: 'claude', kind: 'shim', argv: ['claude', '--x'] })).toMatchObject({ ok: false, code: 'reserved_name' })
    expect(addCommand(ctx, { name: 'claude', kind: 'shim', argv: ['claude', '--x'], force: true }).ok).toBe(true)
    const out = spawnSync(join(ctx.binDir, 'claude'), ['hi'], { encoding: 'utf8', env: { PATH: ctx.pathEnv() }, timeout: 5000 })
    expect(out.stdout.trim()).toBe('real --x hi')
  })
  it('reports missing when the program is not on PATH', () => {
    expect(addCommand(ctx, { name: 'nx', kind: 'shim', argv: ['no-such-program-xyz'] })).toMatchObject({ ok: true, data: { found: false, resolved: null } })
  })
  it('rejects bad argv, kind and note', () => {
    expect(addCommand(ctx, { name: 'a', kind: 'shim', argv: [] })).toMatchObject({ ok: false, code: 'invalid_argv' })
    expect(addCommand(ctx, { name: 'a', kind: 'weird' as 'shim' })).toMatchObject({ ok: false, code: 'invalid_kind' })
    expect(addCommand(ctx, { name: 'a', kind: 'shim', argv: ['x'], note: 'n'.repeat(201) })).toMatchObject({ ok: false, code: 'invalid_note' })
    expect(addCommand(ctx, { name: '../evil', kind: 'shim', argv: ['x'] })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(existsSync(ctx.registryFile)).toBe(false)
  })
})

describe('registry rules', () => {
  it('refuses duplicates unless force, and force replaces the entry', () => {
    addCommand(ctx, { name: 'dup', kind: 'shim', argv: ['echo', 'one'] })
    expect(addCommand(ctx, { name: 'dup', kind: 'shim', argv: ['echo', 'two'] })).toMatchObject({ ok: false, code: 'duplicate' })
    expect(addCommand(ctx, { name: 'dup', kind: 'shim', argv: ['echo', 'two'], force: true }).ok).toBe(true)
    expect(loadEntries(ctx)).toHaveLength(1)
    expect(spawnSync(join(ctx.binDir, 'dup'), { encoding: 'utf8' }).stdout.trim()).toBe('two')
  })
  it('caps the number of entries', () => {
    for (let i = 0; i < CUSTOM_COMMAND_MAX_ENTRIES; i++) expect(addCommand(ctx, { name: `c${i}`, kind: 'shim', argv: ['true'] }).ok).toBe(true)
    expect(addCommand(ctx, { name: 'over', kind: 'shim', argv: ['true'] })).toMatchObject({ ok: false, code: 'limit_reached' })
    expect(addCommand(ctx, { name: 'c0', kind: 'shim', argv: ['true'], force: true }).ok).toBe(true)
  })
  it('writes atomically: no temp files remain and a malformed registry throws with its path', () => {
    addCommand(ctx, { name: 'ok', kind: 'shim', argv: ['true'] })
    expect(readdirSync(root).filter((f) => f.includes('.tmp-'))).toEqual([])
    expect(readdirSync(ctx.binDir).filter((f) => f.startsWith('.tmp-'))).toEqual([])
    writeFileSync(ctx.registryFile, '{nope')
    expect(() => loadEntries(ctx)).toThrow(/malformed/)
  })
  it('removes the entry and its file; unknown names are not_found', () => {
    addCommand(ctx, { name: 'bye', kind: 'shim', argv: ['true'] })
    expect(removeCommand(ctx, 'bye')).toEqual({ ok: true, data: { name: 'bye' } })
    expect(existsSync(join(ctx.binDir, 'bye'))).toBe(false)
    expect(loadEntries(ctx)).toEqual([])
    expect(removeCommand(ctx, 'bye')).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('returns a clear error, not a crash, when the bin dir is read-only', () => {
    mkdirSync(ctx.binDir, { mode: 0o500 })
    if (process.getuid?.() === 0) return // root ignores mode bits
    expect(addCommand(ctx, { name: 'ro', kind: 'shim', argv: ['true'] })).toMatchObject({ ok: false, code: 'bin_dir_readonly' })
    writeFileSync(ctx.registryFile, JSON.stringify({ version: 1, entries: [{ name: 'ro', kind: 'shim', argv: ['true'], addedAt: 1 }] }))
    expect(removeCommand(ctx, 'ro')).toMatchObject({ ok: false, code: 'bin_dir_readonly' })
    chmodSync(ctx.binDir, 0o700)
  })
})

describe('which and detect', () => {
  it('which prefers the managed dir and falls back to PATH', () => {
    tool(realBin, 'op'); const mine = tool(root, 'my-op')
    expect(whichCommand(ctx, 'op')).toEqual({ name: 'op', path: join(realBin, 'op'), custom: false })
    addCommand(ctx, { name: 'op', kind: 'link', target: mine })
    expect(whichCommand(ctx, 'op')).toEqual({ name: 'op', path: mine, custom: true })
    expect(whichCommand(ctx, 'nothing-here')).toEqual({ name: 'nothing-here', path: null, custom: false })
  })
  it('detect reports candidates found on PATH', () => {
    tool(realBin, 'doppler')
    const d = detectCommands(ctx)
    expect(d.find((c) => c.name === 'doppler')).toMatchObject({ name: 'doppler', path: join(realBin, 'doppler'), found: true, source: 'path' })
    expect(d.find((c) => c.name === 'envman')?.found).toBe(false)
  })
})
