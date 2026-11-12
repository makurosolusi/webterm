// test-only fixtures shared by the Health tab tests.
import { fireEvent, screen } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { FindingView, HealthScanView } from '../../../shared/centralHealth'
import type { AnalysisView, HealthClient, HealthSummaryView } from './healthApi'
import { HL } from './healthModel'

export const scanOf = (over: Partial<HealthScanView> = {}): HealthScanView => ({
  id: 's1', projectId: 'p1', origin: 'scan', status: 'done', startedAt: Date.now() - 60_000, finishedAt: Date.now() - 60_000, filesScanned: 42, truncated: false, opened: 1, fixed: 0, error: null, ...over,
})
export const summaryOf = (over: Partial<HealthSummaryView> = {}): HealthSummaryView => ({ open: 1, high: 1, medium: 0, low: 0, lastScan: scanOf(), running: false, ...over })
export const findingOf = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f1', projectId: 'p1', origin: 'scan', status: 'open', rule: 'file_size', severity: 'high', confidence: 'high', file: 'src/big.ts', line: 12,
  title: 'File too large', evidence: '612 lines', source: 'Rule 8 (global CLAUDE.md)', suggestion: 'Split it by concern.', fingerprint: 'fp',
  taskId: null, dismissedReason: null, dismissedBy: null, firstSeenAt: 1, lastSeenAt: 2, fixedAt: null, ...over,
})

export const expand = async (title = 'File too large') => fireEvent.click(await screen.findByRole('button', { name: HL.details(title) }))

export function makeClient(over: Partial<HealthClient> = {}) {
  const client = {
    listProjects: vi.fn(async (): Promise<Array<{ id: string; name: string; root?: string }>> => [{ id: 'p1', name: 'Alpha', root: '/repo' }]),
    countFindings: vi.fn(async (_p: string, status: string) => ({ count: status === 'fixed' ? 2 : 0, more: false })),
    getSummary: vi.fn(async () => summaryOf()),
    listFindings: vi.fn(async () => ({ items: [findingOf()], hasMore: false })),
    scan: vi.fn(async () => undefined),
    dismiss: vi.fn(async (id: string, reason: string) => findingOf({ id, status: 'dismissed', dismissedReason: reason })),
    reopen: vi.fn(async (id: string) => findingOf({ id })),
    getAnalysis: vi.fn(async (): Promise<AnalysisView> => ({ scan: null, running: false, retryAt: null, dropped: null })),
    analyze: vi.fn(async () => undefined),
    ...over,
  }
  return client as unknown as { [K in keyof HealthClient]: Mock<HealthClient[K]> }
}
