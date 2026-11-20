// Scanner (docs/decisions/credential-proxy.md 5b): a Claude child never gets a real credential because every
// launch goes through the single env composer, and nothing else in src/server reads the credential env vars.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPAWN = /\b(?:spawn|execFile|spawnPty|Bun\.spawn)\s*\(/
const CLAUDE_LAUNCH = /\blaunch\.argv\b|\bcentralClaudeLaunch\b|\bclaudeEnv\b/
const COMPOSER_IMPORT = /from '[^']*(?:claudeProvider\.store|credentialProxy\.env|\/agentEnv|claudeProvider\.model)'/
const ENV_READ = /\benv\??\.ANTHROPIC_(?:API_KEY|AUTH_TOKEN|CUSTOM_HEADERS|BASE_URL)\b/

/** Named exceptions to the env-read rule: file (relative to src/server) -> why it may read the variable. */
const ENV_READ_EXCEPTIONS: Record<string, string> = {
  'agentEnv.ts': 'credential-name list and envProxyAuth: only tests "a proxy is configured", never copies a value into a child',
  'claudeProvider/claudeProvider.store.ts': 'claudeUpstream: the server env is the upstream while the card is login; only the proxy resolves it',
  'claudeProvider/claudeProvider.connectionTest.ts': 'compares the child base URL with the proxy address to label the auth stage; no secret read',
  'claudeLauncher/claudeLauncher.api.ts': 'UI-only: reports that the server env carries a credential ("env" source), never forwards it',
}

/** Spawn sites that never build an env: the env arrives finished from a composer caller. File -> why. */
const SPAWN_EXCEPTIONS: Record<string, string> = {
  'claudeLauncher/claudeSdkSpawn.ts': 'SDK spawn hook: forwards the SDK options env, which agentChatEnv / claudeEnv already composed',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p)
    return /\.tsx?$/.test(e.name) && !/\.(?:test|bun\.test|testutil)\.tsx?$|testutil\.ts$/.test(e.name) ? [p] : []
  })
}
const files = sourceFiles(SERVER).map((p) => ({ rel: relative(SERVER, p), src: readFileSync(p, 'utf8') }))

describe('credential proxy spawn policy', () => {
  it('scans a real tree', () => { expect(files.length).toBeGreaterThan(100) })

  it('every file that spawns a Claude launch imports the single env composer', () => {
    const offenders = files.filter((f) => SPAWN.test(f.src) && CLAUDE_LAUNCH.test(f.src) && !COMPOSER_IMPORT.test(f.src) && !(f.rel in SPAWN_EXCEPTIONS)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('nothing outside credentialProxy/ and the named exceptions reads the credential env vars', () => {
    const offenders = files.filter((f) => !f.rel.startsWith('credentialProxy/') && !(f.rel in ENV_READ_EXCEPTIONS) && ENV_READ.test(f.src)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('every named exception still reads one (the list does not go stale)', () => {
    const stale = Object.keys(ENV_READ_EXCEPTIONS).filter((rel) => !ENV_READ.test(files.find((f) => f.rel === rel)?.src ?? ''))
    expect(stale).toEqual([])
  })
})
