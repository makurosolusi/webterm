# CHENV-b: kontrak server, UI, glosarium, tes, risiko

Docs-only. Basis: `RND/54`, `RND/55`, kode `chore/envmin-int` (setelah env-minimal W0+W1). K1-K7 dipakai apa adanya. Peta WS dan kepemilikan file ada di `CHENV-a.md`; di sini hanya kontrak `KT-n` / `KU-n` / `GL-`. [V] = diverifikasi di kode, [BT] = belum, wajib dicek (§8).

## 0. Selisih terhadap RND/55

1. Hot-apply lebih dalam dari 55: sender terikat boot (`channelsRuntime.ts` L216, getter L227) dan poller dipanggil sekali di `index.ts` L62-72 [V]. Perlu sender late-bound + kontroler poller (KT-3).
2. Runtime `null` = rute tak terpasang = 404 tanpa alasan [V], jadi alasan butuh rute `/state` yang SELALU terpasang (KT-4); `/status` lama tak disentuh.
3. "Hapus token" tanpa endpoint baru: pakai `PUT /api/settings/env {unset}`; baru hanya hook sesudah update (KT-2).
4. Registry: `WEBTERM_CENTRAL_TELEGRAM.requires` melarang runtime `claude` [V]; deskripsi token masih Inggris. Diperbaiki di KT-5.

## 1. Konstanta bernama (Rule 15)

| Nama | Nilai | Letak |
|---|---|---|
| `CHANNEL_STATE_PATH` | `/api/channels/telegram/state` | `channelHealthHttp.ts` |
| `CHANNEL_TEST_PATH` | `/api/channels/telegram/test` | `channelTestHttp.ts` |
| `CHANNEL_TEST_TIMEOUT_MS` | `10_000` (pola `botManager.propose`) | `channelTest.ts` |
| `CHANNEL_TEST_MIN_INTERVAL_MS` | `3_000` | `channelTest.ts` |
| `CHANNEL_BOT_USERNAME_RE` | `/^[A-Za-z0-9_]{5,32}$/` | `channelTest.ts` |
| `CHANNEL_RECONCILE_KEYS` | `['WEBTERM_TELEGRAM_BOT_TOKEN']` (satu-satunya kunci `hot`) | `channelLifecycle.ts` |
| `CHANNEL_HEALTH_POLL_MS` | `5_000` (= `CHANNELS_POLL_MS`) | `useChannelHealth.ts` |
| `LEGACY_SECTION_IDS` | `{channels:'integrations', env:'server'}` | `SettingsPanel.tsx` |

## 2. Kontrak server (KT)

Tipe bersama di berkas baru `src/shared/channels.contract.ts` (<=80 baris):

```ts
export const CHANNEL_STATES = ['off','unconfigured','untested','connected','error'] as const
export const CHANNEL_REASONS = ['master_off','telegram_off','ledger_off','no_token','token_rejected',
  'webhook_secret_missing','poll_conflict','network','timeout','rate_limited'] as const
export type ChannelState = typeof CHANNEL_STATES[number]
export type ChannelReason = typeof CHANNEL_REASONS[number]
export interface ChannelHealth {
  state: ChannelState; reason: ChannelReason | null   // null untuk connected/untested/unconfigured
  since: number                                       // epoch ms transisi, in-memory
  mode: 'poll' | 'webhook' | null
  tokenSet: boolean; webhookSecretSet: boolean
  botUsername?: string                                // hanya dari tes sukses terakhir
  ingress: { lastOk?: number; okCount: number; errorCount: number }
  egress:  { lastOk?: number; okCount: number; errorCount: number }
}
export interface ChannelTestResult { ok: boolean; botUsername?: string; reason?: ChannelReason }
```

