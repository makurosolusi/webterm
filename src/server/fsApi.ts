// Dispatcher tipis `/api/fs/<verb>` (kontrak: PLAN/FILEMANAGER-b.md §5.2). Tabel `VERBS` memuat
// metode, flag, argumen wajib, dan handler; di sini hanya penegakan: flag mati -> 501 EDISABLED
// (SEBELUM body dibaca), argumen wajib, dan FsFail -> status (`FS_ERR_STATUS`). Logika fitur ada
// di modul handler bernama-tetap. Otorisasi di index.ts; `/api/fs` persis = folder picker di api.ts.
import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import { basename } from 'node:path'
import { FS_ERR_STATUS, fsFail, type FsErrCode } from '../shared/fsContract'
import { filesFlagOn, filesListMax, filesUploadMaxBytes, type FilesFlag } from './envRegistry.files'
import { listDir, listDirV2, pathExists, readBinary, readTextMeta, statMeta } from './fsOps'
import { copyEntry, deleteEntry, renameEntry, restoreEntry } from './fsOps.mutate'
import { createFileExclusive, makeDirChecked, writeFileChecked } from './fsOps.write'
import { gitMarks } from './fsGit'
import { serveRaw, type RawReply } from './fsRaw'
import { searchFiles } from './fsSearch'
import { GREP_VERBS } from './fsGrep.route'
import { uploadFile } from './fsUpload'
import { createLogger } from './logs'

const log = createLogger('fs')

/** Status + body JSON (atau `raw` untuk bytes), atau `null` bila path bukan milik modul ini. */
export type FsApiResult = { status: number; body?: unknown; raw?: RawReply } | null
/** Konteks request mentah untuk verb yang butuh header (raw) atau stream (upload). */
export interface FsCtx { headers: IncomingHttpHeaders; stream?: Readable }

