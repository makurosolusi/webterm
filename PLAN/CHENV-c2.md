# PLAN CHENV (c2) — spek siap-tempel W2-W5, peta gelombang, urutan orkestrator, Q1-Q5

Lanjutan `CHENV-c.md` (PREAMBLE di sana; tempel PREAMBLE + SATU spek). Basis W2: `chore/chenv-int` setelah W0+W1 merge. `channels/...` = `src/server/channels/...`; berkas klien di `src/client/`.

## Gelombang W2 — CH-05 dan CH-08 (SATU pesan; berkas saling lepas)

### CH-05 kartu Telegram tunggal (`feature/chenv-telegram-card`, `wkr-chenv-tgcard-01`, M-L) — C1-C4, C11, C13, KU-2/3/6/7

**File + jatah:** baru: `ChannelsTelegramCard.tsx` (<=150), `ChannelsTokenForm.tsx` (<=110), `useChannelHealth.ts` (<=110); diubah: `ChannelsSection.tsx` (94 -> <=200), `ChannelsTelegramConfig.tsx` (83 -> <=150), `ChannelsLists.tsx` (141 -> <=150; string), `channelsLabels.ts` (65 -> <=130), `channelsApi.ts` (106 -> <=150), `settings-channels.css` (98 -> <=160), `EnvSecretField.tsx` (37 -> <=45; `aria-label`); tes baru: `ChannelsTelegramCard.test.tsx` (<=300), `ChannelsTelegramCard.secret.test.tsx` (<=150), `useChannelHealth.test.tsx` (<=150), `channelsContract.test.ts` (<=80); perbarui `ChannelsSection.test.tsx`, `ChannelsTelegramConfig.test.tsx`, `ChannelsEnvBridge.sa08.test.tsx`, `EnvValueControl.test.tsx`, `SettingsPanel.envsearch.test.tsx` (kasus "telegram"). DILARANG: `EnvSection.tsx`, `SettingsPanel.tsx`, `useChannels.ts`, server.
**Perilaku:**
- `channelsApi.ts`: `fetchChannelHealth(signal)` (GET `CHANNEL_STATE_PATH`; 404 -> `null` = server lama) dan `testChannel()` (POST `CHANNEL_TEST_PATH`, `{}`; 429 -> `{ok:false, reason:'rate_limited'}`) via `request`; tipe dari `../shared/channels.contract`. `useChannelHealth({enabled})`: nol fetch bila `enabled=false`; polling `CHANNEL_HEALTH_POLL_MS=5_000` (konstanta di berkas hook); guard `seq` seperti `useChannels`; 404 -> `legacy`; mengembalikan `{health, legacy, loading, loadError, refresh}`.
- `ChannelsTelegramCard`, aksi utama per `health.state`: `off` -> alasan `CH.reason[reason]`; `telegram_off` -> "Aktifkan Telegram"; `master_off` -> tautan "Buka Lanjutan" (`OpenEnvContext` -> `WEBTERM_CHANNELS`); `unconfigured` -> "Belum tersambung" + `ChannelsTokenForm` (petunjuk "Ambil token dari @BotFather"); `untested` -> "Token ada, belum dites" + "Tes koneksi"; `connected` -> "Terhubung sebagai @{bot}" + sejak (`relativeTime`); `error` -> alasan + "Tes koneksi" + "Ganti token". "Hapus token" hanya bila token `source==='override'`: konfirmasi dua langkah (fokus awal "Batal", Escape menutup konfirmasi saja); `source==='env'` -> teks "Token berasal dari .env; hapus di file .env lalu mulai ulang." tanpa tombol. Hasil tes di `role="status"`; "Tes koneksi" `disabled`+`aria-busy` saat jalan.
- Aksi menulis memakai `putEnv` LANGSUNG (bukan draf massal): Aktifkan `{set:{WEBTERM_TELEGRAM:'on'}}`; Simpan/Ganti `{set:{WEBTERM_TELEGRAM_BOT_TOKEN:<input>}}`; Hapus `{unset:['WEBTERM_TELEGRAM_BOT_TOKEN']}` (Q5: tak mematikan `TELEGRAM`; alias `TELEGRAM_BOT_TOKEN` tetap efektif, UI memberi tahu). Input `type=password autoComplete=off`, `aria-label` "Token bot Telegram", tanpa `name`; dikosongkan setelah simpan ATAU gagal; sukses -> refresh env + health, fokus ke "Tes koneksi" (setelah Hapus -> input). Galat via `envErrorMessage`. Tidak pernah otomatis menyalakan `TELEGRAM` (S-C11).
- Kontrol `WEBTERM_TELEGRAM`/`..._BOT_TOKEN` tetap ber-`data-env-item` agar `focus()` di `ChannelsTelegramConfig` jalan. "Central lewat Telegram" (`WEBTERM_CENTRAL_TELEGRAM`) lewat `EnvGroupSection` satu entri, hanya bila `valueOf('WEBTERM_CENTRAL')==='on'`. `ChannelsTelegramConfig` tetap pemilik provider dan banner/save bar.
- `ChannelsSection`: kartu; `Direction`/`StatusBlock` ke `<details>` "Detail teknis"; pending/bindings hanya bila state bukan `off`/`unconfigured`. Loading `aria-busy` "Memuat status…"; gagal `role="alert"` + "Coba lagi". `legacy`: state dari `/status` lama (`botTokenSet` -> `untested`, selain itu `unconfigured`), tanpa "Tes koneksi". Query pencarian aktif tetap `return null`; hit lewat `channelHits` (deviasi dari (b) §5).
- `channelsLabels.ts` (K4, Rule 15): string Inggris -> Indonesia per (b) §4 (Role -> Peran, Project ID -> ID proyek, error -> galat, OK -> berhasil, poll -> polling, viewer/operator/approver/owner -> pengamat/operator/penyetuju/pemilik; nilai wire utuh); `CH.reason: Record<ChannelReason, string>` lengkap (teks (b) §4 + `restart_required` "Token baru aktif setelah webterm dimulai ulang"). `EnvSecretField`: `aria-label` = `${ENV.remove} ${entry.label}` (bukan kunci env).
**Verifikasi dulu:** signature `request` dan pola POST di `channelsApi.ts`; `grep -rn "aria-label" src/client/*.test.tsx` untuk tes yang memakai kunci env; `OpenEnvContext` (`channelsOpenEnv.ts`) membuka Lanjutan lewat `focusKey`; bila perlu ubah `SettingsPanel.tsx`/`EnvSection.tsx`: STOP, lapor.
**Tes:** kartu: satu kasus per state (aksi utama benar), `master_off` memanggil `openEnv('WEBTERM_CHANNELS')`, "Hapus token" hanya dengan `override` dan dua klik, `source==='env'` tanpa tombol hapus, Simpan memanggil `putEnv` persis `{set:{WEBTERM_TELEGRAM_BOT_TOKEN:'...'}}` (tidak pernah menyentuh `WEBTERM_TELEGRAM`). Secret: setelah simpan (sukses dan gagal) `innerHTML`, atribut, dan input tak memuat token sentinel. Hook: `enabled:false` nol fetch; 404 -> `legacy`; respons basi dibuang. Kontrak: `CH.reason` memuat semua `CHANNEL_REASONS`. Tes lama terdampak diperbarui.
**Selesai bila:** `npm test` + typecheck hijau, tak ada string Inggris K4 di berkasmu, `git diff --stat` hanya berkas di atas.

