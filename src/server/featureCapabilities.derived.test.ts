// Kemampuan -> kunci turunan bernilai (Worker/Otonomi -> tools/planner/agents), prasyarat mesin agen,
// nama bot Telegram, sub Browser berbahaya, dan hook yang di-bounce tanpa restart.
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityId } from '../shared/featureCapabilities'
import { linkedSettings } from '../shared/featureCapabilities'
import { fakeBotApi } from './channels/telegramPollHarness'
import { setupEnv } from './envSettings.testutil'
import { onCapabilityChange } from './featureCapabilities.runtime'
import { setAdvanced, syncLinkedSettings, toggle, viewOf, type CapCtx, type Detect } from './featureCapabilities.service'

// test-only
const DETECT: Detect = { chromium: true, telegramToken: true, agentEngine: true }

function harness(env: NodeJS.ProcessEnv = {}) {
  const h = setupEnv(env)
  const ctx: CapCtx = { settings: h.svc, env: h.target, detect: () => DETECT, dataDir: '/tmp/webterm-test-data', secrets: h.secrets, fetch: fakeBotApi([]).fetch, audit: () => undefined }
  return { ...h, ctx }
}
const offs: Array<() => void> = []
const events: string[] = []
function spy(ids: CapabilityId[]): void {
  for (const id of ids) offs.push(onCapabilityChange(id, { start: () => { events.push(`start:${id}`) }, stop: () => { events.push(`stop:${id}`) } }))
}
afterEach(() => { offs.splice(0).forEach((off) => off()); events.length = 0 })

describe('kunci turunan Worker/Otonomi', () => {
  it('linkedSettings: Worker = propose; Otonomi = auto; mati = off; retired dead keys are no longer written', () => {
    expect(linkedSettings(new Set(['workers']))).toEqual({ WEBTERM_CENTRAL_AGENTS: 'propose' })
    expect(linkedSettings(new Set(['autonomy']))).toEqual({ WEBTERM_CENTRAL_AGENTS: 'auto' })
    expect(linkedSettings(new Set(['central']))).toEqual({ WEBTERM_CENTRAL_AGENTS: 'off' })
  })
  it('toggle menulis nilainya ke env; mematikan Otonomi turun ke propose', async () => {
    const h = harness()
    await toggle(h.ctx, 'workers', true)
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL_AGENTS: 'propose' })
    expect(h.target.WEBTERM_CENTRAL_TOOLS).toBeUndefined()
    await toggle(h.ctx, 'autonomy', true)
    expect(h.target.WEBTERM_CENTRAL_AGENTS).toBe('auto')
    await toggle(h.ctx, 'autonomy', false)
    expect(h.target.WEBTERM_CENTRAL_AGENTS).toBe('propose')
  })
  it('nilai eksplisit dari shell/.env tidak ditimpa kartu', async () => {
    const h = harness({ WEBTERM_CENTRAL_AGENTS: 'off' })
    await toggle(h.ctx, 'workers', true)
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL_AGENTS: 'off' })
  })
  it('Worker berubah saat Central tetap on = hook central di-bounce (CA2 merakit ulang tool worker)', async () => {
    const h = harness()
    await toggle(h.ctx, 'central', true)
    spy(['central'])
    await toggle(h.ctx, 'workers', true)
    expect(events).toEqual(['start:central']) // hook baru belum jalan: stop dilewati, start membuktikan bounce
  })
})

describe('prasyarat mesin agen (Central)', () => {
  it('Central on tanpa mesin siap = needs-step agentEngine, bukan Aktif', () => {
    const v = viewOf('central', { WEBTERM_CENTRAL: 'on' }, { ...DETECT, agentEngine: false })
    expect(v).toMatchObject({ status: 'needs-step', step: { kind: 'agentEngine', label: 'Set up Claude Code' } })
    expect(viewOf('central', { WEBTERM_CENTRAL: 'on' }, DETECT).status).toBe('on')
  })
  it('ganti mesin di Lanjutan mem-bounce Telegram yang sedang on', async () => {
    const h = harness({ WEBTERM_TELEGRAM: 'on' })
    spy(['telegram'])
    expect((await setAdvanced(h.ctx, { agentEngine: 'claude' })).status).toBe(200)
    expect(events).toEqual(['start:telegram'])
  })
})

describe('detail dan sub', () => {
  it('Telegram on dengan nama bot = "Connected as @nama"', () => {
    expect(viewOf('telegram', { WEBTERM_TELEGRAM: 'on' }, { ...DETECT, telegramBot: '@webterm_bot' }).detail).toBe('Connected as @webterm_bot')
    expect(viewOf('telegram', { WEBTERM_TELEGRAM: 'on' }, DETECT).detail).toBeUndefined()
  })
  it('Browser punya sub agent berbahaya, bawaan ON (alat developer); off eksplisit tetap dihormati', () => {
    expect(viewOf('browser', { WEBTERM_BROWSER: 'on' }, DETECT).subs).toEqual([{ key: 'browserAgent', label: 'Let agents drive the browser', on: true, dangerous: true }])
    expect(viewOf('browser', { WEBTERM_BROWSER: 'on', WEBTERM_BROWSER_AGENT: 'off' }, DETECT).subs).toEqual([expect.objectContaining({ key: 'browserAgent', on: false })])
  })
})

describe('syncLinkedSettings (boot)', () => {
  it('Worker yang sudah on sebelum perubahan mendapat nilai turunan tanpa toggle; boot kedua tak menulis', () => {
    const h = harness({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' })
    expect(syncLinkedSettings(h.svc, h.target)).toEqual(['WEBTERM_CENTRAL_AGENTS'])
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL_AGENTS: 'propose' })
    expect(syncLinkedSettings(h.svc, h.target)).toEqual([])
  })
  it('env eksplisit menang dan kartu mati tidak menulis apa pun', () => {
    const h = harness({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_CENTRAL_AGENTS: 'propose' })
    expect(syncLinkedSettings(h.svc, h.target)).toEqual([])
    expect(h.target.WEBTERM_CENTRAL_AGENTS).toBe('propose')
    expect(syncLinkedSettings(harness().svc, {})).toEqual([])
  })
})
