// Bantu test env-settings: store in-memory + nilai PALSU buatan sendiri (bukan secret nyata).
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import type { SecretStore } from './envSecrets.store'
import { createEnvSettings } from './envSettings.service'
import type { OverrideStore } from './envSettings.store'

// test-only: sentinel yang dicari di SEMUA output (respons, log, error).
export const SENTINEL_BOT_TOKEN = '123456:SENTINELbotTOKENvalue'
export const SENTINEL_WEBHOOK_SECRET = 'SentinelWebhookSecret_0123456789abcdef'

export function memOverrides(initial: string | null = null): OverrideStore & { json: string | null; saves: number } {
  const s = { json: initial, saves: 0, load: () => s.json, save: (j: string) => { s.json = j; s.saves += 1 } }
  return s
}

export function memSecrets(): SecretStore & { files: Map<string, string>; failOn?: string } {
  const s = {
    files: new Map<string, string>(),
    failOn: undefined as string | undefined,
    read: (k: string) => s.files.get(k) ?? null,
    write: (k: string, v: string) => {
      if (s.failOn === k) throw new Error(`secret store: write failed for ${k} (EIO)`)
      s.files.set(k, v)
    },
    remove: (k: string) => { s.files.delete(k) },
  }
  return s
}

/**
 * test-only: the capability switches as they defaulted before "most capable by default" (2026-11-12), as shell env,
 * for tests whose premise is "start with every capability off" (a Settings override still wins over them).
 */
export const CAPABILITIES_OFF: Readonly<Record<string, string>> = {
  WEBTERM_CENTRAL: 'off', WEBTERM_ORCHESTRATOR_RUN: 'off', WEBTERM_BROWSER: 'off', WEBTERM_FILES_VIEWERS: 'off', WEBTERM_FILES_MUTATE: 'off',
}

export function setupEnv(env: NodeJS.ProcessEnv = {}, stored: string | null = null) {
  const target: NodeJS.ProcessEnv = { ...env }
  const overrides = memOverrides(stored)
  const secrets = memSecrets()
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }
  const svc = createEnvSettings({ registry: ENV_REGISTRY, bootstrapKeys: BOOTSTRAP_ONLY_KEYS, target, overrides, secrets, log })
  svc.apply()
  return { svc, target, overrides, secrets, logs }
}

export function fakeReq(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  return Object.assign(stream, { method, headers: {} }) as unknown as IncomingMessage
}

export interface RecordedRes extends ServerResponse { status: number; body: string; headers: Record<string, string>; json(): unknown }

export function recorder(): RecordedRes {
  const res = {
    status: 0, body: '', headers: {} as Record<string, string>,
    setHeader: (k: string, v: string) => { res.headers[k] = v },
    end: (chunk?: string) => { if (chunk) res.body += chunk },
    json: () => JSON.parse(res.body) as unknown,
  }
  Object.defineProperty(res, 'statusCode', { get: () => res.status, set: (v: number) => { res.status = v } })
  return res as unknown as RecordedRes
}