### CH-08 UI impor `.env` (`feature/chenv-import-ui`, `wkr-chenv-import-01`, M) — DU-2

**File + jatah:** baru: `EnvImportCard.tsx` (<=150), `envImportApi.ts` (<=60), `envImportLabels.ts` (<=60), `EnvImportCard.test.tsx` (<=200); diubah: `EnvSection.tsx` (<=180; HANYA titik pasang <=10 baris setelah `EnvServerCard`), `settings-env.css` (219 -> <=260). DILARANG: `envLabels.ts`, server, berkas Channels.
**Perilaku:** `envImportApi.ts`: `ENV_IMPORT_PATH='/api/settings/env/import'` (cermin `IMPORT_ENDPOINT` server; tes menyamakan), `previewImport()` = POST `{}`, `applyImport()` = POST `{apply:true}` via `request`; tipe dari `../shared/envSettings.import.contract`. `EnvImportCard`: tombol "Impor dari .env" membuka `Dialog` pratinjau: "Akan ditambah (n)", "Sudah sama (n)", "Konflik (n): tidak ditimpa", "Dilewati (n)" dengan alasan Indonesia per `reason` (`bootstrap`, `invalid`, `needs_root`, `locked`). Baris = label entri (fallback nama kunci) + tag "rahasia"/"berbahaya"; TANPA nilai. `found:false` -> "Tidak ada file .env di folder server."; `ignored>0` -> "{n} kunci di luar daftar diabaikan." "Terapkan {n} perubahan" aktif hanya bila ada `add`; konflik tanpa tombol timpa. Terapkan memanggil `applyImport()` sekali (server membaca ulang `.env`), lalu `refresh()` env (banner restart ikut), pesan "Diterapkan {applied}", tutup dialog, fokus kembali ke pemicu. Galat `role="alert"`: 401/403 "Tidak diizinkan", 413 "Terlalu besar", lain "Gagal membaca .env".
**Verifikasi dulu:** `envImportRoute` di `envSettings.api.ts` (respons, 4xx); `EnvSection.tsx` pasca-CH-04; `@/components/ui/dialog`.
**Tes:** dry-run tak memanggil apply; apply mengirim `{apply:true}` sekali; respons bermuatan `value` sentinel tak dirender; Terapkan `disabled` saat 0 `add`; alasan Indonesia; `ENV_IMPORT_PATH` sama dengan `IMPORT_ENDPOINT`.
**Selesai bila:** tes baru + `npm test` + typecheck hijau; `git diff --stat` hanya berkas di atas.

