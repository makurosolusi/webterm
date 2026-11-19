// Custom command capabilities (`webterm command ...`): list/detect are R0 reads; add/remove are R2 (shared
// mutation: they change what every terminal on this machine can execute), the same class as git.scm.commit.
// Like the SCM verbs, the mutating routes are human-UI only (route.uiOnly), so an agent that policy allows
// still gets 403 from the route: there is no agent path around the gate.
import { CUSTOM_COMMANDS_PATH } from '../../shared/customCommands'
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S } from './capability.schema'

export const CUSTOM_COMMAND_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: 'command.list', summary: 'List registered custom commands with found/missing status, resolved path and shadowed system binary.',
    tier: 'R0', scope: 'global', projections: ['control-http'], idempotent: true, route: { method: 'GET', path: CUSTOM_COMMANDS_PATH },
    input: obj({}), output: S.keys('commands'),
  }),
  defineCapability({
    name: 'command.detect', summary: 'Detect common env/secret wrappers (envman, op, doppler, ...) installed on PATH.',
    tier: 'R0', scope: 'global', projections: ['control-http'], idempotent: true, route: { method: 'GET', path: `${CUSTOM_COMMANDS_PATH}/detect` },
    input: obj({}), output: S.keys('candidates'),
  }),
  defineCapability({
    name: 'command.add', summary: 'Register a custom command: kind link (symlink to a binary) or shim (fixed argv). Human UI only.',
    tier: 'R2', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: CUSTOM_COMMANDS_PATH },
    input: obj({
      name: S.str(64), kind: S.oneOf('link', 'shim'), target: S.str(4096), argv: S.arr(S.str(512)), note: S.str(200), force: S.bool(),
    }, ['name', 'kind']),
    output: S.keys('command'),
  }),
  defineCapability({
    name: 'command.remove', summary: 'Remove a registered custom command and its file. Human UI only.',
    tier: 'R2', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${CUSTOM_COMMANDS_PATH}/remove` },
    input: obj({ name: S.str(64) }, ['name']), output: S.keys('removed'),
  }),
  defineCapability({
    name: 'command.paths', summary: 'List the managed tool directory, the user extra tool directories and the platform subfolder searched.',
    tier: 'R0', scope: 'global', projections: ['control-http'], idempotent: true, route: { method: 'GET', path: `${CUSTOM_COMMANDS_PATH}/paths` },
    input: obj({}), output: S.keys('managed', 'extra'),
  }),
  defineCapability({
    name: 'command.path_add', summary: 'Add a directory whose executables are found in every terminal (absolute, not world-writable). Human UI only.',
    tier: 'R2', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${CUSTOM_COMMANDS_PATH}/paths` },
    input: obj({ dir: S.str(4096) }, ['dir']), output: S.keys('extra'),
  }),
  defineCapability({
    name: 'command.path_remove', summary: 'Remove an extra tool directory. Human UI only.',
    tier: 'R2', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${CUSTOM_COMMANDS_PATH}/paths/remove` },
    input: obj({ dir: S.str(4096) }, ['dir']), output: S.keys('extra'),
  }),
  defineCapability({
    name: 'command.rescan', summary: 'Rescan the usual tool directories and the login shell PATH so a freshly installed tool is found now.',
    tier: 'R1', scope: 'global', projections: ['control-http'], idempotent: true, route: { method: 'POST', path: `${CUSTOM_COMMANDS_PATH}/rescan` },
    input: obj({}), output: S.keys('added'),
  }),
]
