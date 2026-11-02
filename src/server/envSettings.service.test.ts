// Presedensi, validasi, gerbang, atomik, dan larangan bocor untuk layanan env-settings.
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ONLY_KEYS } from './envRegistry'
import { SENTINEL_BOT_TOKEN, SENTINEL_WEBHOOK_SECRET, setupEnv } from './envSettings.testutil'
import type { EnvEntry } from './envSettings.service'
import { resolveWebhookSecret } from './channels/channelSecret'
import { redactSecrets } from './redactSecrets'

const ROOT = { root: true }
const USER = { root: false }
const entry = (s: ReturnType<typeof setupEnv>, key: string, ctx = ROOT): EnvEntry =>
  s.svc.state(ctx).entries.find((e) => e.key === key) as EnvEntry

describe('presedensi override > env > default', () => {
  it('tiga tingkat, dan reset mengembalikan nilai env awal', () => {
    const s = setupEnv({ WEBTERM_LEDGER: 'shadow' })
    expect(entry(s, 'WEBTERM_LEDGER')).toMatchObject({ source: 'env', value: 'shadow' })
    expect(entry(s, 'WEBTERM_CENTRAL_TOOLS')).toMatchObject({ source: 'default', value: 'read' })

    expect(s.svc.update({ set: { WEBTERM_LEDGER: 'on' }, unset: [] }, ROOT).ok).toBe(true)
    expect(entry(s, 'WEBTERM_LEDGER')).toMatchObject({ source: 'override', value: 'on' })
    expect(s.target.WEBTERM_LEDGER).toBe('on')

    s.svc.update({ set: {}, unset: ['WEBTERM_LEDGER'] }, ROOT)
    expect(s.target.WEBTERM_LEDGER).toBe('shadow')
    expect(entry(s, 'WEBTERM_LEDGER').source).toBe('env')
  })

  it('tanpa env asli, reset menghapus kunci dari env proses', () => {
    const s = setupEnv()
    s.svc.update({ set: { WEBTERM_CENTRAL: 'on' }, unset: [] }, ROOT)
    expect(s.target.WEBTERM_CENTRAL).toBe('on')
    s.svc.update({ set: {}, unset: ['WEBTERM_CENTRAL'] }, ROOT)
    expect('WEBTERM_CENTRAL' in s.target).toBe(false)
  })

  it('override tersimpan diterapkan saat boot (overlay ke process.env)', () => {
    const s = setupEnv({ WEBTERM_CENTRAL: 'off' }, JSON.stringify({ WEBTERM_CENTRAL: 'on' }))
    expect(s.target.WEBTERM_CENTRAL).toBe('on')
  })

  it('nilai env non-kanonik tampil apa adanya sebagai sumber env', () => {
    expect(entry(setupEnv({ WEBTERM_CENTRAL: ' ON ' }), 'WEBTERM_CENTRAL')).toMatchObject({ source: 'env', value: 'ON' })
  })
})

describe('validasi di boundary', () => {
  const cases: Array<[string, unknown]> = [
    ['WEBTERM_CENTRAL', 'ON'], ['WEBTERM_CENTRAL', 'on '], ['WEBTERM_CENTRAL', 1], ['WEBTERM_LEDGER', 'maybe'],
    ['WEBTERM_CENTRAL_MODEL', ''], ['WEBTERM_CENTRAL_MODEL', 'a\nb'], ['WEBTERM_CENTRAL_MODEL', 'a\u0000b'],
    ['WEBTERM_CENTRAL_MODEL', 'x'.repeat(513)], ['WEBTERM_MEMORY_DIR', 'relative/path'],
  ]
  it.each(cases)('menolak %s = %j dan tak mengubah apa pun', (key, value) => {
    const s = setupEnv()
    const r = s.svc.update({ set: { [key]: value }, unset: [] }, ROOT)
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_value', key })
    expect(JSON.stringify(r)).not.toContain('relative/path')
    expect(s.overrides.saves).toBe(0)
  })

  it('menerima nilai valid dan men-trim string', () => {
    const s = setupEnv()
    expect(s.svc.update({ set: { WEBTERM_CENTRAL_MODEL: '  opencode/x  ', WEBTERM_MEMORY_DIR: '/tmp/m' }, unset: [] }, ROOT).ok).toBe(true)
    expect(s.target.WEBTERM_CENTRAL_MODEL).toBe('opencode/x')
  })

  it('kunci tak dikenal 400, ganda 400', () => {
    const s = setupEnv()
    expect(s.svc.update({ set: { NOPE: 'x' }, unset: [] }, ROOT)).toMatchObject({ status: 400, error: 'unknown_key' })
    expect(s.svc.update({ set: { WEBTERM_CENTRAL: 'on' }, unset: ['WEBTERM_CENTRAL'] }, ROOT)).toMatchObject({ status: 400, error: 'duplicate_key' })
  })
})