### KT-1 Tes koneksi
| Aspek | Kontrak |
|---|---|
| Rute | `POST /api/channels/telegram/test`, terpasang SELALU (di luar `startChannelsRuntime`), di balik gerbang `/api` yang ada |
| Body | kosong atau `{}`. Selain itu 400 `invalid_body`. Token TIDAK PERNAH dari klien |
| Aksi | server baca token lewat `resolveTelegramBotToken(process.env)`, panggil `callBotApi('getMe')` (reuse `telegramPollApi.ts`: redaksi `[token]`, batas 200 char) |
| Respons | `200 ChannelTestResult`. Sukses `{ok:true, botUsername}` (username divalidasi `CHANNEL_BOT_USERNAME_RE`, bila gagal dihilangkan). Gagal bisnis tetap 200 `{ok:false, reason}` |
| Peta `reason` | tanpa token `no_token`; 401/404 `token_rejected`; 429 `rate_limited`; abort `timeout`; selain itu `network`. Tak ada teks error mentah di respons |
| Status HTTP | 405 `method_not_allowed`; 413/400 body (pola `readJson`); `429 {error:'too_fast'}` bila < `CHANNEL_TEST_MIN_INTERVAL_MS` sejak tes lalu |
| Efek | simpan `lastTest {at, ok, reason}` in-memory; reset saat token berubah (KT-2/3); jadi masukan `deriveChannelHealth` |
| Rahasia | token tak masuk respons/log/error; log hanya `{ok, reason}` |

### KT-2 Hapus token
Tanpa rute baru: `PUT /api/settings/env {unset:['WEBTERM_TELEGRAM_BOT_TOKEN']}`. Service sudah `secrets.remove` + `apply()` [V `envSettings.service.ts` persist/update]. Tambahan:
- `EnvSettingsApiDeps.afterUpdate?(names: readonly string[]): void`, dipanggil setelah `update` sukses, HANYA nama kunci (tak ada nilai). Dipasang di `index.ts`; di dalamnya `lifecycle.reconcile()` bila ada nama di `CHANNEL_RECONCILE_KEYS`. Hook melempar: ditangkap + `log.warn('channels.reconcile_failed', {name})` tanpa nilai, update tetap 200 (Rule 11).
- Efek: sender berhenti menerima antrean baru dan `stopChannelSender`; poller `stop()`; `lastTest` direset; state -> `unconfigured`.
- Bila token juga ada di env/`.env` (`source` kembali `env`) atau lewat alias `TELEGRAM_BOT_TOKEN` [BT alias ikut `base`]: entri tetap `secretSet`, UI memberi tahu (KU-3). Sumber `env` tak bisa dihapus dari UI (`editable`/tak ada `override`).

### KT-3 Hot-apply poller + sender
Berkas baru `src/server/channels/channelLifecycle.ts` (<=150 baris):
```ts
export interface ChannelLifecycle { reconcile(): Promise<void>; stop(): Promise<void> }
export function createChannelLifecycle(d: { runtime: ChannelsRuntime|null; ledger: LedgerRuntime|null;
  env: NodeJS.ProcessEnv; start: typeof startTelegramInbound }): ChannelLifecycle
```
- `desired` = runtime != null && ledger != null && `resolveTelegramMode()==='poll'` && token ada. Hanya saat itu poller hidup; `reconcile()` idempoten (start bila belum jalan, stop bila tak diinginkan).
- Serialisasi: antrean promise internal; `start` menunggu `stop()` selesai (poller single-instance, `startTelegramPoller` melempar bila `active`) [V].
- `telegramPollWiring.ts`: `process.once('exit')` dipindah ke lifecycle (cegah listener menumpuk tiap start).
- `channelsRuntime.ts`: `sender` dari `const` jadi `let` dengan `ensureSender()` / `dropSender()` pada objek runtime (dipanggil lifecycle); getter `senderRunning` baca variabel terkini. `channelSenderBoot.ts` tak berubah kontrak (`startChannelSenderFor`, `stopChannelSender`).
- `index.ts` L62-72: pemanggilan sekali diganti `lifecycle.reconcile()` saat boot + `afterUpdate`; log `channels.start` tetap.
- Batas: bila runtime `null` (master/Telegram/ledger mati) reconcile = no-op; `WEBTERM_TELEGRAM`, master, mode tetap `restart:'boot'` (UI: `EnvRestartBanner`). Poller fatal (401/404) keluar sendiri; token baru -> start ulang. Mode webhook: hanya sender.
- Antrean sender saat token dihapus: [BT] outbox dipersist? Bila ya, tahan, jangan buang.

