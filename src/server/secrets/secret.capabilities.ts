// Secret broker capabilities (plan F2-f, visionary idea #11). Both run in-process through `secret.broker.ts`
// (dispatched from cli.exec `execute`); `route` is the `/api/tools/<name>` path that reaches them.
import { defineCapability, type CapabilitySpec } from '../capability/capability.define'
import { obj, S } from '../capability/capability.schema'

export const SECRET_NAME_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$'
export const SECRET_RUN_MAX_NAMES = 8
export const SECRET_RUN_MAX_ARGS = 64
export const SECRET_RUN_TIMEOUT_MAX_MS = 600_000

// cli.launcher TOOLS_PATH; not imported because cli.registry imports this file and cli.launcher imports cli.registry.
const TOOLS_PATH = '/api/tools'
const name = S.str(64, { pattern: SECRET_NAME_PATTERN })

export const SECRET_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: 'secret.run', summary: 'Run a command with named secrets injected as env vars; output comes back with every secret masked.',
    tier: 'R2', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/secret.run` },
    input: obj({
      names: { ...S.arr(name, SECRET_RUN_MAX_NAMES), description: 'Secret names to inject; each becomes an env var of the same name.' },
      command: { ...S.arr(S.str(4096), SECRET_RUN_MAX_ARGS), description: 'argv, no shell: ["npm","publish"]. Policy scope is secret:<NAME>:<argv joined by spaces>.' },
      cwd: S.str(4096, { description: 'Working folder; must sit inside this node folder. Defaults to it.' }),
      timeoutMs: S.int(1, SECRET_RUN_TIMEOUT_MAX_MS),
    }, ['names', 'command']),
    output: obj({ exitCode: { type: ['integer', 'null'] }, stdout: S.str(), stderr: S.str(), timedOut: S.bool(), truncated: S.bool() }),
  }),
  defineCapability({
    name: 'secret.list', summary: 'List the secret names this server holds and when each was last used; never values.',
    tier: 'R0', scope: 'global', projections: ['control-http'], idempotent: true, route: { method: 'POST', path: `${TOOLS_PATH}/secret.list` },
    input: obj({}),
    output: obj({ secrets: S.arr(obj({ name: S.str(), lastUsedAt: { type: ['integer', 'null'] } })) }),
  }),
]

export const isSecretCapability = (capName: string): boolean => SECRET_CAPABILITIES.some((c) => c.name === capName)
