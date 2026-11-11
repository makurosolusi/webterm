import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityId } from '../shared/featureCapabilities'
import { TEST_TOKEN, fakeBotApi, ok } from './channels/telegramPollHarness'
import { setupEnv } from './envSettings.testutil'
import { enabledSet, onCapabilityChange, reconcile } from './featureCapabilities.runtime'
import { connect, reset, setAdvanced, setSub, toggle, viewOf, type CapCtx, type Detect } from './featureCapabilities.service'

// test-only: ctx murni di atas env + store in-memory; tak menyentuh home atau jaringan.
const DETECT_OK: Detect = { chromium: true, telegramToken: false, agentEngine: true }
const flag = (v: string) => ({ WEBTERM_BROWSER: v })

function harness(env: NodeJS.ProcessEnv = {}, detect: Detect = DETECT_OK, fetch = fakeBotApi([]).fetch) {
  const h = setupEnv(env)
  const audits: Array<Parameters<CapCtx['audit']>[0]> = []
  const ctx: CapCtx = { settings: h.svc, env: h.target, detect: () => detect, dataDir: '/tmp/webterm-test-data', secrets: h.secrets, fetch, audit: (e) => audits.push(e) }
  return { ...h, ctx, audits }
}

const offs: Array<() => void> = []
const events: string[] = []
/** Pasang hook pencatat untuk semua id; dilepas di afterEach supaya registry modul bersih. */
function spy(ids: CapabilityId[]): void {
  for (const id of ids) offs.push(onCapabilityChange(id, { start: () => { events.push(`start:${id}`) }, stop: () => { events.push(`stop:${id}`) } }))
}
afterEach(() => { offs.splice(0).forEach((off) => off()); events.length = 0 })

const viewIn = (body: unknown, id: string) => (body as { capabilities: Array<{ id: string; alsoTurnsOn?: string[]; subs?: Array<{ key: string; label: string; on: boolean }> }> }).capabilities.find((v) => v.id === id)

describe('viewOf', () => {
  it('off dengan prasyarat belum on memberi alsoTurnsOn dari closure', () => {
    const v = viewOf('autonomy', {}, DETECT_OK)
    expect(v.status).toBe('off')
    expect(v.alsoTurnsOn).toEqual(['central', 'workers'])
  })
  it('browser on tanpa Chromium = needs-step chromiumPath; dengan Chromium = on', () => {
    expect(viewOf('browser', flag('on'), { chromium: false, telegramToken: false, agentEngine: true })).toMatchObject({ status: 'needs-step', step: { kind: 'chromiumPath' } })
    expect(viewOf('browser', flag('on'), DETECT_OK).status).toBe('on')
  })
  it('telegram on tanpa token = needs-step telegramToken', () => {
    expect(viewOf('telegram', { WEBTERM_TELEGRAM: 'on' }, DETECT_OK)).toMatchObject({ status: 'needs-step', step: { kind: 'telegramToken' } })
    expect(viewOf('telegram', { WEBTERM_TELEGRAM: 'on' }, { chromium: true, telegramToken: true, agentEngine: true }).status).toBe('on')
  })
  it('rantai putus (workers on, central off) = needs-step fixChain', () => {
    expect(viewOf('workers', { WEBTERM_ORCHESTRATOR_RUN: 'on' }, DETECT_OK)).toMatchObject({ status: 'needs-step', step: { kind: 'fixChain' } })
  })
  it('sub tampil hanya saat induk on dengan kunci tanpa nama env var', () => {
    expect(viewOf('workers', {}, DETECT_OK).subs).toBeUndefined()
    const on = viewOf('workers', { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' }, DETECT_OK)
    expect(on.subs).toEqual([expect.objectContaining({ key: 'runRequireApproval', on: true })])
    expect(JSON.stringify(on)).not.toContain('WEBTERM_')
  })
})

describe('toggle', () => {
  it('menyalakan autonomy menulis closure (central, workers) dan membalas alsoTurnsOn', async () => {
    const h = harness()
    const r = await toggle(h.ctx, 'autonomy', true)
    expect(r.status).toBe(200)
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_CENTRAL_MEMORY: 'on' })
    expect(viewIn(r.body, 'autonomy')?.alsoTurnsOn).toEqual(['central', 'workers'])
    expect(h.audits).toEqual([{ capability: 'autonomy', action: 'grant', detail: 'central,workers,autonomy' }])
  })
  it('mematikan central mematikan dependents dan menulis off (bukan menghapus)', async () => {
    const h = harness()
    await toggle(h.ctx, 'autonomy', true)
    const r = await toggle(h.ctx, 'central', false)
    expect(r.status).toBe(200)
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL: 'off', WEBTERM_ORCHESTRATOR_RUN: 'off', WEBTERM_CENTRAL_AUTONOMY: 'off' })
    expect(h.audits.at(-1)).toMatchObject({ capability: 'central', action: 'revoke', detail: 'central,workers,autonomy' })
  })
  it('hanya menulis kunci yang berubah: override pengguna lain tak tersentuh', async () => {
    const h = harness({ WEBTERM_FILES_WATCH: 'off' })
    await toggle(h.ctx, 'central', true)
    expect(h.target.WEBTERM_FILES_WATCH).toBe('off')
    expect(h.overrides.json).not.toContain('FILES_WATCH')
  })
  it('hook jalan berurutan: prasyarat dulu saat on, dependents dulu saat off', async () => {
    spy(['central', 'workers'])
    const h = harness()
    await toggle(h.ctx, 'workers', true)
    await toggle(h.ctx, 'central', false)
    expect(events).toEqual(['start:central', 'start:workers', 'stop:workers', 'stop:central'])
  })
  it('dua POST bersamaan tetap konsisten (diserialkan)', async () => {
    spy(['central'])
    const h = harness()
    await Promise.all([toggle(h.ctx, 'central', true), toggle(h.ctx, 'central', false), toggle(h.ctx, 'files', true)])
    expect(h.target.WEBTERM_CENTRAL).toBe('off')
    expect(h.target.WEBTERM_FILES_VIEWERS).toBe('on')
    expect(events).toEqual(['start:central', 'stop:central'])
  })
  it('galat tulis store memberi status galat dan tidak mereconcile', async () => {
    spy(['files'])
    const h = harness({ WEBTERM_ENV_SETTINGS: 'off' })
    const r = await toggle(h.ctx, 'files', true)
    expect(r).toEqual({ status: 403, body: { error: 'locked' } })
    expect(events).toEqual([])
  })
})

