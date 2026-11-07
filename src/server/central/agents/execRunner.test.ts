import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { scrubExecEnv, startExec } from './execRunner'

const cwd = realpathSync(mkdtempSync(`${tmpdir()}/execrunner-`))
const node = (script: string, extra: Partial<Parameters<typeof startExec>[0]> = {}) =>
  startExec({ argv: [process.execPath, '-e', script], cwd, timeoutMs: 15_000, ...extra })

describe('scrubExecEnv', () => {
  it('drops WEBTERM_/NODETERM_ names, wcap_ values, non-allowlisted vars; keeps PATH and overrides', () => {
    const out = scrubExecEnv({ PATH: '/bin', HOME: '/h', WEBTERM_TOKEN: 'a', NODETERM_NODE_ID: 'b', RANDOM_VAR: 'c', LANG: 'wcap_leak' }, { HOME: '/sandbox', WEBTERM_X: 'y', XDG_CONFIG_HOME: '/sandbox/c' })
    expect(out).toEqual({ PATH: '/bin', HOME: '/sandbox', XDG_CONFIG_HOME: '/sandbox/c' })
  })
})

describe('startExec', () => {
  it('runs with a scrubbed env: no WEBTERM_/NODETERM_/wcap values reach the child', async () => {
    const source = { PATH: process.env.PATH, WEBTERM_ROOT_TOKEN: 'secret-root', NODETERM_NODE_ID: 'n1', MY_TOKEN: 'wcap_abc', ANTHROPIC_API_KEY: 'sk-test-provider' }
    const out = await node('console.log(JSON.stringify(process.env))', { env: source }).done
    const env = JSON.parse(out.tail.trim()) as Record<string, string>
    expect(Object.keys(env).some((k) => /^(WEBTERM_|NODETERM_)/.test(k))).toBe(false)
    expect(out.tail).not.toContain('secret-root')
    expect(out.tail).not.toContain('wcap_')
    expect(env.MY_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-provider')
  })
  it('passes argv as an array: shell metacharacters stay literal data', async () => {
    const hostile = '$(echo pwned); `id` && echo pwned2'
    const out = await startExec({ argv: [process.execPath, '-e', 'console.log(process.argv[1])', hostile], cwd, timeoutMs: 15_000 }).done
    expect(out.exitCode).toBe(0)
    expect(out.tail.trim()).toBe(hostile)
  })
  it('captures the last JSONL object, ignoring non-JSON lines, and the exit code', async () => {
    const out = await node('console.log("banner"); console.log(JSON.stringify({type:"a"})); console.log(JSON.stringify({type:"turn.completed",n:2})); process.exit(0)').done
    expect(out.exitCode).toBe(0)
    expect(out.lastEvent).toEqual({ type: 'turn.completed', n: 2 })
    await expect(node('process.exit(3)').done).resolves.toMatchObject({ exitCode: 3, timedOut: false })
  })
  it('kills on timeout and on demand', async () => {
    const slow = 'setInterval(()=>{},1000)'
    const timed = await node(slow, { timeoutMs: 100 }).done
    expect(timed).toMatchObject({ timedOut: true, killed: true, exitCode: null })
    const h = node(slow)
    h.kill()
    expect(await h.done).toMatchObject({ timedOut: false, killed: true })
  })
  it('reports a missing executable by errno code instead of throwing', async () => {
    const out = await startExec({ argv: ['/definitely/not/here'], cwd, timeoutMs: 5000 }).done
    expect(out).toMatchObject({ exitCode: null, error: 'ENOENT' })
  })
  it('rejects bad specs before spawning anything', () => {
    for (const bad of [{ argv: [] }, { argv: [''] }, { argv: ['a\0b'] }, { argv: 'ls -la' as never }, { argv: ['ls'], cwd: 'rel' }, { argv: ['ls'], timeoutMs: 0 }]) {
      expect(() => startExec({ cwd, timeoutMs: 1000, ...bad })).toThrow(/invalid_exec_spec/)
    }
  })
})