## Gelombang W3 — CH-03 (server) dan CH-07 (klien), berkas saling lepas (SATU pesan; setelah W2 merge)

### CH-03 hot-apply token (`feature/chenv-hot-token`, `wkr-chenv-hottoken-01`, M-L) — C16, KT-2, KT-3

**File + jatah:** baru: `channels/channelLifecycle.ts` (<=150), `channels/channelLifecycle.test.ts` (vitest, <=250), `src/server/channelLifecycle.bun.test.ts` (Bun-only, top-level agar masuk glob, <=250), `src/server/envSettings.afterUpdate.test.ts` (runner ikut tetangga `envSettings.api`, <=200); diubah: `channels/channelsRuntime.ts` (256 -> <=290), `channels/telegramPollWiring.ts` (68 -> <=90; hapus `process.once('exit')`), `channels/channelsRuntimeSender.test.ts` (246 -> <=300), `telegramPollWiring.test.ts` (bila perlu), `src/server/envSettings.api.ts` (78 -> <=100), `envSettings.runtime.ts` (54 -> <=70), `src/server/index.ts` (<=275). DILARANG: `channelSenderBoot.ts`, `channelStatus*.ts`, `channelHealth*.ts` (CH-02), registry, klien.
**Perilaku:**
- `createChannelLifecycle({ runtime, ledger, centralChat, env, start = startTelegramInbound })` -> `{ reconcile(), onEnvChanged(names), stop() }`. Antrean promise serial (`startTelegramPoller` melempar bila `active`, jadi `start` menunggu `stop()`). `reconcile()` idempoten: runtime `null` -> no-op; token ada (`resolveTelegramBotToken(env)`) -> `runtime.ensureSender()`, dan bila `runtime.mode==='poll'` serta poller belum ada atau `done` selesai (fatal 401/404) -> `start(...)`; token tiada -> `await poller.stop()` + `runtime.dropSender()` (outbox durable tidak dibuang). Mode `webhook`: hanya sender. Satu `process.once('exit')` di lifecycle. `onEnvChanged(names)` bila beririsan dengan `CHANNEL_RECONCILE_KEYS`: `markTokenChanged(Date.now())`, `clearLastTest()` (`channelStatus.ts`), lalu `reconcile()`. Poller membaca token dari `process.env` tiap iterasi, jadi ganti token tak perlu restart poller hidup.
- `channelsRuntime.ts`: `sender` const -> `let`; runtime mendapat `ensureSender(): boolean` (idempoten, `startChannelSenderFor`) dan `dropSender(): void` (`stopChannelSender`, set `null`); `senderRunning`, `flushNow`, `stop` membaca variabel terkini.
- `envSettings.api.ts`: `EnvSettingsApiDeps.afterUpdate?(names: readonly string[])`; dipanggil setelah PUT sukses (kunci `set` + `unset`, TANPA nilai) dan impor-apply `applied>0` (item `add`); gagal -> `log.warn('env.after_update_failed', ..., {names})`, respons tetap 200 (Rule 11). `envSettings.runtime.ts`: `setEnvAfterUpdate(fn)`, disertakan `envSettingsApiDeps()`.
- `index.ts`: blok `startTelegramInbound` (L~59-72) diganti lifecycle, `void lifecycle.reconcile()` saat boot, `setEnvAfterUpdate((n) => lifecycle.onEnvChanged(n))`. Aktivasi pertama (runtime `null`) TETAP butuh restart (`restart:'boot'`; state `restart_required` dari CH-02).
**Verifikasi dulu:** `envImportRoute` (cara mengambil item `add`); `HOT_PROOF` di `envRegistry.parity.test.ts` (perlu ubah: STOP, lapor); apakah `telegramPollWiring.test.ts` menegaskan listener `exit`; `WEBTERM_TELEGRAM_API_BASE` (`telegramPollApi.ts`) untuk `Bun.serve` palsu; `grep -n "sender" channels/channelsRuntime.ts`.
**Tes:** vitest fake runtime/poller: boot tanpa token tidak start; set token -> `start` sekali; set ulang -> tak ada poller kedua; unset -> `stop` + `dropSender`; fatal lalu token baru -> start ulang; `reconcile()` konkuren berurutan; runtime `null` -> no-op; webhook tanpa poller; `onEnvChanged(['LAIN'])` tak menyentuh apa pun. Bun: poller nyata vs Bot API palsu -> pesan masuk tanpa restart. `afterUpdate`: hook menerima nama tanpa nilai, hook melempar -> PUT tetap 200 + warn tanpa nilai, unset token -> `secretSet` false, alias tetap efektif.
**Selesai bila:** vitest + `TMPDIR=/tmp/st bun test --no-env-file src/server/*.bun.test.ts` + typecheck hijau, jatah baris terpenuhi, `git diff --stat` hanya berkas di atas.

