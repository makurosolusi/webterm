// Fixture bersama tes ENV-03 (test-only): entri/state v2 sintetis, stub fetch /api/settings/env, row tiruan.
import { vi } from 'vitest'
import type { EnvEntryV2, EnvStateV2 } from '../shared/envSettings.contract'
import type { EnvEntryRowProps } from './envRowContract'
import { EnvSettingsProvider, useEnvLoadOnMount } from './useEnvSettings'

/** Entri v2 sintetis (test-only); tidak ada nilai nyata. */
export const mkEntry = (e: Partial<EnvEntryV2> & Pick<EnvEntryV2, 'key'>): EnvEntryV2 => ({
  kind: 'flag', group: 'g1', label: `Label ${e.key}`, description: `Desc ${e.key}`, value: 'off', source: 'default',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true, owner: 'platform', section: 'Sec A',
  audience: 'user', requires: [], restart: 'none', effective: 'off', valid: true, ...e,
})

/** State v2 sintetis dengan dua grup. */
export const mkState = (entries: EnvEntryV2[], over: Partial<EnvStateV2> = {}): EnvStateV2 => ({
  locked: false, rootGate: true, server: { tokenSet: true, settingsLocked: false },
  groups: [{ id: 'g1', label: 'G1', order: 1, owner: 'platform' }, { id: 'g2', label: 'G2', order: 2, owner: 'platform' }],
  entries, ...over,
})

/** State dasar: 2 entri user (Sec A), 1 advanced (Sec B), 1 dangerous, 1 secret. */
export const baseState = (): EnvStateV2 => mkState([
  mkEntry({ key: 'K_ONE' }),
  mkEntry({ key: 'K_TWO', kind: 'string', value: 'abc', default: 'abc' }),
  mkEntry({ key: 'K_DANGER', dangerous: true, dangerNote: 'bahaya', label: 'Mode bahaya' }),
  mkEntry({ key: 'K_ADV', group: 'g2', section: 'Sec B', audience: 'advanced', kind: 'string', value: 'zz', default: 'zz' }),
  mkEntry({ key: 'K_SECRET', kind: 'secret', value: '', secretSet: false }),
])

export interface ApiCall { method: string; body?: Record<string, unknown> }
export interface ApiStub { calls: ApiCall[]; getState: EnvStateV2; put: (body: Record<string, unknown>) => { status: number; body: unknown } }

/** Pasang stub global fetch; `put` default membalas state yang sama. */
export function stubEnvApi(initial: EnvStateV2): ApiStub {
  const stub: ApiStub = { calls: [], getState: initial, put: () => ({ status: 200, body: { ...stub.getState, restartRequired: [] } }) }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined
    stub.calls.push({ method, body })
    if (method === 'GET') return new Response(JSON.stringify(stub.getState), { status: 200 })
    const r = stub.put(body ?? {})
    return new Response(JSON.stringify(r.body), { status: r.status })
  }))
  return stub
}

/** Isi body PUT dari stub. */
export const putBodies = (s: ApiStub): unknown[] => s.calls.filter((c) => c.method === 'PUT').map((c) => c.body)

/** Modul tiruan EnvEntryRow yang memenuhi kontrak c-0 (dipakai lewat vi.mock + dynamic import). */
export function mockRowModule(): { EnvEntryRow: (p: EnvEntryRowProps) => React.JSX.Element } {
  return {
    EnvEntryRow: (p) => (
      <div data-testid={`row-${p.entry.key}`} data-draft={p.draft ?? ''} data-locked={String(p.locked)}
        data-rootgate={String(p.rootGate)} data-get-one={p.get('K_ONE') ?? 'undef'}>
        <span>{p.entry.label}</span>
        <button type="button" onClick={() => p.onDraft(p.entry.kind === 'flag' ? 'on' : 'changed')}>{`draft ${p.entry.key}`}</button>
        <button type="button" onClick={() => p.onReset()}>{`reset ${p.entry.key}`}</button>
        <button type="button" onClick={() => p.onJump('K_ADV')}>{`jump ${p.entry.key}`}</button>
        <input aria-label={`ctl ${p.entry.key}`} />
      </div>
    ),
  }
}

function Loader(): null {
  useEnvLoadOnMount()
  return null
}

/** Provider + pemuat state untuk tes komponen. */
export function EnvHarness({ children, query = '' }: { children: React.ReactNode; query?: string }): React.JSX.Element {
  return <EnvSettingsProvider query={query}><Loader />{children}</EnvSettingsProvider>
}
