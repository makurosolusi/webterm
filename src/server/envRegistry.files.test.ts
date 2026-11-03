import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FILES_LIST_MAX_DEFAULT } from '../shared/fsLimits'
import { ENV_REGISTRY, specFor } from './envRegistry'
import { FILES_ENV_SPECS, FILES_FLAG, filesFlagOn, filesListMax, filesUploadMaxBytes, type FilesFlag } from './envRegistry.files'
import { validateEnvValue } from './envSettings.validate'

describe('envRegistry.files', () => {
  it('enam flag terdaftar, kind flag, default OFF, bukan dangerous, dan ada di ENV_REGISTRY', () => {
    for (const key of Object.values(FILES_FLAG)) {
      expect(specFor(key), key).toMatchObject({ kind: 'flag', default: 'off', dangerous: false })
      expect(ENV_REGISTRY.some((s) => s.key === key)).toBe(true)
    }
    expect(Object.keys(FILES_FLAG)).toHaveLength(6)
  })

  it('angka: LIST_MAX 5000 dan UPLOAD_MAX_MB 100 by default, default lolos validator', () => {
    expect(specFor('WEBTERM_FILES_LIST_MAX')).toMatchObject({ kind: 'number', default: '5000' })
    expect(specFor('WEBTERM_FILES_UPLOAD_MAX_MB')).toMatchObject({ kind: 'number', default: '100' })
    for (const s of FILES_ENV_SPECS) expect(validateEnvValue(s, s.default ?? ''), s.key).toMatchObject({ ok: true })
  })

  it('filesFlagOn: kosong/off/typo = false, hanya `on` = true', () => {
    for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) {
      expect(filesFlagOn(name, {})).toBe(false)
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: 'off' })).toBe(false)
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: 'yes' })).toBe(false)
      expect(filesFlagOn(name, { [FILES_FLAG[name]]: ' ON ' })).toBe(true)
    }
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
