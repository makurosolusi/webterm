// Telegram hot-apply (ES-07): runtime kanal + poller dibangun saat kemampuan `telegram` on dan
// dihentikan saat off, tanpa restart server. Token yang diisi saat server jalan cukup memanggil
// `refresh()`. Route HTTP didelegasikan, jadi pemanggil (index.ts) memegang satu objek yang selalu ada.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { onCapabilityChange } from '../featureCapabilities.runtime'
import type { Ledger } from '../ledger/ledger'
import { startChannelsRuntime } from './channelsRuntime'
import type { ChannelsRuntime, ChannelsRuntimeOptions } from './channelsRuntime.types'
import { startTelegramInbound } from './telegramPollWiring'
import type { TelegramPoller } from './telegramPoll'

export interface TelegramHotInput {
  /** Dibaca saat start; ledger selalu hidup (KE-1) tapi boleh belum siap saat boot. */
  ledger: () => Ledger | undefined
  options?: ChannelsRuntimeOptions
}

export interface TelegramHot {
  /** Runtime yang sedang hidup, atau null bila kemampuan off / gagal start. */
  readonly channels: ChannelsRuntime | null
  /** Bangun runtime + poller bila kemampuan on. Idempoten. */
  start(): Promise<void>
  /** Hentikan poller + egress. Idempoten; aman dipanggil sebelum start. */
  stop(): Promise<void>
  /** Stop lalu start: ambil token/konfigurasi baru tanpa restart. */
  refresh(): Promise<void>
  handle(req: IncomingMessage, res: ServerResponse): boolean
  handleApi(req: IncomingMessage, res: ServerResponse): boolean
}

/** Pengendali hot Telegram; start/stop/refresh diserialkan supaya tak pernah ada dua poller. */
export function createTelegramHot(input: TelegramHotInput): TelegramHot {
  let channels: ChannelsRuntime | null = null
  let poller: TelegramPoller | null = null
  let chain: Promise<void> = Promise.resolve()
  const serial = (job: () => Promise<void>): Promise<void> => {
    const run = chain.then(job)
    chain = run.catch(() => undefined) // galat sebuah job tak boleh memblok job berikutnya
    return run
  }

  const doStart = async (): Promise<void> => {
    if (channels) return
    const built = startChannelsRuntime(input.ledger(), input.options)
    if (!built) return
    channels = built
    // Poll hanya bila mode poll; webhook tak butuh poller. Tanpa token startTelegramInbound memberi null.
    if (built.mode === 'poll') poller = startTelegramInbound({ channels: built, env: input.options?.env })
  }
  const doStop = async (): Promise<void> => {
    const [current, running] = [channels, poller]
    channels = null
    poller = null
    current?.stop()
    await running?.stop()
  }

  return {
    get channels() { return channels },
    start: () => serial(doStart),
    stop: () => serial(doStop),
    refresh: () => serial(async () => { await doStop(); await doStart() }),
    handle: (req, res) => channels?.handle(req, res) ?? false,
    handleApi: (req, res) => channels?.handleApi(req, res) ?? false,
  }
}

/** Pasang hook kemampuan `telegram`; mengembalikan fungsi pembatal (dipakai tes). */
export function registerTelegramHot(hot: TelegramHot): () => void {
  return onCapabilityChange('telegram', { start: () => hot.start(), stop: () => hot.stop() })
}