type Args = Record<string, string>
type Body = Record<string, unknown>
interface Verb {
  m: 'GET' | 'POST'
  flag?: FilesFlag
  /** Argumen string wajib (non-kosong): query untuk GET, body JSON (lalu query) untuk POST. */
  need?: string[]
  /** false = jangan baca body JSON (stream upload). */
  body?: boolean
  run(a: Args, b: Body, c: FsCtx, q: URLSearchParams): Promise<unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const VERBS: Record<string, Verb> = {
  list: { m: 'GET', need: ['path'], run: (a) => listDir(a.path) },
  'list-v2': { m: 'GET', need: ['path'], run: (a, _b, _c, q) => listDirV2(a.path, Math.min(Number(q.get('limit')) || filesListMax(), filesListMax())) },
  read: {
    m: 'GET', need: ['path'],
    async run(a) {
      const meta = await readTextMeta(a.path)
      log.debug('fs.read', 'Read file', { file: basename(a.path), chars: meta.content.length })
      return { ok: true, ...meta }
    },
  },
  'read-binary': {
    m: 'GET', need: ['path'],
    async run(a) {
      const base64 = await readBinary(a.path)
      log.debug('fs.read', 'Read binary file', { file: basename(a.path), base64Chars: base64.length })
      return { base64 }
    },
  },
  exists: { m: 'GET', need: ['path'], run: async (a) => ({ exists: await pathExists(a.path) }) },
  stat: { m: 'GET', need: ['path'], run: (a) => statMeta(a.path) },
  create: {
    m: 'POST', need: ['path'],
    run: async (a, b) => (b.content !== undefined && typeof b.content !== 'string' ? fsFail('EINVAL', 'content must be a string') : createFileExclusive(a.path, str(b.content))),
  },
  write: {
    m: 'POST', need: ['path'],
    async run(a, b) {
      // Konten WAJIB string: `fs.writeFile` menerima objek ber-`toString`, jadi body salah bentuk
      // akan menulis "[object Object]" ke file pengguna, bukan gagal.
      if (typeof b.content !== 'string') return fsFail('EINVAL', 'content must be a string')
      const r = await writeFileChecked(a.path, b.content, { expectedVersion: str(b.expectedVersion), mustExist: b.mustExist === true })
      log.debug('fs.write', r.ok ? 'Wrote file' : 'Write file failed', { file: basename(a.path), chars: b.content.length, ok: r.ok })
      return r
    },
  },
  mkdir: {
    m: 'POST', need: ['path'],
    async run(a) {
      const r = await makeDirChecked(a.path)
      log.debug('fs.mkdir', r.ok ? 'Created directory' : 'Create directory failed', { file: basename(a.path), ok: r.ok })
      return r
    },
  },
  delete: { m: 'POST', flag: 'MUTATE', need: ['path'], run: (a, b) => deleteEntry(a.path, { permanent: b.permanent === true }) },
  restore: { m: 'POST', flag: 'MUTATE', need: ['trashId'], run: (a) => restoreEntry(a.trashId) },
  rename: { m: 'POST', flag: 'MUTATE', need: ['from', 'to'], run: (a, b) => renameEntry(a.from, a.to, { overwrite: b.overwrite === true }) },
  copy: { m: 'POST', flag: 'MUTATE', need: ['from', 'to'], run: (a) => copyEntry(a.from, a.to) },
  raw: {
    m: 'GET', flag: 'VIEWERS', need: ['path'],
    run: async (a, _b, c, q) => { const r = await serveRaw(a.path, c.headers, { download: q.get('download') === '1' }); return 'status' in r ? { raw: r } : r },
  },
  'git-status': { m: 'GET', flag: 'GIT_STATUS', need: ['path'], run: (a) => gitMarks(a.path) },
  search: { m: 'GET', flag: 'QUICK_OPEN', need: ['root', 'q'], run: (a, _b, _c, q) => searchFiles(a.root, a.q, Number(q.get('limit')) || undefined) },
  // Find in Files (`grep`, `grep-cancel`): handlers + rationale in fsGrep.ts / fsGrep.route.ts.
  ...GREP_VERBS,
  upload: { m: 'POST', flag: 'UPLOAD', need: ['dir', 'name'], body: false, run: (a, _b, c, q) => uploadFile(a.dir, a.name, c.stream, filesUploadMaxBytes(), q.get('overwrite') === '1') },
  capabilities: {
    m: 'GET',
    run: async () => ({ ok: true, mutate: filesFlagOn('MUTATE'), viewers: filesFlagOn('VIEWERS'), watch: filesFlagOn('WATCH'),
      git: filesFlagOn('GIT_STATUS'), quickOpen: filesFlagOn('QUICK_OPEN'), upload: filesFlagOn('UPLOAD'), listMax: filesListMax() }),
  },
}

/** `[verb, method]` of every `/api/fs/<verb>` (the UI-only policy test probes each). */
export const FS_VERB_METHODS: readonly (readonly [string, string])[] = Object.entries(VERBS).map(([name, v]) => [name, v.m])

function reply(code: FsErrCode, error: string): FsApiResult {
  return { status: FS_ERR_STATUS[code], body: fsFail(code, error) }
}

function parseBody(raw: string): Body | null {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : null
  } catch {
    return null // body bukan JSON: 400, bukan crash
  }
}

/**
 * Rute satu request `/api/fs/<verb>`; `null` untuk path lain supaya pemanggil jatuh ke rutenya.
 * `body` adalah getter, bukan string: membaca stream request GET akan menggantung sampai timeout.
 */
export async function fsApiRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  body: () => Promise<string>,
  ctx: FsCtx = { headers: {} }
): Promise<FsApiResult> {
  if (!path.startsWith('/api/fs/')) return null
  const name = path.slice('/api/fs/'.length)
  const verb = Object.hasOwn(VERBS, name) ? VERBS[name] : undefined
  if (!verb || verb.m !== method) return reply('ENOENT', 'unknown fs route')
  if (verb.flag && !filesFlagOn(verb.flag)) return reply('EDISABLED', `fs ${name} disabled`)

  let b: Body = {}
  if (verb.m === 'POST' && verb.body !== false) {
    const parsed = parseBody(await body())
    if (!parsed) return reply('EINVAL', 'bad json')
    b = parsed
  }
  const a: Args = {}
  for (const k of verb.need ?? []) {
    const v = str(b[k]) ?? params.get(k)
    if (!v || v.trim() === '') return reply('EINVAL', `${k} required`)
    a[k] = v
  }
  const out = await verb.run(a, b, ctx, params)
  if (out && typeof out === 'object' && 'raw' in out) return { status: (out.raw as RawReply).status, raw: out.raw as RawReply }
  const code = out && typeof out === 'object' && 'ok' in out && out.ok === false && 'code' in out ? (out.code as FsErrCode) : undefined
  return { status: code ? FS_ERR_STATUS[code] : 200, body: out }
}