### CH-07 opt-in token akses (`feature/chenv-token-optin`, `wkr-chenv-tokenui-01`, M) — DU-4..DU-7

**File + jatah:** baru: `TokenCard.tsx` (<=150), `tokenApi.ts` (<=80), `tokenLabels.ts` (<=70), `TokenCard.test.tsx` (<=250); diubah: `EnvServerCard.tsx` (23 -> <=80), `EnvRestartBanner.tsx` (16 -> <=50), `envSettingsApi.ts` (82 -> <=100; HANYA `host_not_allowed`), `envLabels.ts` (<=75; teks `noRootGate`, cara restart, `errHost`), `EnvServerCard.test.tsx` (31), `EnvRestartBanner.test.tsx` (44). DILARANG: `Login.tsx` (tidak berubah; layar tempel token = Login yang ada, deviasi dari (a)), `EnvSection.tsx`, server.
**Kontrak (`tokenAccess.api.ts`):** GET `/api/settings/token` -> `{enforced, source:'env'|'file'|'none', canEnable}`; POST `/enable` dan `/rotate` -> `{token}` (sekali, `no-store`); galat: 403 `loopback_only`; 409 `already_enabled`/`env_managed`/`not_enabled`; 500 `token_persist_failed`; 413/400/405. `tokenApi.ts`: `TOKEN_ACCESS_PATH`, `fetchTokenAccess`, `enableToken`, `rotateToken` via `request`.
**Perilaku:** `TokenCard` di dalam `EnvServerCard`: `!enforced && canEnable` -> "Aktifkan token akses"; `!enforced && !canEnable` -> "Hanya bisa diaktifkan dari komputer yang menjalankan webterm."; `enforced && source==='file'` -> "Token akses aktif" + "Putar token" (konfirmasi dua langkah); `source==='env'` -> "Token diatur lewat .env (WEBTERM_TOKEN)" tanpa tombol. Sukses -> token tampil SEKALI di kotak `role="status"` dengan "Salin" dan peringatan, `storeToken(token)` (`./api`) SEBELUM request berikutnya, lalu "Sudah saya simpan" menghapusnya dari state dan DOM. Galat Indonesia per kode. DU-6: `noRootGate` menunjuk ke kartu ini. DU-5: banner restart "Mulai ulang webterm agar berlaku." + `<details>` "Cara mulai ulang" tiga baris statis (dev, service, biner). DU-7: `envErrorMessage` memetakan `code==='host_not_allowed'` ke `ENV.errHost` sebelum cabang 403 umum.
**Verifikasi dulu:** respons nyata `tokenAccess.api.ts` (S-C8 bila beda); `storeToken` di `api.ts`.
**Tes:** per kombinasi `enforced`/`source`/`canEnable` tombol benar; enable sukses -> `storeToken` sebelum fetch berikutnya; setelah "Sudah saya simpan" `innerHTML` tak memuat token sentinel; rotate butuh dua klik; `host_not_allowed` -> `errHost`; banner memuat `<details>`.
**Selesai bila:** `npm test` + typecheck hijau; `git diff --stat` hanya berkas di atas.

