// Replay window for `/api/control/*`: one ack store per `deps` object, so two servers/tests alive at
// the same time never share a requestId replay window. Split out of `controlApi.ts`.
import { AckStore, type ControlDeps } from './controlTypes'

const stores = new WeakMap<ControlDeps, AckStore>()

/** Satu ack store per objek `deps`. `deps` produksi stabil (lihat `mount.ts`), jadi WeakMap ini
 *  tidak membuat store baru tiap request. */
export const storeFor = (deps: ControlDeps): AckStore => {
  let store = stores.get(deps)
  if (!store) {
    store = new AckStore()
    stores.set(deps, store)
  }
  return store
}