describe('bootstrap-only, dangerous, locked', () => {
  it.each(BOOTSTRAP_ONLY_KEYS)('%s ditolak 400 bootstrap_only (set dan unset)', (key) => {
    const s = setupEnv()
    expect(s.svc.update({ set: { [key]: 'x' }, unset: [] }, ROOT)).toMatchObject({ status: 400, error: 'bootstrap_only', key })
    expect(s.svc.update({ set: {}, unset: [key] }, ROOT)).toMatchObject({ status: 400, error: 'bootstrap_only', key })
    expect(entry(s, key)).toMatchObject({ editable: false, group: 'bootstrap' })
    expect(entry(s, key).value).toBeUndefined()
  })

  it('bootstrap hanya melaporkan terisi/kosong, tak pernah nilai', () => {
    const s = setupEnv({ WEBTERM_TOKEN: 'tok-sentinel-xyz', PORT: '9999' })
    expect(entry(s, 'WEBTERM_TOKEN').set).toBe(true)
    expect(JSON.stringify(s.svc.state(ROOT))).not.toContain('tok-sentinel-xyz')
    expect(JSON.stringify(s.svc.state(ROOT))).not.toContain('9999')
  })

  it('dangerous tanpa root: 403 token_required, tidak ada yang berubah', () => {
    const s = setupEnv()
    const r = s.svc.update({ set: { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' }, unset: [] }, USER)
    expect(r).toMatchObject({ ok: false, status: 403, error: 'token_required', key: 'WEBTERM_ORCHESTRATOR_RUN' })
    expect(s.overrides.saves).toBe(0)
    expect(s.target.WEBTERM_CENTRAL).toBeUndefined()
    expect(entry(s, 'WEBTERM_ORCHESTRATOR_RUN', USER).editable).toBe(false)
    expect(entry(s, 'WEBTERM_CENTRAL', USER).editable).toBe(true)
  })

  it('dangerous dengan root diterima; non-dangerous tak butuh root', () => {
    const s = setupEnv()
    expect(s.svc.update({ set: { WEBTERM_ORCHESTRATOR_RUN: 'on' }, unset: [] }, ROOT).ok).toBe(true)
    expect(s.svc.update({ set: { WEBTERM_CENTRAL: 'on' }, unset: [] }, USER).ok).toBe(true)
  })

  it('WEBTERM_ENV_SETTINGS=off mengunci semua PUT dan mengabaikan override tersimpan', () => {
    const s = setupEnv({ WEBTERM_ENV_SETTINGS: 'off', WEBTERM_CENTRAL: 'off' }, JSON.stringify({ WEBTERM_CENTRAL: 'on' }))
    expect(s.svc.state(ROOT).locked).toBe(true)
    expect(s.target.WEBTERM_CENTRAL).toBe('off')
    expect(s.svc.update({ set: { WEBTERM_CENTRAL: 'on' }, unset: [] }, ROOT)).toMatchObject({ status: 403, error: 'locked' })
    expect(entry(s, 'WEBTERM_CENTRAL').editable).toBe(false)
  })
})

describe('atomik + kegagalan penyimpanan', () => {
  it('satu nilai tak valid membatalkan seluruh perubahan', () => {
    const s = setupEnv()
    const r = s.svc.update({ set: { WEBTERM_CENTRAL: 'on', WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_LEDGER: 'bad' }, unset: [] }, ROOT)
    expect(r.ok).toBe(false)
    expect(s.overrides.saves).toBe(0)
    expect(s.secrets.files.size).toBe(0)
    expect(s.target.WEBTERM_CENTRAL).toBeUndefined()
  })

  it('secret kedua gagal tulis: secret pertama di-rollback, DB tak disentuh, 500 tanpa nilai', () => {
    const s = setupEnv()
    s.secrets.failOn = 'WEBTERM_TELEGRAM_WEBHOOK_SECRET'
    const r = s.svc.update({
      set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_TELEGRAM_WEBHOOK_SECRET: SENTINEL_WEBHOOK_SECRET, WEBTERM_CENTRAL: 'on' },
      unset: [],
    }, ROOT)
    expect(r).toMatchObject({ ok: false, status: 500, error: 'store_failed' })
    expect(s.secrets.files.size).toBe(0)
    expect(s.overrides.saves).toBe(0)
    expect(s.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBeUndefined()
    const out = JSON.stringify(r) + s.logs.join('\n')
    expect(out).not.toContain(SENTINEL_BOT_TOKEN)
    expect(out).not.toContain(SENTINEL_WEBHOOK_SECRET)
  })
})

describe('restart', () => {
  it('melaporkan kunci restart yang berubah dan pendingRestart; kunci hot tidak', () => {
    const s = setupEnv()
    const r = s.svc.update({ set: { WEBTERM_LEDGER: 'on', WEBTERM_CENTRAL: 'on' }, unset: [] }, ROOT)
    expect(r.ok && r.restartRequired).toEqual(['WEBTERM_LEDGER'])
    expect(entry(s, 'WEBTERM_LEDGER').pendingRestart).toBe(true)
    expect(entry(s, 'WEBTERM_CENTRAL').pendingRestart).toBe(false)
    s.svc.update({ set: {}, unset: ['WEBTERM_LEDGER'] }, ROOT)
    expect(entry(s, 'WEBTERM_LEDGER').pendingRestart).toBe(false)
  })
})

describe('storage korup tidak menjatuhkan boot', () => {
  it('JSON rusak, bentuk salah, kunci tak dikenal/secret/nilai tak valid diabaikan dengan log nama saja', () => {
    expect(setupEnv({}, '{not json').logs.join()).toContain('unreadable')
    expect(setupEnv({}, '[1,2]').target).toEqual({})
    const s = setupEnv({}, JSON.stringify({
      WEBTERM_LEDGER: 'SECRETISH-bad-value', NOPE: 'x', WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_CENTRAL: 'on',
    }))
    expect(s.target.WEBTERM_CENTRAL).toBe('on')
    expect(s.target.WEBTERM_LEDGER).toBeUndefined()
    expect(s.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBeUndefined()
    const logs = s.logs.join('\n')
    expect(logs).toContain('WEBTERM_LEDGER')
    expect(logs).not.toContain('SECRETISH')
    expect(logs).not.toContain(SENTINEL_BOT_TOKEN)
  })
})

describe('secret', () => {
  it('write-only: ke process.env + file, tak pernah di respons/log/override DB; redaksi bekerja', () => {
    const s = setupEnv()
    const r = s.svc.update({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_TELEGRAM_WEBHOOK_SECRET: SENTINEL_WEBHOOK_SECRET }, unset: [] }, ROOT)
    expect(r.ok).toBe(true)
    const e = entry(s, 'WEBTERM_TELEGRAM_BOT_TOKEN')
    expect(e).toMatchObject({ set: true, source: 'override' })
    expect(e.value).toBeUndefined()
    const everything = JSON.stringify(r) + JSON.stringify(s.svc.state(ROOT)) + s.logs.join('\n') + String(s.overrides.json)
    expect(everything).not.toContain(SENTINEL_BOT_TOKEN)
    expect(everything).not.toContain(SENTINEL_WEBHOOK_SECRET)
    expect(everything).not.toContain('SENTINEL')
    expect(s.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBe(SENTINEL_BOT_TOKEN)
    expect(resolveWebhookSecret(s.target)).toMatchObject({ ok: true, source: 'env' })
    // redactSecrets membaca process.env global: pasang sementara untuk membuktikan nilai overlay tersaring.
    process.env.WEBTERM_TELEGRAM_BOT_TOKEN = s.target.WEBTERM_TELEGRAM_BOT_TOKEN
    try { expect(redactSecrets(`oops ${SENTINEL_BOT_TOKEN}`)).not.toContain(SENTINEL_BOT_TOKEN) } finally { delete process.env.WEBTERM_TELEGRAM_BOT_TOKEN }
  })

  it('bentuk salah ditolak tanpa mengecho nilai', () => {
    const s = setupEnv()
    const r = s.svc.update({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: 'SENTINEL not a token' }, unset: [] }, ROOT)
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_value', key: 'WEBTERM_TELEGRAM_BOT_TOKEN' })
    expect(JSON.stringify(r) + s.logs.join()).not.toContain('SENTINEL')
    expect(s.secrets.files.size).toBe(0)
  })

  it('hapus secret mengembalikan nilai env awal (atau menghapus bila tak ada)', () => {
    const s = setupEnv({ WEBTERM_TELEGRAM_BOT_TOKEN: '999999:ENVbotTOKENvalue1' })
    expect(entry(s, 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ set: true, source: 'env' })
    s.svc.update({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN }, unset: [] }, ROOT)
    s.svc.update({ set: {}, unset: ['WEBTERM_TELEGRAM_BOT_TOKEN'] }, ROOT)
    expect(s.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBe('999999:ENVbotTOKENvalue1')
    expect(s.secrets.files.size).toBe(0)

    const t = setupEnv()
    t.svc.update({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN }, unset: [] }, ROOT)
    t.svc.update({ set: {}, unset: ['WEBTERM_TELEGRAM_BOT_TOKEN'] }, ROOT)
    expect('WEBTERM_TELEGRAM_BOT_TOKEN' in t.target).toBe(false)
    expect(entry(t, 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ set: false, source: 'default' })
  })

  it('secret di file dimuat saat boot', () => {
    const s = setupEnv()
    s.secrets.write('WEBTERM_TELEGRAM_BOT_TOKEN', SENTINEL_BOT_TOKEN)
    s.svc.apply()
    expect(s.target.WEBTERM_TELEGRAM_BOT_TOKEN).toBe(SENTINEL_BOT_TOKEN)
  })
})
