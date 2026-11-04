import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { validPlanData } from '../shared/workspace'
import { estimateText, removeTask, workerWiring, type DagView } from './PlanNode.model'

// test-only fixtures
const task = (key: string, deps: string[] = [], kind: 'work' | 'gate' = 'work') => ({ key, kind, deps, brief: { objective: key } })
const view = (dispatches: DagView['dispatches']): DagView => ({
  dag: { id: 'd1', title: 'Login', status: 'active' },
  tasks: [
    { ...task('api'), id: 't-api', status: 'done', lastError: null },
    { ...task('ask', ['api'], 'gate'), id: 't-ask', status: 'done', lastError: null },
    { ...task('ui', ['api', 'ask']), id: 't-ui', status: 'running', lastError: null },
  ],
  gates: [], dispatches, waves: [['api'], ['ask'], ['ui']],
  estimate: { medianMicros: null, samples: 0, basis: 'none', tasks: 2, totalMicros: null },
})
const dispatch = (id: string, taskId: string) => ({ id, taskId, nodeId: `dag-${id}`, worktree: `/wt/${id}`, branch: 'b', status: 'running' })
const plan = { id: 'plan1', position: { x: 0, y: 0 }, width: 600 }

describe('Plan node model', () => {
  it('removing a task drops it from every dependency list', () => {
    expect(removeTask([task('a'), task('b', ['a']), task('c', ['a', 'b'])], 'a')).toEqual([task('b'), task('c', ['b'])])
  })

  it('estimate text: unknown without history, total and median with it', () => {
    expect(estimateText({ medianMicros: null, samples: 0, basis: 'none', tasks: 2, totalMicros: null })).toBe('Estimate: unknown, no cost history yet (2 agent runs)')
    expect(estimateText({ medianMicros: 500_000, samples: 4, basis: 'kind', tasks: 3, totalMicros: 1_500_000 })).toBe('Estimate: ~$1.50 (3 agent runs × $0.50, median of 4 past runs)')
  })

  it('wires one Diff worker per dispatched task: plan -> root task, dep worker -> dependent, gate deps from the plan', () => {
    const first = workerWiring(plan, view([dispatch('x1', 't-api')]), [{ id: 'plan1' }], [], [])
    expect(first.nodes).toHaveLength(1)
    expect(first.nodes[0]).toMatchObject({ id: 'dag-x1', type: 'diff', data: { cwd: '/wt/x1', title: 'Login: api' } })
    expect(first.nodes[0].position.x).toBeGreaterThan(600)
    expect(first.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['plan1>dag-x1'])
    expect(first.wired).toEqual(['x1'])

    const nodes = [{ id: 'plan1' }, { id: 'dag-x1' }]
    const second = workerWiring(plan, view([dispatch('x1', 't-api'), dispatch('x2', 't-ui')]), nodes, first.edges as Edge[], first.wired)
    expect(second.nodes.map((n) => n.id)).toEqual(['dag-x2'])
    expect(second.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(['dag-x1>dag-x2', 'plan1>dag-x2'])
    expect(second.wired).toEqual(['x2'])
  })

  it('a worker the user closed is not added again', () => {
    expect(workerWiring(plan, view([dispatch('x1', 't-api')]), [{ id: 'plan1' }], [], ['x1']).nodes).toEqual([])
  })

  it('persisted plan data keeps known fields and rejects junk', () => {
    expect(validPlanData({ intent: 'x', dagId: 'd', wired: ['a', 3], extra: 1 })).toEqual({ intent: 'x', dagId: 'd', wired: ['a'] })
    expect(validPlanData({ dagId: 'd' })).toBeUndefined()
    expect(validPlanData({ intent: 'x'.repeat(600_000) })).toBeUndefined()
  })
})
