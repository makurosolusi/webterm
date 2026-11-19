import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from './cli/cliArgs'
import { buildWebtermCli } from './cli/cli.launcher'
import { TOOL_INDEX } from './cli/cli.registry'
import { customBinPath, putCustomBinOnProcessPath, withCustomBin } from './customBinPath'
import { customCommandsApi } from './customCommands.api'
import { parseAdd, runCommandCli } from './customCommands.cli'
import type { CustomCommandsCtx } from './customCommands.store'
import { ptyEnv } from './ptyShell'

let root: string
let ctx: CustomCommandsCtx
let tool: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cc-api-')))
  tool = join(root, 'envman')
  writeFileSync(tool, '#!/bin/sh\n'); chmodSync(tool, 0o755)
  ctx = { binDir: join(root, 'bin'), registryFile: join(root, 'cc.json'), pathEnv: () => `${root}:/usr/bin`, now: () => 1 }
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const call = (method: string, path: string, body?: unknown) =>
  customCommandsApi(ctx, method, new URL(path, 'http://x'), async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})))

describe('custom commands HTTP contract', () => {
  it('ignores other paths', async () => { expect(await call('GET', '/api/other')).toBeNull() })
  it('add -> 201, list, which, remove', async () => {
    const add = await call('POST', '/api/custom-commands', { name: 'ce', kind: 'shim', argv: ['envman', 'run'] })
    expect(add).toMatchObject({ status: 201, body: { command: { name: 'ce', kind: 'shim', found: true, resolved: tool } } })
    expect(await call('GET', '/api/custom-commands')).toMatchObject({ status: 200, body: { binDir: ctx.binDir, commands: [{ name: 'ce' }] } })
    expect(await call('GET', '/api/custom-commands/which?name=ce')).toMatchObject({ status: 200, body: { custom: true } })
    expect(await call('GET', '/api/custom-commands/detect')).toMatchObject({ status: 200, body: { candidates: expect.any(Array) } })
    expect(await call('DELETE', '/api/custom-commands/ce')).toEqual({ status: 200, body: { removed: 'ce' } })
    expect(await call('POST', '/api/custom-commands/remove', { name: 'ce' })).toMatchObject({ status: 404, body: { error: 'not_found' } })
  })
  it('maps errors: 400 validation, 409 duplicate, invalid json, 405', async () => {
    expect(await call('POST', '/api/custom-commands', { name: 'Bad', kind: 'shim', argv: ['x'] })).toMatchObject({ status: 400, body: { error: 'invalid_name' } })
    expect(await call('POST', '/api/custom-commands', { name: 'git', kind: 'shim', argv: ['x'], force: true })).toMatchObject({ status: 400, body: { error: 'reserved_name' } })
    expect(await call('POST', '/api/custom-commands', { name: 'a', kind: 'link', target: '../x' })).toMatchObject({ status: 400, body: { error: 'invalid_target' } })
    await call('POST', '/api/custom-commands', { name: 'a', kind: 'shim', argv: ['x'] })
    expect(await call('POST', '/api/custom-commands', { name: 'a', kind: 'shim', argv: ['x'] })).toMatchObject({ status: 409, body: { error: 'duplicate' } })
    expect(await call('POST', '/api/custom-commands', 'not json')).toMatchObject({ status: 400, body: { error: 'invalid_json' } })
    expect(await call('GET', '/api/custom-commands/which')).toMatchObject({ status: 400 })
    expect(await call('PUT', '/api/custom-commands')).toMatchObject({ status: 405 })
  })
})

describe('extra tool dirs and rescan', () => {
  it('paths: add 201, list, remove, rescan, errors', async () => {
    const dir = join(root, 'tools'); mkdirSync(dir)
    expect(await call('POST', '/api/custom-commands/paths', { dir })).toMatchObject({ status: 201, body: { managed: ctx.binDir, extra: [{ dir, safe: true }] } })
    expect(await call('GET', '/api/custom-commands/paths')).toMatchObject({ status: 200, body: { extra: [{ dir }], platformDir: expect.stringMatching(/^(darwin|linux|windows)-(arm64|amd64)/) } })
    expect(await call('POST', '/api/custom-commands/paths', { dir })).toMatchObject({ status: 409, body: { error: 'duplicate' } })
    expect(await call('POST', '/api/custom-commands/paths', { dir: 'rel' })).toMatchObject({ status: 400, body: { error: 'invalid_path_dir' } })
    expect(await call('POST', '/api/custom-commands/paths/remove', { dir })).toMatchObject({ status: 200, body: { extra: [] } })
    expect(await call('DELETE', '/api/custom-commands/paths?dir=' + encodeURIComponent(dir))).toMatchObject({ status: 404 })
    expect(await call('POST', '/api/custom-commands/rescan')).toMatchObject({ status: 200, body: { added: expect.any(Number) } })
  })
  it('CLI path add/list/remove', () => {
    const dir = join(root, 'tools'); mkdirSync(dir)
    let out = ''
    const run = (...a: string[]) => runCommandCli(a, ctx, { out: (t) => { out += t }, err: (t) => { out += t } })
    expect(run('path', 'add', dir)).toBe(0)
    expect(run('path', 'list')).toBe(0)
    expect(out).toContain(`extra:   ${dir}`)
    expect(run('path', 'remove', dir)).toBe(0)
    expect(run('path', 'add', 'rel')).toBe(1)
    expect(run('path', 'bogus')).toBe(2)
    expect(run('detect')).toBe(0)
  })
})

