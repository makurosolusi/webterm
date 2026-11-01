// Peran agent P3 (RND/03-RENCANA.md §8): central 0, orchestrator 1, worker 2.
// Depth adalah satu-satunya sumber otoritas spawn; role hanya harus konsisten dengan depth.
// Semua fungsi murni supaya bisa dipakai orkestrator, API, dan test tanpa SQLite.

export type AgentRole = 'central' | 'orchestrator' | 'worker'

/** Depth tetap per role; schema `agent.depth` memakai CHECK 0..2. */
export const ROLE_DEPTH: Readonly<Record<AgentRole, number>> = Object.freeze({
  central: 0,
  orchestrator: 1,
  worker: 2,
})

/** Depth anak terjauh yang boleh dibuat (worker tidak punya anak). */
export const MAX_SPAWN_DEPTH = 2

export type RoleDenyCode =
  | 'unknown_role'
  | 'role_depth_mismatch'
  | 'worker_cannot_spawn'
  | 'max_depth'
  | 'project_mismatch'

export class RoleError extends Error {
  constructor(readonly code: RoleDenyCode, message: string) {
    super(message)
    this.name = 'RoleError'
  }
}

export function isAgentRole(value: unknown): value is AgentRole {
  return value === 'central' || value === 'orchestrator' || value === 'worker'
}

export function depthForRole(role: AgentRole): number {
  if (!isAgentRole(role)) {
    throw new RoleError('unknown_role', `unknown agent role: ${String(role)}`)
  }
  return ROLE_DEPTH[role]
}

/** Role yang sah untuk sebuah depth; dipakai saat spawn anak. */
export function roleForDepth(depth: number): AgentRole {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_SPAWN_DEPTH) {
    throw new RoleError(
      'max_depth',
      `depth must be an integer in 0..${MAX_SPAWN_DEPTH}, got ${String(depth)}`
    )
  }
  const role = (Object.keys(ROLE_DEPTH) as AgentRole[]).find((r) => ROLE_DEPTH[r] === depth)
  // ROLE_DEPTH covers 0..2 contiguously; a miss means the table was edited wrongly.
  if (!role) throw new RoleError('role_depth_mismatch', `no role defined for depth ${depth}`)
  return role
}

/** Pastikan pasangan role/depth yang dibaca dari DB tidak saling bertentangan. */
export function assertRoleDepth(role: AgentRole, depth: number): void {
  const expected = depthForRole(role)
  if (expected !== depth) {
    throw new RoleError(
      'role_depth_mismatch',
      `role ${role} has depth ${expected}, got ${String(depth)}`
    )
  }
}

export interface SpawnTarget {
  role: AgentRole
  depth: number
}

/**
 * Satu-satunya gerbang spawn: depth induk + 1, worker dilarang, depth 3 dilarang.
 * Urutan cek penting: worker ditolak sebagai `worker_cannot_spawn`, bukan sekadar max_depth.
 */
export function assertCanSpawn(parentRole: AgentRole, parentDepth: number): SpawnTarget {
  assertRoleDepth(parentRole, parentDepth)
  if (parentRole === 'worker') {
    throw new RoleError(
      'worker_cannot_spawn',
      `worker (depth ${parentDepth}) cannot spawn: only central and orchestrator may spawn`
    )
  }
  const depth = parentDepth + 1
  if (depth > MAX_SPAWN_DEPTH) {
    throw new RoleError(
      'max_depth',
      `spawn would create depth ${depth}; maximum is ${MAX_SPAWN_DEPTH}`
    )
  }
  return { role: roleForDepth(depth), depth }
}

export interface ProjectOwned {
  projectId: string
}

/** True bila agent benar-benar milik project; dipakai sebagai guard sebelum mutasi. */
export function ownsProject(projectId: string, agent: ProjectOwned | null | undefined): boolean {
  return typeof projectId === 'string' && projectId !== '' && agent?.projectId === projectId
}

export function assertProjectOwnership(
  projectId: string,
  agent: (ProjectOwned & { id?: string }) | null | undefined
): void {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new RoleError('project_mismatch', 'projectId must be a non-empty string')
  }
  if (!agent) {
    throw new RoleError('project_mismatch', `agent not found for project ${projectId}`)
  }
  if (!ownsProject(projectId, agent)) {
    throw new RoleError(
      'project_mismatch',
      `agent ${agent.id ?? '<unknown>'} belongs to project ${agent.projectId}, not ${projectId}`
    )
  }
}
