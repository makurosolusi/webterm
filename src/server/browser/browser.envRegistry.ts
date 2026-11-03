// Definisi env fitur Browser Canvas untuk registry Pengaturan (data murni; lihat envRegistry.types.ts).
// Nama kunci & default berasal dari `browser.contract.ts`. SEMUA fitur mati secara default: tanpa
// `WEBTERM_BROWSER=on` tidak ada proses Chromium, proxy, rute, maupun jalur `/ws/browser`.
import { DEFAULT_COOKIE_TTL_DAYS, DEFAULT_DISCARD_MS, DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../../shared/browser.contract'
import { flag, num, text, type EnvSpec } from '../envRegistry.types'

const GROUP = 'browser'
const DISCARD_MS_MAX = 86_400_000 // 24 jam
const COOKIE_TTL_DAYS_MAX = 365

export const BROWSER_ENV_SPECS: readonly EnvSpec[] = [
  flag(ENV_BROWSER.enabled, GROUP, {
    label: 'Node Browser',
    description: 'Mengaktifkan node Browser di kanvas (Chromium di server, ditampilkan sebagai stream). Mati = tidak ada proses browser, proxy, maupun rute.',
    dangerous: true,
  }),
  text(ENV_BROWSER.bin, GROUP, {
    label: 'Path biner Chromium',
    description: 'Path absolut Chromium/Chrome. Kosong = cari otomatis di lokasi umum.',
    dangerous: true,
  }, { absolutePath: true }),
  num(ENV_BROWSER.maxLive, GROUP, MAX_LIVE_RANGE.min, MAX_LIVE_RANGE.max, DEFAULT_MAX_LIVE, {
    label: 'Batas tab live',
    description: 'Jumlah node Browser yang boleh aktif bersamaan; yang tersembunyi tertua dijeda lalu dibuang.',
  }),
  num(ENV_BROWSER.discardMs, GROUP, 0, DISCARD_MS_MAX, DEFAULT_DISCARD_MS, {
    label: 'Jeda buang tab (ms)',
    description: 'Berapa lama node Browser tersembunyi sebelum halamannya dibuang untuk menghemat memori.',
  }),
  flag(ENV_BROWSER.agent, GROUP, {
    label: 'Kendali agent',
    description: 'Mengizinkan agent terminal mengemudikan node Browser (hanya node yang toggle-nya dinyalakan manusia). Konten halaman tidak tepercaya.',
    dangerous: true,
  }),
  text(ENV_BROWSER.allowHosts, GROUP, {
    label: 'Host privat yang diizinkan',
    description: 'Daftar host:port (dipisah koma) yang boleh dibuka walau jaringan privat/localhost. Kosong = semua jaringan privat diblokir.',
    dangerous: true,
  }),
  flag(ENV_BROWSER.cookieImport, GROUP, {
    label: 'Impor cookie',
    description: 'Mengizinkan mengimpor cookie dari berkas ke profil browser workspace (disimpan terenkripsi). Nilai cookie tidak pernah ditampilkan.',
    dangerous: true,
  }),
  num(ENV_BROWSER.cookieTtlDays, GROUP, 1, COOKIE_TTL_DAYS_MAX, DEFAULT_COOKIE_TTL_DAYS, {
    label: 'Umur cookie tersimpan (hari)',
    description: 'Cookie di vault dibuang otomatis setelah sekian hari sejak diimpor.',
  }),
]
