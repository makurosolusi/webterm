// `/api/fs/grep` + `/api/fs/grep-cancel`, shaped like the `VERBS` entries of fsApi.ts so the
// dispatcher mounts them with one spread (`...GREP_VERBS`) and keeps flag/argument enforcement.
// Gated by QUICK_OPEN: content search is the same surface as Quick Open (VS Code `%` quick search).
import type { FilesFlag } from './envRegistry.files'
import { cancelGrep, grepFiles } from './fsGrep'

interface GrepVerb {
  m: 'GET' | 'POST'
  flag?: FilesFlag
  need: string[]
  run(a: Record<string, string>, b: Record<string, unknown>, c: unknown, q: URLSearchParams): Promise<unknown>
}

const num = (v: string | null): number | undefined => (v === null || v === '' ? undefined : Number(v))

export const GREP_VERBS: Record<string, GrepVerb> = {
  grep: {
    m: 'GET', flag: 'QUICK_OPEN', need: ['root', 'q'],
    run: (a, _b, _c, q) => grepFiles(a.root, a.q, { offset: num(q.get('offset')), limit: num(q.get('limit')), searchId: q.get('searchId') ?? undefined }),
  },
  'grep-cancel': {
    m: 'POST', flag: 'QUICK_OPEN', need: ['searchId'],
    run: async (a) => ({ ok: true, cancelled: cancelGrep(a.searchId) }),
  },
}
