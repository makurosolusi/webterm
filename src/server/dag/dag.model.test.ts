// F4-b pure DAG model: brief validation, leases, automatic waves, worker signals, the worker prompt.
import { describe, expect, it } from 'vitest'
import { DagError, leasePrefix, leasesOverlap, parseWorkerSignal, planWaves, renderBrief, validateBrief, validateTasks } from './dag.model'

// test-only brief
const brief = (lease: string[], extra: Record<string, unknown> = {}) => ({
  objective: 'Do it', outputFormat: 'diff + one line summary', tools: ['Read', 'Edit'], boundaries: 'no network',
  verifyCmd: { file: 'npm', args: ['test'] }, nextAction: 'review', effort: 'simple', lease, ...extra,
})
const task = (key: string, lease: string[], deps: string[] = []) => ({ key, deps, brief: brief(lease) })

describe('brief', () => {
  it('every structured field is mandatory for a work task', () => {
    for (const field of ['objective', 'outputFormat', 'tools', 'boundaries', 'verifyCmd', 'nextAction', 'effort', 'lease']) {
      const b = brief(['src/**']) as Record<string, unknown>
      delete b[field]
      expect(() => validateBrief(b, 'work'), field).toThrow(DagError)
    }
    expect(validateBrief(brief(['src/**']), 'work').verifyCmd).toEqual({ file: 'npm', args: ['test'] })
  })

  it('verify_cmd must be an allowlisted argv, never a shell string', () => {
    expect(() => validateBrief(brief(['src'], { verifyCmd: { file: 'sh', args: ['-c', 'rm -rf /'] } }), 'work')).toThrow(/not allowlisted/)
    expect(() => validateBrief(brief(['src'], { verifyCmd: 'npm test' }), 'work')).toThrow(DagError)
    expect(() => validateBrief(brief(['src'], { effort: 'huge' }), 'work')).toThrow(/effort/)
  })

  it('a gate node needs only the question and the next action', () => {
    expect(validateBrief({ objective: 'Ship to prod?', nextAction: 'deploy', options: ['yes', 'no'] }, 'gate')).toMatchObject({ objective: 'Ship to prod?', lease: [], options: ['yes', 'no'] })
    expect(() => validateBrief({ objective: 'Ship?' }, 'gate')).toThrow(/nextAction/)
  })
})

describe('leases', () => {
  it('globs widen to their literal prefix; escapes are refused', () => {
    expect(leasePrefix('src/a/**')).toBe('src/a')
    expect(leasePrefix('./src/a/*.ts')).toBe('src/a')
    expect(leasePrefix('**')).toBe('')
    expect(() => leasePrefix('../x')).toThrow(DagError)
    expect(() => leasePrefix('/etc/passwd')).toThrow(DagError)
  })

  it('overlap is prefix containment by path segment', () => {
    expect(leasesOverlap(['src/a/**'], ['src/a/x.ts'])).toBe(true)
    expect(leasesOverlap(['src/a'], ['src/ab'])).toBe(false)
    expect(leasesOverlap(['**'], ['docs'])).toBe(true)
    expect(leasesOverlap(['src/a', 'docs'], ['test', 'docs/x.md'])).toBe(true)
  })
})

describe('waves', () => {
  it('independent tasks share a wave; overlapping leases are pushed to the next wave', () => {
    const tasks = validateTasks([task('a', ['src/a/**']), task('b', ['src/a/x.ts']), task('c', ['src/c'])])
    expect(planWaves(tasks)).toEqual([['a', 'c'], ['b']])
  })

  it('a dependency runs one wave after what it waits for', () => {
    const tasks = validateTasks([task('d', ['docs'], ['a']), task('a', ['src']), { key: 'g', kind: 'gate', deps: ['d'], brief: { objective: 'ok?', nextAction: 'merge' } }])
    expect(planWaves(tasks)).toEqual([['a'], ['d'], ['g']])
  })

  it('cycles, unknown deps and duplicate keys are refused', () => {
    expect(() => validateTasks([task('a', ['x'], ['b']), task('b', ['y'], ['a'])])).toThrow(/cycle/)
    expect(() => validateTasks([task('a', ['x'], ['zz'])])).toThrow(/unknown/)
    expect(() => validateTasks([task('a', ['x']), task('a', ['y'])])).toThrow(/duplicate/)
  })
})

describe('worker signals and prompt', () => {
  it('parses a decision gate and an escalation; ordinary output is no signal', () => {
    expect(parseWorkerSignal('done\nDECISION_GATE: {"question": "Drop column?", "options": ["yes", "no"]}')).toEqual({ kind: 'gate', question: 'Drop column?', options: ['yes', 'no'] })
    expect(parseWorkerSignal('ESCALATE: tests need a database')).toEqual({ kind: 'escalate', reason: 'tests need a database' })
    expect(parseWorkerSignal('All done, tests pass')).toBeNull()
    expect(parseWorkerSignal('DECISION_GATE: {broken')).toBeNull()
  })

  it('the prompt carries every brief field, the effort budget and the lease', () => {
    const [t] = validateTasks([task('a', ['src/a/**'])])
    const p = renderBrief({ ...t, decision: 'use option B' })
    for (const s of ['Objective: Do it', 'Output format:', 'Tools: Read, Edit', 'Boundaries: no network', 'src/a/**', '3-10 tool calls', '`npm test`', 'Next action', 'use option B', 'DECISION_GATE:', 'ESCALATE:']) expect(p).toContain(s)
  })
})