## Gelombang W4 — CH-09 (setelah W3 merge)

### CH-09 kartu run-pertama (`feature/chenv-firstrun`, `wkr-chenv-firstrun-01`, S) — DU-3 (K7: bukan wizard)

**File + jatah:** baru: `FirstRunCard.tsx` (<=120), `firstRunLabels.ts` (<=40), `FirstRunCard.test.tsx` (<=150); diubah: `EnvSection.tsx` (<=190; HANYA titik pasang <=10 baris di atas "Info server"). DILARANG: berkas lain.
**Perilaku:** tampil bila tak ada entri `source==='override'` DAN belum ditutup. Tiga langkah statis: "Amankan akses" (selesai bila `fetchTokenAccess().enforced`; menunjuk kartu "Info server"), "Sambungkan Telegram" (selesai bila `WEBTERM_TELEGRAM_BOT_TOKEN` `secretSet`; tombol memanggil `onOpenChannels`), "Pilih fitur utama" (informasi). "Sembunyikan" menyimpan ke `localStorage` (try/catch; gagal tulis tak melempar, tersembunyi selama sesi). Tanpa API baru, tanpa aksi menulis (S-C11).
**Verifikasi dulu:** `EnvSection` mengoper `onOpenChannels`.
**Tes:** tampil tanpa override, hilang bila ada; "Sembunyikan" bertahan pada render ulang; `localStorage` melempar -> tak crash; tombol Telegram memanggil `onOpenChannels`; status token mengikuti `enforced`.
**Selesai bila:** tes baru + `npm test` + typecheck hijau; diff 4 berkas.

## Gelombang W5 — CH-11 (setelah semua merge)

### CH-11 dokumen akhir (`docs/chenv-final`, `wkr-chenv-docs-01`, S) — bergantung SEMUA + EM-16

**File + jatah:** `README.md` (17.005 karakter; net <= +400, batas keras 20.000), `CHANGELOG.md` (`## [Unreleased]`), `docs/decisions/chenv.md` (baru, <=150 baris, Indonesia). DILARANG: kode.
**Perilaku:** README, edit terbatas (Rule 16; narasi milik user): "Settings > Environment" -> "Settings > Server & fitur" (baris ~49, ~68); di bagian Telegram (~36-38) satu kalimat bahwa token bot bisa diisi di Settings > Integrasi (write-only) plus rute `GET /api/channels/telegram/state` dan `POST /api/channels/telegram/test`; sisanya DIFLAG. CHANGELOG (Inggris, perspektif pengguna, `[Unreleased]`): Added (kartu Telegram berstatus + Tes koneksi, impor `.env`, kartu token akses, kartu run-pertama), Changed (tab menjadi "Integrasi"/"Server & fitur", teks Settings Indonesia, saklar master/mode ke Lanjutan, 19 pengaturan tuning disembunyikan, badge "Dari .env" hanya bila terkunci), Fixed (token bot berlaku tanpa restart pada kanal yang sudah hidup). `chenv.md`: K1-K7, C1-C17, partisi 12/31/19, deviasi, kontrak rute baru, tidak dikerjakan (wizard K7).
**Verifikasi dulu:** `wc -m README.md` sebelum/sesudah; setiap klaim cocok dengan kode yang sudah merge.
**Selesai bila:** `wc -m README.md` <= 17.405; `git diff --stat` 3 berkas.

