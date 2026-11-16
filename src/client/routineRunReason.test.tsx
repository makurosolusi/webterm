/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RoutineRow, runText, type RoutineRun, type RoutineView } from './RoutineRow'
import { describeRunReason } from './routineRunReason'

afterEach(cleanup)

const KINDS = ['network', 'rate_limited', 'overloaded', 'server', 'unknown', 'something_new'] as const
const PROTOCOL = /retryable|retried|\[|\]|rate_limited|network\]/

describe('describeRunReason', () => {
  it.each(KINDS)('shows retryable[%s] as retrying, with a friendly cause and no prefix', (kind) => {
    const v = describeRunReason('failed', `retryable[${kind}]: socket hang up`)
    expect(v.status).toBe('retrying')
    expect(v.label).toBe('Retrying after a connection problem')
    expect(v.reason).toBeTruthy()
    expect(`${v.label} ${v.reason}`).not.toMatch(PROTOCOL)
    expect(v.reason).not.toContain('socket hang up') // the raw detail stays out of the friendly line
  })

  it('gives each known failure class its own wording', () => {
    const causes = ['network', 'rate_limited', 'overloaded', 'server'].map((k) => describeRunReason('failed', `retryable[${k}]: x`).reason)
    expect(new Set(causes).size).toBe(4)
    expect(causes[1]).toMatch(/limiting requests/)
    expect(causes[2]).toMatch(/overloaded/)
  })

  it('shows retried[...] as Retried and keeps the original detail without the prefix', () => {
    const v = describeRunReason('failed', 'retried[network]: ECONNRESET talking to the API')
    expect(v).toEqual({ status: 'retried', label: 'Retried', reason: 'ECONNRESET talking to the API' })
    expect(describeRunReason('failed', 'retried[server]').reason).toMatch(/run again/)
  })

  it('leaves a final failure failed, with its text untouched', () => {
    expect(describeRunReason('failed', 'login expired')).toEqual({ status: 'failed', label: 'Failed', reason: 'login expired' })
    expect(describeRunReason('failed', null)).toEqual({ status: 'failed', label: 'Failed', reason: null })
  })

  it('only treats prefixes as protocol on failed runs', () => {
    expect(describeRunReason('skipped', 'retryable[network]: x').status).toBe('skipped')
    expect(describeRunReason('ran', null).label).toBe('Ran')
  })

  it('does not match prefix-like text that is not at the start', () => {
    expect(describeRunReason('failed', 'the log said retryable[network]: x').status).toBe('failed')
  })
})

const run = (status: RoutineRun['status'], reason: string | null): RoutineRun => ({ id: `r-${status}-${reason}`, trigger: 'schedule', status, reason, startedAt: 1_700_000_000_000, costUsd: null }) // test-only

const routine = (lastRun: RoutineRun): RoutineView => ({
  id: 'r1', name: 'Nightly', enabled: true, workspaceId: null, trigger: { type: 'schedule', cron: '0 2 * * *' }, precheck: null,
  action: { type: 'spawn', prompt: 'p' }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: null }, tier: 'R2', nextRunAt: null, lastRun,
})

function row(lastRun: RoutineRun, history: RoutineRun[] | null = null) {
  render(<ul><RoutineRow r={routine(lastRun)} history={history} run={async () => ({})} setEnabled={() => {}} edit={() => {}} toggleHistory={() => {}} remove={() => {}} /></ul>)
}

describe('RoutineRow with a transient failure', () => {
  it('reads "Retrying after a connection problem" instead of Failed with a raw prefix', () => {
    row(run('failed', 'retryable[rate_limited]: 429 too many requests'))
    const text = screen.getByTestId('last-run').textContent!
    expect(text).toMatch(/^Retrying after a connection problem, on schedule — Claude is limiting requests/)
    expect(text).not.toMatch(/Failed|retryable|\[|429/)
  })

  it('reads "Retried" for a run whose retry was taken', () => {
    row(run('failed', 'retried[network]: connection reset'))
    expect(screen.getByTestId('last-run').textContent).toBe('Retried, on schedule — connection reset')
  })

  it('keeps a final failure as Failed', () => {
    row(run('failed', 'permission denied'))
    expect(screen.getByTestId('last-run').textContent).toBe('Failed, on schedule — permission denied')
  })

  it('marks history items with the derived status and leaks no prefix', () => {
    row(run('ran', null), [run('failed', 'retryable[server]: 502'), run('failed', 'retried[server]: 502'), run('failed', 'boom')])
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-status'))
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual(['retrying', 'retried', 'failed'])
    for (const li of items) expect(li.textContent).not.toMatch(/retryable\[|retried\[/)
  })

  it('formats runText the same way', () => {
    expect(runText(run('failed', 'retryable[overloaded]: 529'))).toMatch(/^Retrying after a connection problem, on schedule — Claude is overloaded/)
  })
})