describe('managed PATH', () => {
  it('customBinPath honours WEBTERM_CUSTOM_BIN, else <dataDir>/custom-bin', () => {
    expect(customBinPath({ WEBTERM_CUSTOM_BIN: '/data/custom-bin', WEBTERM_DATA_DIR: '/x' })).toBe('/data/custom-bin')
    expect(customBinPath({ WEBTERM_DATA_DIR: '/x' })).toBe('/x/custom-bin')
  })
  it('withCustomBin puts the dir first once', () => {
    expect(withCustomBin('/usr/bin:/d:/bin', '/d')).toBe('/d:/usr/bin:/bin')
    expect(withCustomBin(undefined, '/d')).toBe('/d')
  })
  it('ptyEnv has the custom bin first even though WEBTERM_* is stripped from the child', () => {
    const env = ptyEnv({ PATH: '/usr/bin:/bin', WEBTERM_CUSTOM_BIN: '/data/custom-bin' }, { interactive: true, strip: new Set() })
    expect(env.PATH).toBe('/data/custom-bin:/usr/bin:/bin')
    expect(env.WEBTERM_CUSTOM_BIN).toBeUndefined()
  })
  it('boot step prepends to the server PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', WEBTERM_CUSTOM_BIN: '/c' }
    putCustomBinOnProcessPath(env)
    expect(env.PATH).toBe('/c:/usr/bin')
  })
})

describe('webterm command CLI (person)', () => {
  const run = (...args: string[]) => {
    let out = ''; let err = ''
    const code = runCommandCli(args, ctx, { out: (t) => { out += t }, err: (t) => { err += t } })
    return { code, out, err }
  }
  it('parses add forms', () => {
    expect(parseAdd(['n', '--link', '/a/b'])).toEqual({ name: 'n', kind: 'link', target: '/a/b' })
    expect(parseAdd(['n', '--shim', '--note', 'x', '--force', '--', 'envman', '--flag', 'v'])).toEqual({ name: 'n', kind: 'shim', note: 'x', force: true, argv: ['envman', '--flag', 'v'] })
    expect(parseAdd(['n'])).toMatch(/needs --link/)
    expect(parseAdd(['--link'])).toMatch(/name first/)
    expect(parseAdd(['n', '--bogus'])).toMatch(/unknown option/)
    expect(parseAdd(['n', '--link'])).toMatch(/needs a value/)
  })
  it('add, list, which, remove', () => {
    expect(run('list')).toMatchObject({ code: 0, out: 'No custom commands registered.\n' })
    expect(run('add', 'em', '--link', tool)).toMatchObject({ code: 0, out: `Added em (link) -> ${tool}\n` })
    expect(run('add', 'em', '--link', tool)).toMatchObject({ code: 1, err: expect.stringContaining('duplicate') })
    expect(run('list').out).toContain('found')
    expect(JSON.parse(run('list', '--json').out)[0]).toMatchObject({ name: 'em', found: true })
    expect(run('which', 'em')).toMatchObject({ code: 0, out: `${tool}  (custom command)\n` })
    expect(run('which', 'zzz').code).toBe(1)
    expect(run('remove', 'em')).toMatchObject({ code: 0, out: 'Removed em\n' })
    expect(run('remove', 'em').code).toBe(1)
    expect(run('add').code).toBe(2)
    expect(run('bogus').code).toBe(2)
  })
  it('warns when the command replaces a system binary', () => {
    expect(run('add', 'envman', '--shim', '--', 'true').out).toContain(`replaces ${tool}`)
  })
  it('is routed from the server entry argv', () => {
    expect(parseArgs(['command', 'list'])).toEqual({ kind: 'command', args: ['list'] })
  })
})

describe('agent side (capabilities + launcher)', () => {
  it('registers list/detect R0 and add/remove R2 in the tools registry', () => {
    expect(['command.list', 'command.detect'].map((n) => TOOL_INDEX.get(n)?.tier)).toEqual(['R0', 'R0'])
    expect(['command.add', 'command.remove'].map((n) => TOOL_INDEX.get(n)?.tier)).toEqual(['R2', 'R2'])
  })
  it('launcher dispatches `command` and stays valid sh', async () => {
    const script = buildWebtermCli()
    expect(script).toContain('command) cmd_command')
    const { spawnSync } = await import('node:child_process')
    expect(spawnSync('sh', ['-n'], { input: script }).status).toBe(0)
  })
})