## Peta gelombang dan kepemilikan berkas bentrok

| Gel. | WS | Paralel? | Syarat masuk |
|---|---|---|---|
| W0 | CH-00, 01, 02 | Ya | basis `chore/chenv-int` |
| W1 | CH-04, 06 | Ya | W0 merge |
| W2 | CH-05, 08 | Ya | W1 merge (CH-02 + CH-04) |
| W3 | CH-03, 07 | Ya (server vs klien) | W2 merge |
| W4 | CH-09 | Tunggal | CH-07 merge |
| W5 | CH-11 | Tunggal | semua merge |

Pemilik bergilir: `SettingsPanel.tsx`/`settingsSections.ts`/`SettingsNav.tsx` CH-00 -> CH-04; `EnvSection.tsx` CH-04 -> CH-08 -> CH-09 (titik pasang); `envLabels.ts` CH-06 -> CH-07; `index.ts` CH-02 -> CH-03; `shadcnPolicy.test.ts` hanya CH-00; `channelsRuntime.ts` hanya CH-03; `channelStatus.ts` CH-02 (CH-03 hanya mengimpor).

## Urutan orkestrator (Rule 2/23)

| Langkah | Tindakan |
|---|---|
| 0 | Buat `chore/chenv-int` dari `chore/envmin-int`; commit `PLAN/CHENV-*.md` + `RND/55-CHENV-DESIGN.md` ke sana |
| 1 | Per worker: `git worktree add ../webterm-wt/chenv-<nama> -b <branch> chore/chenv-int`; tempel PREAMBLE + spek; tab terpisah bernama sesuai judul spek |
| 2 | Luncurkan seluruh worker satu gelombang dalam SATU pesan; tunggu semua laporan |
| 3 | Per laporan: cocokkan `git diff --stat` dan `wc -lm` dengan jatah (S-C12; laporan fiktif pernah terjadi), baca diff, jalankan tes WS; orkestrator commit; merge `--no-ff` ke int; perbaikan = fix-up worker |
| 4 | Gerbang per gelombang di int: `TMPDIR=/tmp/st npm run typecheck`, `npm test`, `TMPDIR=/tmp/st bun test --no-env-file src/server/*.bun.test.ts`, `git status --short` bersih. Merah = stop-gate (S-C6) |
| 5 | W0 -> gerbang -> W1 -> ... -> W5 -> gerbang akhir |
| 6 | Temuan baru dari worker: suarakan dan minta izin (Rule 21) |
| 7 | Lapor ke user (per WS, deviasi, gerbang, checklist Rule 6). Merge ke utama, push, deploy HANYA atas perintah eksplisit |

Titik bentrok yang sudah diurai: `SettingsPanel.tsx`, `EnvSection.tsx`, `envLabels.ts`, `index.ts` bergilir satu pemilik per gelombang; `README`/`CHANGELOG`/`docs/decisions` hanya CH-11; `envRegistry.*` hanya CH-01.

## Keputusan user tersisa (rekomendasi tegas)

| # | Pertanyaan | Rekomendasi |
|---|---|---|
| Q1 | CH-03: hot-apply token pada kanal yang sudah hidup (aktivasi pertama tetap restart)? | Ya; tanpanya "Simpan token" = simpan lalu restart, tapi program tetap bisa rilis tanpa CH-03 (C17). |
| Q2 | Gabung `CENTRAL_CHAT` ke `CENTRAL`? | Jangan; hubungan belum terbukti, cukup pindah ke Lanjutan (CH-01). |
| Q3 | Sembunyikan 19 pengaturan tuning (muncul bila ada override)? | Ya; tanpa efek bagi pengguna biasa dan dapat dibalik lewat `envUiHidden.ts`. |
| Q4 | Satukan tujuh flag CA2 jadi satu sakelar? | Jangan; mengubah perilaku, biarkan di Lanjutan. |
| Q5 | "Hapus token" juga mematikan `WEBTERM_TELEGRAM`? | Tidak; hanya menghapus token, status jadi "Belum tersambung". |
