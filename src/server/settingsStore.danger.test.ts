// Danger confirmation contract: a level change to `never` (global or one workspace) is accepted only
// with `confirmDanger: true` in the same PATCH; the route answers 400 `confirm_required` otherwise.
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { settingsRoute } from './settingsApi'
import { nextSettingsDocument, SettingsConfirmError, SettingsValidationError } from './settingsStore'

const refused = (fn: () => unknown): string[] => {
  try { fn() } catch (e) { if (e instanceof SettingsConfirmError) return e.scopes; throw e }
  throw new Error('expected SettingsConfirmError')
}

// The default level is Bypass since 2026-11-17, so the "moves to Bypass" cases start from a stored Auto.
const AUTO = JSON.stringify({ skipApprovals: false })

describe('confirmDanger', () => {
  it('global or per-workspace Danger needs it; with it the level is stored', () => {
    expect(refused(() => nextSettingsDocument(AUTO, { agentApprovalLevel: 'never' }))).toEqual(['global'])
    expect(refused(() => nextSettingsDocument(AUTO, { skipApprovals: true }))).toEqual(['global'])
    expect(refused(() => nextSettingsDocument(AUTO, { projectApprovalLevels: { w1: 'never' } }))).toEqual(['w1'])
    expect(nextSettingsDocument(AUTO, { agentApprovalLevel: 'never', confirmDanger: true }).settings.agentApprovalLevel).toBe('never')
    const { doc, settings } = nextSettingsDocument(AUTO, { projectApprovalLevels: { w1: 'never' }, confirmDanger: true })
    expect(settings.projectApprovalLevels).toEqual({ w1: 'never' })
    expect(doc.confirmDanger).toBe(undefined) // never stored
  })

  it('no confirmation needed when nothing moves to Danger (already Danger, or leaving it)', () => {
    const danger = JSON.stringify({ skipApprovals: true })
    expect(nextSettingsDocument(danger, { projectApprovalLevels: { w1: 'never' } }).settings.projectApprovalLevels).toEqual({ w1: 'never' })
    expect(nextSettingsDocument(danger, { agentApprovalLevel: 'risky' }).settings.agentApprovalLevel).toBe('risky')
    expect(nextSettingsDocument(AUTO, { projectApprovalLevels: { w1: 'always' } }).settings.projectApprovalLevels).toEqual({ w1: 'always' })
    // Clearing an Ask override under a global Danger moves that workspace to Danger.
    expect(refused(() => nextSettingsDocument(JSON.stringify({ skipApprovals: true, projectApprovalLevels: { w1: 'always' } }), { projectApprovalLevels: { w1: null } }))).toEqual(['w1'])
  })

  it('an unknown per-workspace level is a validation error', () => {
    expect(() => nextSettingsDocument(null, { projectApprovalLevels: { w1: 'yolo' } })).toThrow(SettingsValidationError)
  })

  it('PUT /api/settings answers 400 confirm_required with the scopes, nothing saved', async () => {
    const r = Object.assign(new EventEmitter(), { method: 'PUT', headers: {} }) as unknown as IncomingMessage
    process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify({ projectApprovalLevels: { w1: 'never' } }))); r.emit('end') })
    const out = { statusCode: 0, body: '', setHeader() {}, end(b?: string) { out.body = b ?? '' } }
    let saved = false
    await settingsRoute(r, out as unknown as ServerResponse, 'PUT', { getSettings: () => DEFAULT_SETTINGS, saveSettings: (p) => { const n = nextSettingsDocument(AUTO, p).settings; saved = true; return n } })
    expect(out.statusCode).toBe(400)
    expect(JSON.parse(out.body)).toEqual({ error: 'confirm_required', scopes: ['w1'] })
    expect(saved).toBe(false)
  })
})
