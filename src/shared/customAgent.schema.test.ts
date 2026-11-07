import { describe, expect, it } from 'vitest'
import { canonicalDefJson, normalizeCustomAgents, type CustomAgent } from './customAgent.schema'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'

const LEGACY = { id: 'custom:a', label: 'A', launchCmd: 'a --x', baseAgent: 'claude', color: '#fff' }
const v2 = (over: Record<string, unknown>): Record<string, unknown> => ({ ...LEGACY, ...over })
const strictCodes = (e: unknown): string[] =>
  normalizeCustomAgents([e], 'strict').errors.map((x) => `${x.field}:${x.code}`)

describe('normalizeCustomAgents strict', () => {
  it('menerima entri lama dan entri v2 penuh', () => {
    expect(normalizeCustomAgents([LEGACY], 'strict')).toEqual({ agents: [LEGACY], errors: [] })
    const full = v2({
      icon: 'bot',
      launch: { program: 'myagent', args: ['--a'], resumeArgs: ['--resume', '{sessionId}'], headlessArgs: ['-p', '{prompt}'] },
      env: { MODE: 'fast', MY_API_KEY: '${env:HOST_KEY}' },
      centralSpawn: true,
    })
    expect(normalizeCustomAgents([full], 'strict').errors).toEqual([])
  })

  it.each(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'sudo', 'doas', 'xargs', 'eval', '/bin/sh', '/usr/bin/env'])(
    'menolak program shell %s', (program) => {
      expect(strictCodes(v2({ launch: { program } }))).toEqual(['launch.program:forbidden_program'])
    })

  it.each(['has space', '-rf', 'a;b', 'rel/path', '/abs/../x', '/abs/a\nb', 'x'.repeat(65)])(
    'menolak program tak sah %j', (program) => {
      expect(strictCodes(v2({ launch: { program } }))).toEqual(['launch.program:bad_program'])
    })

  it('menerima path absolut', () => {
    expect(strictCodes(v2({ launch: { program: '/opt/bin/agent' } }))).toEqual([])
  })

  it('menolak NUL/newline, terlalu banyak/panjang, placeholder asing di args', () => {
    const args = (a: unknown): string[] => strictCodes(v2({ launch: { program: 'p', args: a } }))
    expect(args(['a\nb'])).toEqual(['launch.args:bad_char'])
    expect(args(['a\0b'])).toEqual(['launch.args:bad_char'])
    expect(args(Array(33).fill('x'))).toEqual(['launch.args:too_many'])
    expect(args(['x'.repeat(257)])).toEqual(['launch.args:too_long'])
    expect(args([1])).toEqual(['launch.args:not_string'])
    expect(args(['{cwd}'])).toEqual(['launch.args:bad_placeholder'])
    expect(args('x')).toEqual(['launch.args:not_array'])
    expect(args(['{prompt}', '{sessionId}'])).toEqual([])
  })

  it('headlessArgs wajib tepat satu elemen {prompt}; resumeArgs wajib {sessionId}', () => {
    const h = (a: string[]): string[] => strictCodes(v2({ launch: { program: 'p', headlessArgs: a } }))
    expect(h(['-p', '{prompt}'])).toEqual([])
    expect(h(['{prompt}', '{prompt}'])).toEqual(['launch.headlessArgs:prompt_placeholder'])
    expect(h(['-p'])).toEqual(['launch.headlessArgs:prompt_placeholder'])
    expect(h(['--x={prompt}'])).toEqual(['launch.headlessArgs:prompt_placeholder'])
    const r = (a: string[]): string[] => strictCodes(v2({ launch: { program: 'p', resumeArgs: a } }))
    expect(r(['--resume'])).toEqual(['launch.resumeArgs:missing_session_id'])
    expect(r(['--resume', '{sessionId}'])).toEqual([])
  })

  it('env: kunci terlarang, literal untuk kunci secret, ref, nilai berbahaya', () => {
    const env = (e: unknown): string[] => strictCodes(v2({ env: e }))
    expect(env({ WEBTERM_X: '1' })).toEqual(['env.WEBTERM_X:reserved_key'])
    expect(env({ NODETERM_PORT: '1' })).toEqual(['env.NODETERM_PORT:reserved_key'])
    expect(env({ wcap_x: '1' })).toEqual(['env.wcap_x:reserved_key'])
    expect(env({ lower: '1' })).toEqual(['env.lower:bad_key'])
    expect(env({ MY_TOKEN: 'abc' })).toEqual(['env.MY_TOKEN:secret_literal'])
    expect(env({ MY_TOKEN: '${env:HOST_TOKEN}' })).toEqual([])
    expect(env({ MODE: 'a${env:X}' })).toEqual(['env.MODE:bad_value'])
    expect(env({ MODE: 'a\nb' })).toEqual(['env.MODE:bad_value'])
    expect(env({ MODE: 1 })).toEqual(['env.MODE:not_string'])
    expect(env([])).toEqual(['env:not_object'])
  })

  it('menolak tipe salah di field lain, id ganda, dan non-array/non-objek', () => {
    expect(strictCodes(v2({ baseAgent: 'nope' }))).toEqual(['baseAgent:unknown_agent'])
    expect(strictCodes(v2({ centralSpawn: 'yes' }))).toEqual(['centralSpawn:not_boolean'])
    expect(strictCodes(v2({ icon: 'http://x/y.png' }))).toEqual(['icon:bad_value'])
    expect(strictCodes(v2({ label: 'x'.repeat(41) }))).toEqual(['label:bad_value'])
    expect(normalizeCustomAgents([LEGACY, LEGACY], 'strict').errors).toEqual([{ index: 1, field: 'id', code: 'duplicate' }])
    expect(normalizeCustomAgents('x', 'strict').errors).toEqual([{ index: -1, field: 'customAgents', code: 'not_array' }])
    expect(normalizeCustomAgents([7], 'strict').errors).toEqual([{ index: 0, field: '', code: 'not_object' }])
  })
})

