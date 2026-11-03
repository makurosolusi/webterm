// STUB(WS-FM-07): hub watcher direktori. index.ts memanggil `watch`/`unwatch` untuk pesan ws
// fswatch/fsunwatch (hanya bila flag WATCH on) dan `dropClient` saat ws tutup. No-op sampai WS-07.
import type { ServerMsg } from '../shared/protocol'

export type FsDirtySend = (m: ServerMsg) => void

export const fsWatchHub = {
  watch(_send: FsDirtySend, _dir: string): void {},
  unwatch(_send: FsDirtySend, _dir: string): void {},
  dropClient(_send: FsDirtySend): void {},
}
