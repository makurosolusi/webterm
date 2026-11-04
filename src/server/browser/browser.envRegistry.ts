// Definisi env fitur Browser Canvas untuk registry Pengaturan (data murni; lihat envRegistry.types.ts).
// Nama kunci & default berasal dari `browser.contract.ts`. SEMUA fitur mati tanpa
// `WEBTERM_BROWSER=on` (impor cookie menyala otomatis bersama browser): tidak ada proses Chromium, proxy, rute, maupun jalur `/ws/browser`.
import { DEFAULT_COOKIE_TTL_DAYS, DEFAULT_DISCARD_MS, DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../../shared/browser.contract'
import { flag, num, text, type EnvSpec } from '../envRegistry.types'

const GROUP = 'browser'
// Semua 'hot': runtime browser hidup-mati lewat hook kemampuan `browser` (browser.activate.ts), tanpa restart.
const B = { owner: 'platform', section: 'Browser', audience: 'advanced', restart: 'hot' } as const
const BROWSER_ON = { key: ENV_BROWSER.enabled }
const DISCARD_MS_MAX = 86_400_000 // 24 jam
const COOKIE_TTL_DAYS_MAX = 365

export const BROWSER_ENV_SPECS: readonly EnvSpec[] = [
  flag(ENV_BROWSER.enabled, GROUP, {
    ...B,
    audience: 'user',
    dangerNote: 'Menjalankan Chromium di server dan membuka web atas nama kamu; permukaan serangan baru bila halaman tidak tepercaya.',
    label: 'Node Browser',
    description: 'Mengaktifkan node Browser di kanvas (Chromium di server, ditampilkan sebagai stream). Mati = tidak ada proses browser, proxy, maupun rute.',
    dangerous: true,
  }),
  text(ENV_BROWSER.bin, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    allowEmpty: true,
    dangerNote: 'Path ini dijalankan sebagai proses di mesin server; isi hanya biner Chromium tepercaya.',
    label: 'Path biner Chromium',
    description: 'Path absolut Chromium/Chrome. Kosong = cari otomatis di lokasi umum.',
    dangerous: true,
  }, { absolutePath: true }),
  num(ENV_BROWSER.maxLive, GROUP, MAX_LIVE_RANGE.min, MAX_LIVE_RANGE.max, DEFAULT_MAX_LIVE, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Batas tab live',
    description: 'Jumlah node Browser yang boleh aktif bersamaan; yang tersembunyi tertua dijeda lalu dibuang.',
  }),
  num(ENV_BROWSER.discardMs, GROUP, 0, DISCARD_MS_MAX, DEFAULT_DISCARD_MS, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Jeda buang tab (ms)',
    description: 'Berapa lama node Browser tersembunyi sebelum halamannya dibuang untuk menghemat memori.',
  }),
  flag(ENV_BROWSER.agent, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    dangerNote: 'Agent terminal bisa mengemudikan browser (klik, ketik, navigasi) dengan sesi login yang ada; konten halaman tidak tepercaya.',
    label: 'Kendali agent',
    description: 'Mengizinkan agent terminal mengemudikan node Browser (hanya node yang toggle-nya dinyalakan manusia). Konten halaman tidak tepercaya.',
    dangerous: true,
  }),
  text(ENV_BROWSER.allowHosts, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    allowEmpty: true,
    dangerNote: 'Membuka jaringan privat/localhost ke browser server; halaman bisa menjangkau layanan internal.',
    label: 'Host privat yang diizinkan',
    description: 'Daftar host:port (dipisah koma) yang boleh dibuka walau jaringan privat/localhost. Diisi juga oleh tombol "Izinkan" di node Browser. ' +
      'Saat webterm hanya di loopback, localhost (selain port webterm) selalu boleh; jaringan privat lain tetap diblokir.',
    dangerous: true,
  }),
  flag(ENV_BROWSER.cookieImport, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    dangerNote: 'Cookie sesi login masuk ke vault server dan dipakai browser; hanya impor dari sumber yang kamu percaya.',
    label: 'Impor cookie',
    description: 'Mengizinkan mengimpor cookie dari berkas ke profil browser workspace (disimpan terenkripsi). Nilai cookie tidak pernah ditampilkan. Default menyala bersama browser; tiap impor tetap butuh pratinjau + konfirmasi.',
    dangerous: true,
  }, 'on'),
  num(ENV_BROWSER.cookieTtlDays, GROUP, 1, COOKIE_TTL_DAYS_MAX, DEFAULT_COOKIE_TTL_DAYS, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Umur cookie tersimpan (hari)',
    description: 'Cookie di vault dibuang otomatis setelah sekian hari sejak diimpor.',
  }),
  flag(ENV_BROWSER.headless, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Mode headless',
    description: 'Paksa Chromium headless. Default mati: jendela nyata di luar layar, agar situs tidak mencapnya bot. Linux tanpa display otomatis headless.',
  }),
]
