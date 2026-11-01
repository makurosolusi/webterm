// Control API headless (P1). Murni: tidak menyentuh `IncomingMessage`/`ServerResponse`, tidak
// mengimpor `Bun`, dan semua efek samping lewat `deps` (sesi, capability, settings). Integrasi di
// `api.ts` cukup memanggil `handleControl(req, deps)` dan meneruskan hasilnya.
//
// SATU JALUR EXEC: `spawn` memanggil `sessions.open` yang sama dengan WebSocket `open`, sehingga
// tidak ada jalur PTY kedua. `cmd` TIDAK pernah diterima dari body — hanya dari
// `settings.agentLaunchCommands[agentId]` lewat `assembleCmd`.
//
// Router only: the handlers live in sibling modules (`controlApiSessions.ts`,
// `controlApiQuery.ts`) and the replay window in `controlApiStore.ts`.
import { CONTROL_PREFIX, type ControlDeps, type ControlRequest, type ControlResult } from './controlTypes'
import { nodesRoute, planRoute, tokenRoute } from './controlApiQuery'
import { closeRoute, promptRoute, spawnRoute } from './controlApiSessions'
import { storeFor } from './controlApiStore'
import { waitRoute } from './controlWait'

/**
 * Router keluarga `/api/control/*`. `null` untuk path/method yang bukan miliknya (pemanggil lalu
 * menjatuhkannya ke 404), sehingga integrasi tidak perlu tahu daftar route.
 */
export async function handleControl(req: ControlRequest, deps: ControlDeps): Promise<ControlResult> {
  if (req.path !== CONTROL_PREFIX && !req.path.startsWith(`${CONTROL_PREFIX}/`)) return null
  const method = req.method.toUpperCase()
  const now = (deps.now ?? Date.now)()
  const acks = storeFor(deps)
  const path = req.path

  if (method === 'POST' && path === `${CONTROL_PREFIX}/spawn`) return spawnRoute(req, deps, acks, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/prompt`) return promptRoute(req, deps, acks, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/wait`) return waitRoute(req, deps, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/close`) return closeRoute(req, deps, acks, now)
  if (method === 'GET' && path === `${CONTROL_PREFIX}/nodes`) return nodesRoute(req, deps, now)
  if (method === 'GET' && path === `${CONTROL_PREFIX}/plan`) return planRoute(req, deps, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/token`) return tokenRoute(req, deps)
  return null
}