### KT-4 Status beralasan
Rute baru `GET /api/channels/telegram/state` (`channelHealthHttp.ts`), selalu terpasang, 200 `ChannelHealth`, `Cache-Control: no-store`, 405 untuk metode lain. Fungsi murni `deriveChannelHealth(input): ChannelHealth` di `channelHealth.ts` (<=120 baris), urutan gerbang:
1. master mati -> `off/master_off`; Telegram mati -> `off/telegram_off`; ledger tak hidup -> `off/ledger_off`.
2. tanpa token -> `unconfigured/no_token` (mode webhook tanpa secret -> `error/webhook_secret_missing`).
3. `lastTest` gagal, atau poller fatal -> `error/<reason>`; 409 -> `error/poll_conflict`.
4. `lastTest.ok` atau `ingress/egress.lastOk` setelah token terakhir diubah -> `connected`.
5. selain itu -> `untested`.
`since` = waktu transisi (in-memory server). Tak ada teks error di `/state`, hanya kode statis (Rule 12). Kompat: `/status` dan `PUT/GET` env tak berubah bentuk (klien lama jalan). Klien baru: `/state` 404 (server lama) -> `legacy`, kartu pakai `/status` tanpa alasan.

### KT-5 Registry (metadata saja, `KNOWN_KEYS_FROZEN` tidak berubah)
| Kunci | Perubahan |
|---|---|
| `WEBTERM_CHANNELS` | `audience:'advanced'` (K1) |
| `WEBTERM_TELEGRAM` | tetap `user` (saklar di kartu) |
| `WEBTERM_TELEGRAM_MODE` | `advanced`; deskripsi otomatis (poll bila ada token) |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | `restart:'hot'` dipertahankan; deskripsi baru: "Tidak pernah ditampilkan lagi. Berlaku langsung." (<=160) |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | tetap `advanced` (K5) |
| `WEBTERM_CENTRAL_TELEGRAM` | `requires` runtime `oneOf` tambah `'claude'` [BT pembaca `centralRuntimeKind` mengenali `claude`] |
Batas: label <=40, deskripsi <=160, `envRegistry.channels.ts` <=100 baris [V].

## 3. Kontrak UI (KU)

| ID | Komponen | Kontrak |
|---|---|---|
| KU-1 | `SettingsPanel.tsx` | `SECTIONS`: hapus `channels`/`env`, tambah `integrations` ("Integrasi") dan `server` ("Server & fitur"); "Lanjutan" = panel dalam `server` (reuse `group(ENV_UI.advanced...)`), bukan item sidebar ketiga. Id lama dipetakan lewat `LEGACY_SECTION_IDS` (jump/state tersimpan). Roving key Arrow/Home/End tetap. `IN_CHANNELS_TAB` -> "ada di Integrasi" |
| KU-2 | `ChannelsTelegramCard.tsx` (baru, <=150) | Satu kartu, state dari `ChannelHealth.state`, tepat satu aksi utama per state (tabel di bawah). Pesan per `reason` dari `CH.reason[ChannelReason]` (Record lengkap, dipaksa tipe) |
| KU-3 | Penanganan secret | Reuse `EnvSecretField`: nilai tak pernah dirender; input `type=password autoComplete=off`, dikosongkan setelah simpan atau gagal. "Ganti token" membuka input; "Hapus token" konfirmasi dua langkah inline (pola `removeTitle`) hanya bila `source==='override'`. Bila `source==='env'`: teks "Token berasal dari .env; hapus di file .env lalu restart" tanpa tombol hapus |
| KU-4 | `EnvBadges.tsx` | `badgeEnv` ("Dari .env") hanya bila terkunci env: `source==='env' && (!editable \|\| envShadowed)` (K6). Entri env yang bisa diubah tanpa badge |
| KU-5 | `EnvEntryRow.tsx` | Nama kunci env (`<code className="st-env-key">`) hanya di panel Lanjutan (prop `showKey`); di tempat lain jadi `title` tooltip. `<li aria-label>` memakai label Indonesia, bukan kunci |
| KU-6 | `useChannelHealth.ts` (baru) | Opsi `enabled` (tanpa fetch bila false; true hanya saat Integrasi aktif), polling `CHANNEL_HEALTH_POLL_MS`, guard `seq`/`inflight` seperti `useChannels` [V], 404 -> `legacy`, galat jaringan -> `loadError` |
| KU-7 | Loading/empty/error | Loading: `aria-busy`, "Memuat status…". Gagal muat: `role="alert"` "Gagal memuat status" + "Coba lagi". Daftar `pending`/`bindings` hanya tampil bila `state` bukan `off`/`unconfigured`; kosong memakai teks `CH.pendingEmpty`/`bindingsEmpty` yang ada |
| KU-8 | `EnvSection.tsx` | Hapus partisi `channelsOwned`/`part.channels` + teks `channelsMoved`; kunci `owner==='channels'` yang `advanced` ikut Lanjutan; sisanya dirender kartu. Wizard tautan chat DITUNDA (K7) |

