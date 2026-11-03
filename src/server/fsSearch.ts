// STUB(WS-FM-09): `search` (Quick Open: rg -> git -> Glob). Dikunci flag QUICK_OPEN; stub = kosong.
import type { FsResult } from '../shared/fsContract'

export async function searchFiles(_root: string, _q: string, _limit?: number): Promise<FsResult<{ files: string[]; truncated: boolean }>> {
  return { ok: true, files: [], truncated: false }
}
