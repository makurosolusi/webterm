import { customBinPath, withCustomBin } from './customBinPath'
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOTENV_MAX_BYTES, dotenvKeys, getDotenvBoot, PTY_KEEP_FROM_DOTENV, recordDotenvBoot } from './dotenvFiles'
import { ptyEnv } from './ptyShell'

// test-only: nilai palsu penanda.
const MARK = 'sentinel-dotenv-value'
const files = (map: Record<string, string>) => (p: string) => map[p.slice(p.lastIndexOf('/') + 1)] ?? null

describe('dotenvKeys', () => {
  it('mem-parse kutip, export, komentar, dan nilai berisi =', () => {
    const read = files({ '.env': `A=1\nexport B="x=y"\n# C=3\nD='q'\n` })
    const env = { A: '1', B: 'x=y', C: '3', D: 'q' }
    expect([...dotenvKeys({ cwd: '/w', env, read })].sort()).toEqual(['A', 'B', 'D'])
  })

  it('kunci yang ditimpa shell (nilai beda) tidak masuk', () => {
    const read = files({ '.env': 'A=1\nB=2\n' })
    expect([...dotenvKeys({ cwd: '/w', env: { A: '1', B: 'dari-shell' }, read })]).toEqual(['A'])
  })

  it('.env.local mengalahkan .env; berkas per-lingkungan mengikuti NODE_ENV', () => {
    const read = files({ '.env': 'A=1\nP=base\n', '.env.local': 'A=2\n', '.env.production': 'P=prod\n', '.env.development': 'P=dev\n' })
    expect([...dotenvKeys({ cwd: '/w', env: { A: '2', P: 'prod', NODE_ENV: 'production' }, read })].sort()).toEqual(['A', 'P'])
    expect([...dotenvKeys({ cwd: '/w', env: { A: '1', P: 'dev' }, read })]).toEqual(['P'])
  })

  it('berkas di atas batas ukuran dilewati; tanpa berkas = kosong', () => {
    const big = `A=1\n#${'x'.repeat(DOTENV_MAX_BYTES)}`
    expect(dotenvKeys({ cwd: '/w', env: { A: '1' }, read: files({ '.env': big }) }).size).toBe(0)
    expect(dotenvKeys({ cwd: '/w', env: { A: '1' }, read: () => null }).size).toBe(0)
  })

  it('pembaca default: berkas asli di mkdtemp (tanpa chdir) dan ENOENT = kosong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'))
    expect(dotenvKeys({ cwd: dir, env: { A: '1' } }).size).toBe(0)
    writeFileSync(join(dir, '.env'), `A=${MARK}\n`)
    expect([...dotenvKeys({ cwd: dir, env: { A: MARK } })]).toEqual(['A'])
  })

  it('galat baca non-ENOENT dilempar dengan nama berkas, tanpa isi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'))
    mkdirSync(join(dir, '.env')) // .env sebagai DIREKTORI: stat lolos, baca gagal EISDIR
    expect(() => dotenvKeys({ cwd: dir, env: { A: MARK } })).toThrow(/dotenv: cannot read .*\.env \(EISDIR\)/)
  })
})

describe('recordDotenvBoot + ptyEnv', () => {
  it('sebelum dicatat provenance kosong; dicatat sekali dan tidak berubah', () => {
    expect(getDotenvBoot().keys.size).toBe(0)
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'))
    writeFileSync(join(dir, '.env'), 'ZED=1\n')
    expect([...recordDotenvBoot(dir, { ZED: '1' }).keys]).toEqual(['ZED'])
    expect(recordDotenvBoot('/lain', {}).cwd).toBe(dir)
    expect(getDotenvBoot().keys.has('ZED')).toBe(true)
  })

  it('kunci asal .env dibuang, nilai beda dipertahankan, provider/OS dipertahankan', () => {
    const strip = new Set(['APP_SECRET', 'ANTHROPIC_API_KEY', 'PATH', 'LC_ALL'])
    const input = { APP_SECRET: MARK, SAMA: 'dari-shell', ANTHROPIC_API_KEY: 'k', PATH: '/x', LC_ALL: 'C', LAIN: 'v' }
    const env = ptyEnv(input, { interactive: false, strip })
    expect('APP_SECRET' in env).toBe(false)
    expect(env).toMatchObject({ SAMA: 'dari-shell', ANTHROPIC_API_KEY: 'k', LC_ALL: 'C', LAIN: 'v' })
    // ptyEnv puts the managed custom-bin dir first; the inherited PATH must survive right behind it.
    expect(env.PATH).toBe(withCustomBin('/x', customBinPath(input)))
    expect(env.PATH!.endsWith('/x')).toBe(true)
  })

  it('TELEGRAM_BOT_TOKEN tidak pernah masuk PTY, walau bukan asal .env', () => {
    const env = ptyEnv({ TELEGRAM_BOT_TOKEN: MARK, PATH: '/x' }, { interactive: false, strip: new Set() })
    expect(JSON.stringify(env)).not.toContain(MARK)
  })

  it('PTY_KEEP_FROM_DOTENV: provider, OS, LC_*; bukan kunci aplikasi', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'PATH', 'HOME', 'SSH_AUTH_SOCK', 'LC_TIME']) expect(PTY_KEEP_FROM_DOTENV(k), k).toBe(true)
    for (const k of ['DATABASE_URL', 'STRIPE_KEY', 'LCX', 'OPENAI_API_KEY']) expect(PTY_KEEP_FROM_DOTENV(k), k).toBe(false)
  })
})