describe('setSub', () => {
  it('400 unknown_sub, 409 parent_off, 200 menulis off', async () => {
    const h = harness()
    expect((await setSub(h.ctx, 'workers', 'nope', true)).status).toBe(400)
    expect((await setSub(h.ctx, 'files', 'runRequireApproval', true)).status).toBe(400)
    expect(await setSub(h.ctx, 'workers', 'runRequireApproval', false)).toMatchObject({ status: 409, body: { error: 'parent_off' } })
    await toggle(h.ctx, 'workers', true)
    const r = await setSub(h.ctx, 'workers', 'runRequireApproval', false)
    expect(r.status).toBe(200)
    expect(h.target.WEBTERM_RUN_REQUIRE_APPROVAL).toBe('off')
    expect(viewIn(r.body, 'workers')?.subs).toEqual([expect.objectContaining({ key: 'runRequireApproval', on: false })])
  })
})

describe('setSub central skills', () => {
  it('writes WEBTERM_CENTRAL_SKILLS and restarts Central so it applies without a server restart', async () => {
    const h = harness()
    spy(['central'])
    await toggle(h.ctx, 'central', true)
    events.length = 0
    const r = await setSub(h.ctx, 'central', 'centralSkills', true)
    expect(r.status).toBe(200)
    expect(h.target.WEBTERM_CENTRAL_SKILLS).toBe('on')
    expect(events).toEqual(['stop:central', 'start:central'])
    expect(viewIn(r.body, 'central')?.subs?.find((s) => s.key === 'centralSkills')).toMatchObject({ on: true })
  })

  it('skill proposals restart Central; the per-turn checkpoint switch does not', async () => {
    const h = harness()
    spy(['central'])
    await toggle(h.ctx, 'central', true)
    events.length = 0
    expect((await setSub(h.ctx, 'central', 'centralSkillPropose', true)).status).toBe(200)
    expect(h.target.WEBTERM_CENTRAL_SKILL_PROPOSE).toBe('on')
    expect(events).toEqual(['stop:central', 'start:central'])
    events.length = 0
    const r = await setSub(h.ctx, 'central', 'centralCheckpoint', true)
    expect(r.status).toBe(200)
    expect(h.target.WEBTERM_CENTRAL_CHECKPOINT).toBe('on')
    expect(events).toEqual([])
    expect(viewIn(r.body, 'central')?.subs?.map((s) => [s.key, s.label, s.on])).toEqual([
      ['centralSkills', 'Let Central use skills you review and approve', false],
      ['centralSkillPropose', 'Suggest new skills', true],
      ['centralCheckpoint', 'Summarize long conversations', true],
    ])
  })
})

