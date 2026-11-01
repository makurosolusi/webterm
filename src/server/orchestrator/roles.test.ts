import { describe, expect, it } from 'vitest'
import {
  MAX_SPAWN_DEPTH,
  ROLE_DEPTH,
  RoleError,
  assertCanSpawn,
  assertProjectOwnership,
  assertRoleDepth,
  depthForRole,
  isAgentRole,
  ownsProject,
  roleForDepth,
} from './roles'

function expectCode(fn: () => void, code: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RoleError)
    expect((err as RoleError).code).toBe(code)
    return
  }
  throw new Error(`expected RoleError ${code}, nothing thrown`)
}

describe('role depths', () => {
  it('maps the three roles to depths 0..2 and back', () => {
    expect(ROLE_DEPTH).toEqual({ central: 0, orchestrator: 1, worker: 2 })
    expect(depthForRole('central')).toBe(0)
    expect(depthForRole('orchestrator')).toBe(1)
    expect(depthForRole('worker')).toBe(2)
    expect(roleForDepth(0)).toBe('central')
    expect(roleForDepth(1)).toBe('orchestrator')
    expect(roleForDepth(2)).toBe('worker')
  })

  it('rejects unknown roles and out-of-range depths', () => {
    expect(isAgentRole('worker')).toBe(true)
    expect(isAgentRole('lead')).toBe(false)
    expectCode(() => depthForRole('lead' as never), 'unknown_role')
    expectCode(() => roleForDepth(MAX_SPAWN_DEPTH + 1), 'max_depth')
    expectCode(() => roleForDepth(-1), 'max_depth')
  })

  it('rejects a role/depth pair that contradicts the table', () => {
    expectCode(() => assertRoleDepth('worker', 1), 'role_depth_mismatch')
    expectCode(() => assertRoleDepth('central', 2), 'role_depth_mismatch')
  })
})

describe('assertCanSpawn', () => {
  it('central spawns exactly orchestrator depth 1', () => {
    expect(assertCanSpawn('central', 0)).toEqual({ role: 'orchestrator', depth: 1 })
  })

  it('orchestrator spawns exactly worker depth 2', () => {
    expect(assertCanSpawn('orchestrator', 1)).toEqual({ role: 'worker', depth: 2 })
  })

  it('a worker can never spawn', () => {
    expectCode(() => assertCanSpawn('worker', 2), 'worker_cannot_spawn')
  })

  it('a corrupt role/depth pair is rejected before the depth math', () => {
    expectCode(() => assertCanSpawn('worker', 1), 'role_depth_mismatch')
  })

  it('never grants depth 3', () => {
    expectCode(() => assertCanSpawn('orchestrator', 2), 'role_depth_mismatch')
    // A depth-3 parent is not even representable; the role/depth check stops it first.
    expectCode(() => assertCanSpawn('central', 3 as never), 'role_depth_mismatch')
    expectCode(() => assertCanSpawn('worker', 3 as never), 'role_depth_mismatch')
  })
})

describe('project ownership', () => {
  const agent = { id: 'a1', projectId: 'p1' }

  it('accepts the owning project only', () => {
    expect(ownsProject('p1', agent)).toBe(true)
    expect(ownsProject('p2', agent)).toBe(false)
    expect(ownsProject('p1', null)).toBe(false)
    expect(() => assertProjectOwnership('p1', agent)).not.toThrow()
  })

  it('rejects cross-project agents with a typed error', () => {
    expectCode(() => assertProjectOwnership('p2', agent), 'project_mismatch')
    expectCode(() => assertProjectOwnership('p1', null), 'project_mismatch')
    expectCode(() => assertProjectOwnership('', agent), 'project_mismatch')
  })
})
