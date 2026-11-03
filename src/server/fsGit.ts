// STUB(WS-FM-08): `git-status` (porcelain v2 -z). Dikunci flag GIT_STATUS; stub = tanpa mark.
import type { FsResult, GitMark } from '../shared/fsContract'

export async function gitMarks(_dir: string): Promise<FsResult<{ marks: Record<string, GitMark> }>> {
  return { ok: true, marks: {} }
}