Aksi per state kartu (K3, label Indonesia):
| State | Teks status | Aksi utama | Sekunder |
|---|---|---|---|
| `off` | alasan (`master_off` menaut ke Lanjutan, K1) | Aktifkan Telegram (saklar `WEBTERM_TELEGRAM`) bila `telegram_off` | banner restart |
| `unconfigured` | "Belum tersambung" | Simpan token | petunjuk "dari @BotFather" |
| `untested` | "Token ada, belum dites" | Tes koneksi | Ganti token, Hapus token |
| `connected` | "Terhubung sebagai @{bot}" + sejak | Tes koneksi | Ganti token, Hapus token |
| `error` | alasan statis | Tes koneksi | Ganti token |

## 4. Glosarium (GL) dan string Inggris

Istilah teknis tetap: token, webhook, polling, bot, ledger. Label <=40, deskripsi <=160.
| Key | Label | Deskripsi (satu kalimat) | Bagian |
|---|---|---|---|
| GL-sec-int | Integrasi | Hubungkan webterm ke layanan luar seperti Telegram. | sidebar |
| GL-sec-srv | Server & fitur | Fitur server dan opsi yang jarang diubah. | sidebar |
| GL-adv | Lanjutan | Opsi untuk pengguna berpengalaman; menampilkan nama variabel env. | Server & fitur |
| WEBTERM_TELEGRAM | Aktifkan Telegram | Nyalakan kanal Telegram; berlaku setelah restart. | Integrasi |
| WEBTERM_TELEGRAM_BOT_TOKEN | Token bot | Kunci bot dari @BotFather; tidak pernah ditampilkan lagi. | Integrasi |
| WEBTERM_CHANNELS | Saklar semua kanal | Mematikan seluruh kanal sekaligus. | Lanjutan |
| WEBTERM_TELEGRAM_MODE | Cara menerima pesan | Otomatis: polling bila ada token, selain itu webhook. | Lanjutan |
| WEBTERM_TELEGRAM_WEBHOOK_SECRET | Rahasia webhook | Rahasia untuk memverifikasi panggilan webhook Telegram. | Lanjutan |
| WEBTERM_CENTRAL_TELEGRAM | Central lewat Telegram | Izinkan chat Central lewat Telegram. | Lanjutan [BT section] |
| GL-btn-test | Tes koneksi | Cek token ke Telegram dan tampilkan nama bot. | kartu |
| GL-btn-del | Hapus token | Hapus token tersimpan dan hentikan kanal. | kartu |
| GL-btn-* | Simpan token / Ganti token | Simpan atau ganti token bot. | kartu |
| GL-badge-env | Dari .env | Nilai dikunci oleh file .env; tidak bisa diubah di sini. | badge |
| GL-st-* | Nonaktif / Belum tersambung / Token ada, belum dites / Terhubung / Galat | Lima state kartu (KU-2). | kartu |
Alasan (`CH.reason`, Indonesia, satu kalimat pendek per kode): master_off "Saklar semua kanal mati"; telegram_off "Telegram belum diaktifkan"; ledger_off "Ledger belum menyala"; no_token "Token bot belum diisi"; token_rejected "Token ditolak Telegram"; poll_conflict "Bot dipakai instans lain"; network "Telegram tidak terjangkau"; timeout "Telegram tidak menjawab"; rate_limited "Terlalu sering, coba sebentar lagi"; webhook_secret_missing "Rahasia webhook kosong".

