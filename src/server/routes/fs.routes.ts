// Filesystem verbs (/api/fs/<verb>) and secrets-guard hygiene findings.
import { fsApiRoute, type FsApiResult } from '../fsApi'
import { hygieneRoute } from '../repoHygiene'
import { readErrorResult } from '../fsOps'
import { BodyReadError } from '../cappedRequestBody'
import { FS_BODY_MAX } from '../../shared/fsLimits'
import { fsFail } from '../../shared/fsContract'
import { sendRaw } from '../fsRaw'
import { send, type ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

/** Galat dispatcher fs -> respons: body kebesaran 413 ETOOLARGE, stream putus 400, sisanya galat baca. */
function fsErrorResult(err: unknown): NonNullable<FsApiResult> {
  if (!(err instanceof BodyReadError)) return readErrorResult(err)
  return err.reason === 'too_large'
    ? { status: 413, body: fsFail('ETOOLARGE', 'request body too large') }
    : { status: 400, body: fsFail('EINVAL', 'request body unreadable') }
}

export const fsRoutes: ApiRoute[] = [
  // Dispatcher fsApi.ts; null untuk path lain, termasuk folder picker /api/fs (misc.routes). Body
  // dibatasi FS_BODY_MAX dan dibaca sebagai Buffer (bukan `data += chunk`, yang membelah multibyte
  // antar-chunk). `read`/`read-binary` melempar bila file tak terbaca: 200 + body kosong terbaca
  // sebagai file KOSONG dan editor menimpanya saat Save.
  // UI-only (route.uiOnly.ts): no plain curl / agent shell reads or writes the user's files.
  uiOnly({
    name: 'fs-verbs',
    match: (c) => c.path.startsWith('/api/fs/'),
    handle: async (c) => {
      const fsRes = await fsApiRoute(c.path, c.method, c.url.searchParams, c.body(FS_BODY_MAX), { headers: c.req.headers, stream: c.req })
        .catch(fsErrorResult)
      if (fsRes?.raw) { await sendRaw(c.res, fsRes.raw); return true }
      return send(c.res, fsRes)
    },
  }),
  { name: 'hygiene', handle: (c) => send(c.res, hygieneRoute(c.path, c.method)) }, // repoHygiene.ts
]
