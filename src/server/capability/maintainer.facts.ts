// Real wiring of the maintainer diagnosis capabilities: reads the live Doctor, effective config and instance facts.
// Imports are lazy (bun:sqlite and the runtime singletons stay out of vitest imports); the logic is in maintainer.run.ts.
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import type { Workspace } from '../../shared/workspace'
import { doctorRunResult, configReadResult, instanceInfoResult } from './maintainer.run'

type Out = Record<string, unknown>

export async function liveDoctorRun(input: { id?: string }): Promise<Out> {
  const [{ runDoctor }, { doctorDeps }, { initEnvSettings }, { buildEffectiveConfig }, { BOOTSTRAP_ONLY_KEYS }, { getDotenvBoot }] = await Promise.all([
    import('../doctor'), import('../doctor.runtime'), import('../envSettings.runtime'), import('../effectiveConfig'), import('../envRegistry'), import('../dotenvFiles'),
  ])
  const service = initEnvSettings()
  const model = buildEffectiveConfig({ state: service.state({ root: true }), env: process.env, dotenvKeys: getDotenvBoot().keys, bootstrapKeys: BOOTSTRAP_ONLY_KEYS })
  const sandboxLock = model.rows.find((r) => r.key === 'WEBTERM_AGENT_SANDBOX')?.lockReason
  return doctorRunResult(await runDoctor(doctorDeps({ service, env: process.env, ...(sandboxLock ? { sandboxLock } : {}) })), input)
}

export async function liveConfigRead(input: { q?: string; limit?: number }): Promise<Out> {
  const [{ initEnvSettings }, { buildEffectiveConfig }, { BOOTSTRAP_ONLY_KEYS }, { getDotenvBoot }] = await Promise.all([
    import('../envSettings.runtime'), import('../effectiveConfig'), import('../envRegistry'), import('../dotenvFiles'),
  ])
  const model = buildEffectiveConfig({ state: initEnvSettings().state({ root: true }), env: process.env, dotenvKeys: getDotenvBoot().keys, bootstrapKeys: BOOTSTRAP_ONLY_KEYS })
  return configReadResult(model.rows, input)
}

export async function liveInstanceInfo(board: readonly Workspace[]): Promise<Out> {
  const [{ default: pkg }, { sessions }, { dataDir }, { isEnabled }, { ENV_BROWSER }, { flagOr }] = await Promise.all([
    import('../../../package.json'), import('../sessions'), import('../config'), import('../featureCapabilities.runtime'), import('../../shared/browser.contract'), import('../envFlag'),
  ])
  return instanceInfoResult({
    version: pkg.version, production: process.env.NODE_ENV === 'production', platform: platform(), dataDirPresent: existsSync(dataDir()),
    uptimeSec: process.uptime(), sessions: sessions.list().length, nodes: board.reduce((n, ws) => n + ws.nodes.length, 0),
    browser: { enabled: isEnabled('browser'), agentControl: flagOr(process.env[ENV_BROWSER.agent], true) },
  })
}
