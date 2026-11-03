import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// db.ts memuat bun:sqlite (tak ada di vitest node); notis tak menyentuh DB.
vi.mock('./db', () => ({ openDb: () => ({}) }))
import { setupEnv } from './envSettings.testutil'
import { logBus } from './logs'
import { warnDotenvDetected } from './envSettings.runtime'

// test-only: nilai palsu penanda.
const MARK = 'sentinel-notice-value'
const warns = () => logBus.query({}).filter((e) => e.event === 'env.dotenv_detected')

describe('warnDotenvDetected', () => {
  it('tanpa .env tidak warn, walau ada kunci bersumber env', () => {
    const { svc } = setupEnv({ WEBTERM_LOG_LEVEL: 'info' })
    warnDotenvDetected(svc, mkdtempSync(join(tmpdir(), 'notice-')))
    expect(warns()).toHaveLength(0)
  })

  it('dengan .env: tepat satu warn untuk dua panggilan, hanya NAMA kunci', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notice-'))
    writeFileSync(join(dir, '.env'), `WEBTERM_LOG_LEVEL=${MARK}\n`)
    const { svc } = setupEnv({ WEBTERM_LOG_LEVEL: MARK })
    warnDotenvDetected(svc, dir)
    warnDotenvDetected(svc, dir)
    expect(warns()).toHaveLength(1)
    expect(warns()[0].data).toMatchObject({ keys: ['WEBTERM_LOG_LEVEL'], count: 1 })
    expect(JSON.stringify(logBus.query({}))).not.toContain(MARK)
  })
})
