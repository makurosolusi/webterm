import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FILES_LIST_MAX_DEFAULT } from '../shared/fsLimits'
import { ENV_REGISTRY, specFor } from './envRegistry'
import { FILES_ENV_SPECS, FILES_FLAG, filesFlagOn, filesListMax, filesUploadMaxBytes, type FilesFlag } from './envRegistry.files'
import { validateEnvValue } from './envSettings.validate'

describe('envRegistry.files', () => {
  it('enam flag terdaftar, kind flag, bukan dangerous, dan ada di ENV_REGISTRY', () => {
    for (const key of Object.values(FILES_FLAG)) {
      expect(specFor(key), key).toMatchObject({ kind: 'flag', dangerous: false })
      expect(ENV_REGISTRY.some((s) => s.key === key)).toBe(true)
    }
    expect(Object.keys(FILES_FLAG)).toHaveLength(6)
  })

  it('angka: LIST_MAX 5000 dan UPLOAD_MAX_MB 100 by default, default lolos validator', () => {
    expect(specFor('WEBTERM_FILES_LIST_MAX')).toMatchObject({ kind: 'number', default: '5000' })
    expect(specFor('WEBTERM_FILES_UPLOAD_MAX_MB')).toMatchObject({ kind: 'number', default: '100' })
    for (const s of FILES_ENV_SPECS) expect(validateEnvValue(s, s.default ?? ''), s.key).toMatchObject({ ok: true })
  })

  it('L11: empat flag baca-saja default on di registry, mutate/upload tetap off', () => {
    const readOnly: FilesFlag[] = ['VIEWERS', 'WATCH', 'GIT_STATUS', 'QUICK_OPEN']
    for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) {
      expect(specFor(FILES_FLAG[name])?.default, name).toBe(readOnly.includes(name) ? 'on' : 'off')
    }
  })

  it('filesFlagOn: env kosong => paritas dengan default registry (G6); mutate/upload false', () => {
    for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) {
      expect(filesFlagOn(name, {}), name).toBe(specFor(FILES_FLAG[name])?.default === 'on')
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: '  ' }), name).toBe(filesFlagOn(name, {}))
    }
    for (const name of ['VIEWERS', 'WATCH', 'GIT_STATUS', 'QUICK_OPEN'] as const) expect(filesFlagOn(name, {})).toBe(true)
    for (const name of ['MUTATE', 'UPLOAD'] as const) expect(filesFlagOn(name, {})).toBe(false)
  })

  it('filesFlagOn: nilai eksplisit menang; off/typo = false, on (spasi/kapital ok) = true', () => {
    for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) {
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: 'off' })).toBe(false)
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: 'yes' })).toBe(false)
      // UPLOAD anak filesWrite: butuh MUTATE on juga (ES-05)
      const env = { [FILES_FLAG[name]]: ' ON ', ...(name === 'UPLOAD' ? { WEBTERM_FILES_MUTATE: 'on' } : {}) }
      expect(filesFlagOn(name, env)).toBe(true)
    }
    expect(filesFlagOn('MUTATE', { WEBTERM_FILES_MUTATE: 'on' })).toBe(true)
  })

  it('kemampuan files/filesWrite: files off menutup semua; mutate/upload tidak terbuka hanya karena files on', () => {
    const off = { WEBTERM_FILES_VIEWERS: 'off', WEBTERM_FILES_MUTATE: 'on', WEBTERM_FILES_UPLOAD: 'on' }
    for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) expect(filesFlagOn(name, off), name).toBe(false)
    expect(filesFlagOn('VIEWERS', { WEBTERM_FILES_VIEWERS: 'on' })).toBe(true)
    expect(filesFlagOn('MUTATE', { WEBTERM_FILES_VIEWERS: 'on' })).toBe(false)
    expect(filesFlagOn('UPLOAD', { WEBTERM_FILES_VIEWERS: 'on', WEBTERM_FILES_UPLOAD: 'on' })).toBe(false)
    expect(filesFlagOn('UPLOAD', { WEBTERM_FILES_MUTATE: 'on', WEBTERM_FILES_UPLOAD: 'on' })).toBe(true)
    expect(filesFlagOn('WATCH', { WEBTERM_FILES_WATCH: 'off' })).toBe(false) // anak dimatikan sendiri
  })

  it('dibaca per panggilan: env berubah langsung berlaku tanpa restart', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(filesFlagOn('MUTATE', env)).toBe(false)
    env.WEBTERM_FILES_MUTATE = 'on'
    expect(filesFlagOn('MUTATE', env)).toBe(true)
  })

  it('filesListMax / filesUploadMaxBytes: default, override sah, nilai sampah jatuh ke default', () => {
    expect(filesListMax({})).toBe(FILES_LIST_MAX_DEFAULT)
    expect(filesListMax({ WEBTERM_FILES_LIST_MAX: '200' })).toBe(200)
    expect(filesListMax({ WEBTERM_FILES_LIST_MAX: 'abc' })).toBe(FILES_LIST_MAX_DEFAULT)
    expect(filesListMax({ WEBTERM_FILES_LIST_MAX: '-5' })).toBe(FILES_LIST_MAX_DEFAULT)
    expect(filesUploadMaxBytes({})).toBe(100 * 1024 * 1024)
    expect(filesUploadMaxBytes({ WEBTERM_FILES_UPLOAD_MAX_MB: '2' })).toBe(2 * 1024 * 1024)
  })

  it('file data <= 100 baris (Rule 8 config)', () => {
    expect(readFileSync(new URL('./envRegistry.files.ts', import.meta.url), 'utf8').split('\n').length).toBeLessThanOrEqual(100)
  })
})