String Inggris yang wajib Indonesia ([V] dari kode; grep ulang, [BT] `ChannelsLists.tsx`):
| Berkas | Sekarang | Jadi |
|---|---|---|
| `SettingsPanel.tsx` | DialogTitle/header/fallback/`main aria-label` "Settings" | Pengaturan |
| idem | DialogDescription "Configure webterm behavior and appearance." | Atur perilaku dan tampilan webterm. |
| idem | `title="Clear Search Results"` | Hapus pencarian |
| idem | `aria-label="Section settings"` | Bagian pengaturan |
| idem | "Tutup settings", "Cari setting", "{n} setting ditemukan" | pengaturan (satukan kata) |
| `channelsLabels.ts` | 'Channels', 'Role', 'Project ID', 'error', 'OK', 'terakhir OK', 'poll (long polling)', 'viewer/operator/approver/owner' | Integrasi, Peran, ID proyek, galat, berhasil, terakhir berhasil, polling, pengamat/operator/penyetuju/pemilik |
| `EnvSecretField.tsx` | `aria-label` memakai kunci env | "Hapus {label}" |
Nilai wire dan kunci env tak berubah. Placeholder `project id` -> "ID proyek".

## 5. A11y dan pencarian

- Teks status kartu `role="status" aria-live="polite"`; hasil Tes koneksi region polite terpisah; kegagalan muat `role="alert"`. Umumkan hanya saat `state`/`reason` berubah, bukan tiap polling.
- Tombol nonaktif memakai `disabled` asli + `aria-describedby` ke alasan; "Tes koneksi" disabled dan `aria-busy` saat jalan.
- Fokus: setelah Simpan -> Tes koneksi; setelah Hapus -> input token; konfirmasi hapus mulai di Batal; Escape menutup konfirmasi, bukan dialog.
- Input token: `aria-label` "Token bot Telegram", tanpa `name` (hindari autofill).
- Pencarian: hapus `return null` saat query di `ChannelsSection`; kartu ikut lewat konstanta kata kunci (`telegram, bot, token, integrasi, tes koneksi`), hit menaut ke `integrations`. Kunci Lanjutan dicari lewat label dan nama env; hit membuka panel Lanjutan. `envSearch.ts` dan `SettingsPanel.envsearch.test.tsx` disesuaikan [BT bentuk indeks].

## 6. Matriks tes (KT/KU -> berkas)

Server: `bun test --no-env-file`, `TMPDIR=/tmp/st`. Klien: pragma `/** @vitest-environment jsdom */`.
| Kontrak | Berkas tes | Kasus + asersi kunci |
|---|---|---|
| KT-1 | `channelTest.bun.test.ts` | fake fetch: 200 `{ok,botUsername}`; 401/404 `token_rejected`; 429; abort `timeout`; username tak valid dibuang; `no_token`. `JSON.stringify(res)`, log, dan error `not.toContain(TOKEN)` |
| KT-1 | `channelTestHttp.test.ts` | GET 405; body `{token:'x'}` 400; 413; panggilan < 3 s 429 `too_fast`; terpasang saat runtime `null` |
| KT-2 | `envSettings.afterUpdate.test.ts` | hook menerima nama tanpa nilai; hook melempar -> update tetap 200 + warn tanpa nilai; unset token -> `secretSet` false; token juga di `base` -> tetap `source:'env'` |
| KT-3 | `channelLifecycle.bun.test.ts` | round-trip dengan Bot API palsu (`Bun.serve`) [BT titik injeksi base URL]: boot tanpa token tak ada poller; set token -> start tepat sekali; set ulang -> tak ada poller kedua; unset -> stop + sender drop; 401 fatal -> `error/token_rejected`, token baru -> start ulang; `reconcile()` konkuren berurutan; runtime `null` -> no-op; mode webhook -> tanpa poller |
| KT-4 | `channelHealth.test.ts` | tabel semua cabang gerbang 1-5 + `since` hanya berubah saat transisi; tak ada string error di keluaran |
| KT-4 | `channelHealthHttp.test.ts` | 200 saat runtime `null`; `/status` lama tetap 404 saat `null` dan bentuk tak berubah (kompat klien lama) |
| KT-4/UI | `channelsContract.test.ts` | `CH.reason` memuat semua `CHANNEL_REASONS`; tiap state punya aksi |
| KT-5 | `envRegistry.channels.test.ts` | audience sesuai tabel, panjang label/deskripsi, `KNOWN_KEYS_FROZEN` utuh, `requires` menerima `claude` |
| KU-2/3 | `ChannelsTelegramCard.test.tsx` | satu kasus per state: aksi utama benar, state `off` menaut Lanjutan; "Hapus token" hanya bila `override`; konfirmasi dua langkah |
| KU-3 | `ChannelsTelegramCard.secret.test.tsx` | setelah simpan: `container.innerHTML` dan semua atribut tak memuat nilai; input kosong; respons PUT palsu pun tak dirender |
| KU-4/5 | `EnvBadges.test.tsx`, `EnvEntryRow.test.tsx` | badge hanya saat terkunci env; kunci env hanya dengan `showKey` |
| KU-1/GL | `SettingsPanel.chenv.test.tsx` | sidebar berisi Integrasi + Server & fitur; id lama terpetakan; tak ada `aria-label`/`title`/`placeholder` cocok daftar larangan (`Settings|Channels|Role|Clear|Section`) |
| KU-6 | `useChannelHealth.test.tsx` | `enabled:false` tanpa fetch; 404 -> `legacy`; guard `seq` membuang respons basi |
| §5 | `SettingsPanel.envsearch.test.tsx` | query "telegram" menampilkan kartu; hit Lanjutan membuka panel; `aria-live` ada |
Tes lama yang pasti berubah: `ChannelsSection.test.tsx` (hilang `return null` saat query), `ChannelsTelegramConfig.test.tsx` dan `ChannelsEnvBridge.sa08.test.tsx` (partisi `channelsOwned` dihapus), `SettingsPanel.test.tsx` (nama section/judul), `SettingsPanel.envsearch.test.tsx`. Cek `toMatchSnapshot` [BT].