describe('normalizeCustomAgents load', () => {
  it('membuang elemen rusak/non-objek tanpa melempar, mempertahankan yang sah', () => {
    const bad = v2({ id: 'custom:bad', launch: { program: 'bash' } })
    const out = normalizeCustomAgents([LEGACY, bad, 7, null, 'x'], 'load')
    expect(out.agents).toEqual([LEGACY])
    expect(out.errors.map((e) => e.index)).toEqual([1, 2, 3, 4])
    expect(normalizeCustomAgents({ nope: true }, 'load')).toEqual({ agents: [], errors: [] })
  })

  it('toleran pada field lama: label kosong/panjang tetap lolos, field asing dibuang', () => {
    const legacy = { id: 'custom:x', label: '', launchCmd: '' }
    const long = { id: 'custom:y', label: 'x'.repeat(80), launchCmd: 'y', zzz: 1 }
    expect(normalizeCustomAgents([legacy, long], 'load').agents).toEqual([legacy, { id: 'custom:y', label: long.label, launchCmd: 'y' }])
  })

  it('keeps an agent based on a retired builtin (codex) as a standalone CLI, keeps claude-based ones whole', () => {
    const codexBased = { id: 'custom:c', label: 'My Codex', launchCmd: 'codex-wrap', baseAgent: 'codex' }
    const claudeBased = { id: 'custom:p', label: 'Proxy', launchCmd: '', baseAgent: 'claude' }
    const out = normalizeCustomAgents([codexBased, claudeBased], 'load')
    expect(out.agents).toEqual([{ id: 'custom:c', label: 'My Codex', launchCmd: 'codex-wrap' }, claudeBased])
    expect(out.errors).toEqual([])
  })
})

describe('mergeSettings dengan customAgents', () => {
  it('settings lama tanpa field baru round-trip identik', () => {
    const saved = { fontSize: 15, customAgents: [LEGACY, { id: 'custom:b', label: 'B', launchCmd: '' }] }
    const merged = mergeSettings(saved)
    expect(merged.customAgents).toEqual(saved.customAgents)
    expect(mergeSettings(JSON.parse(JSON.stringify(merged)))).toEqual(merged)
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('entri rusak dibuang, input tak dimutasi, callback menerima galat', () => {
    const bad = v2({ id: 'custom:bad', env: { MY_TOKEN: 'literal' } })
    const saved = { customAgents: [LEGACY, bad] }
    const before = JSON.stringify(saved)
    const seen: string[] = []
    const merged = mergeSettings(saved, (errs) => seen.push(...errs.map((e) => e.code)))
    expect(merged.customAgents).toEqual([LEGACY])
    expect(seen).toEqual(['secret_literal'])
    expect(JSON.stringify(saved)).toBe(before)
  })
})

describe('canonicalDefJson', () => {
  const base: CustomAgent = { id: 'custom:a', label: 'A', launchCmd: '', launch: { program: 'p', args: ['x'] }, env: { B: '2', A: '${env:H}' } }
  it('stabil terhadap urutan env, tak memuat label/id, dan berubah bila launch/env berubah', () => {
    const reordered = { ...base, label: 'Z', id: 'custom:z', env: { A: '${env:H}', B: '2' } }
    expect(canonicalDefJson(reordered)).toBe(canonicalDefJson(base))
    expect(canonicalDefJson({ ...base, launch: { program: 'q' } })).not.toBe(canonicalDefJson(base))
    expect(canonicalDefJson({ ...base, env: { ...base.env, B: '3' } })).not.toBe(canonicalDefJson(base))
  })
})