describe('reset', () => {
  it('menghapus override katalog, menjalankan stop hook, dan tidak menyentuh token', async () => {
    spy(['central'])
    const h = harness()
    h.secrets.write('WEBTERM_TELEGRAM_BOT_TOKEN', TEST_TOKEN)
    await toggle(h.ctx, 'autonomy', true)
    const r = await reset(h.ctx)
    expect(r.status).toBe(200)
    expect(h.target.WEBTERM_CENTRAL).toBeUndefined()
    expect(events).toEqual(['start:central', 'stop:central'])
    expect(h.secrets.files.get('WEBTERM_TELEGRAM_BOT_TOKEN')).toBe(TEST_TOKEN)
    expect(h.audits.at(-1)).toMatchObject({ capability: 'advanced', action: 'reset' })
  })
})

describe('setAdvanced', () => {
  it('menulis mesin agen dan lokasi Chrome; auto menghapus override', async () => {
    const h = harness()
    expect((await setAdvanced(h.ctx, { agentEngine: 'claude', chromiumPath: '/opt/chrome' })).status).toBe(200)
    expect(h.target).toMatchObject({ WEBTERM_CENTRAL_RUNTIME: 'claude', WEBTERM_BROWSER_BIN: '/opt/chrome' })
    await setAdvanced(h.ctx, { agentEngine: 'auto', chromiumPath: '' })
    expect(h.target.WEBTERM_CENTRAL_RUNTIME).toBeUndefined()
    expect(h.target.WEBTERM_BROWSER_BIN).toBeUndefined()
    expect(h.audits.at(-1)).toMatchObject({ capability: 'advanced', action: 'advanced', detail: 'agentEngine,chromiumPath' })
  })
  it('nilai tak valid = 400 invalid_value dengan nama field, tanpa nama env var', async () => {
    const h = harness()
    for (const body of [{ agentEngine: 'gpt' }, { agentEngine: 'mock' }, { agentEngine: 'codex' }, { chromiumPath: 42 }]) {
      const r = await setAdvanced(h.ctx, body)
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({ error: 'invalid_value' })
      expect(JSON.stringify(r.body)).not.toContain('WEBTERM_')
    }
    expect(h.overrides.saves).toBe(0)
  })
})

describe('connect', () => {
  it('token ditolak: tidak ada yang disimpan dan telegram tetap off', async () => {
    spy(['telegram'])
    const api = fakeBotApi([{ status: 401, body: { ok: false } }])
    const h = harness({}, DETECT_OK, api.fetch)
    const r = await connect(h.ctx, TEST_TOKEN)
    expect(r).toEqual({ status: 422, body: { error: 'token_rejected' } })
    expect(h.secrets.files.size).toBe(0)
    expect(h.target.WEBTERM_TELEGRAM).toBeUndefined()
    expect(events).toEqual([])
  })
  it('bentuk token salah = 400 tanpa panggilan jaringan', async () => {
    const api = fakeBotApi([])
    const h = harness({}, DETECT_OK, api.fetch)
    expect((await connect(h.ctx, 'bukan-token')).status).toBe(400)
    expect(api.calls).toHaveLength(0)
  })
  it('token diterima: simpan, nyalakan telegram, token termuat ke env, hook start', async () => {
    spy(['telegram'])
    const h = harness({}, DETECT_OK, fakeBotApi([ok({ username: 'webterm_bot' })]).fetch)
    const r = await connect(h.ctx, TEST_TOKEN)
    expect(r).toEqual({ status: 200, body: { ok: true, bot: '@webterm_bot' } })
    expect(h.target.WEBTERM_TELEGRAM).toBe('on')
    expect(h.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBe(TEST_TOKEN)
    expect(events).toEqual(['start:telegram'])
    expect(JSON.stringify(h.audits)).not.toContain(TEST_TOKEN)
  })
  it('telegram sudah on tanpa token: hook di-bounce supaya memuat token baru', async () => {
    spy(['telegram'])
    const h = harness({ WEBTERM_TELEGRAM: 'on' }, DETECT_OK, fakeBotApi([ok({ username: 'webterm_bot' })]).fetch)
    await reconcile(new Set(), enabledSet(h.target)) // seperti boot: hook jalan tanpa token
    events.length = 0
    expect((await connect(h.ctx, TEST_TOKEN)).status).toBe(200)
    expect(events).toEqual(['stop:telegram', 'start:telegram'])
  })
})