## 7. Risiko dan rollback

| ID | Risiko | P×D | Mitigasi | Rollback |
|---|---|---|---|---|
| R1 | Pengguna yang mengatur lewat UI lama kehilangan jalan: master `WEBTERM_CHANNELS` pindah ke Lanjutan | 2×2 | Nilai tersimpan tak berubah; `off` menaut ke Lanjutan | revert audience di registry |
| R2 | Kunci jadi env-only tapi tetap dipakai (mode, webhook) | 2×3 | Hanya `audience` yang berubah; kunci tetap bisa di-override, `KNOWN_KEYS_FROZEN` | revert metadata |
| R3 | Override tersimpan tak terbaca | 1×3 | Tanpa migrasi: kunci dan format tak berubah [V] | tak ada data berubah |
| R4 | Poller ganda saat reconcile beruntun | 2×3 | Antrean serial, `stop` ditunggu, satu `process.once` | `reconcile` no-op; restart seperti dulu |
| R5 | Token bocor lewat tes/hook/log | 1×3 | Token hanya dibaca di server; respons dan log berkode statis; tes `not.toContain` (§6) | tarik rute `/test` |
| R7 | Klien baru vs server lama | 2×2 | `/state` 404 -> `legacy`; `/status` tak berubah | klien tetap jalan |
| R9 | Sender late-bound mengganggu antrean berjalan | 2×3 | `dropSender` flush dulu; tes sender | revert `channelsRuntime.ts` |
Rollback umum: KT-1..4 aditif (rute lama utuh); sisanya revert per commit.

## 8. [BT] untuk implementer

1. Mekanisme penerapan secret ke `process.env` untuk kunci `hot` dan apakah alias `TELEGRAM_BOT_TOKEN` ikut `base` (KT-2).
2. Titik injeksi base URL Bot API untuk tes round-trip (KT-3) dan cara fake `fetch` di `callBotApi`.
3. Apakah antrean sender dipersist di store (KT-3).
4. Tempat pemasangan rute `/state` dan `/test` agar terpasang saat runtime `null` (`index.ts` / modul http).
5. Bentuk indeks `envSearch.ts`; `ChannelsLists.tsx`, `EnvPanel*` untuk string Inggris tersisa.
6. `centralRuntimeKind` mengenali `claude`; `section` untuk `WEBTERM_CENTRAL_TELEGRAM`; `owner/section` `LEDGER`.
7. Snapshot `toMatchSnapshot` pada tes lama; state sidebar tersimpan (localStorage?) untuk `LEGACY_SECTION_IDS`.
8. `channelsRuntime.ts` (256) dan `SettingsPanel.tsx` (278) tidak boleh melewati 300 (Rule 8).
