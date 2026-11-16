# PLAN ENV-MINIMAL (a) — Keputusan terkunci, veto user, peta workstream

Seri: (a) keputusan + peta (ini) · (b) kontrak teknis/tes/risiko (`ENV-MINIMAL-b.md`) · (c) PREAMBLE + spek per WS (`ENV-MINIMAL-c.md`).
Sumber: `RND/51-ENV-MINIMAL-INVENTORY(-b).md`, `RND/52-ENV-MINIMAL-ZERO-CONFIG-BOOT.md`, `RND/53-ENV-MINIMAL-CONFIG-LAYERS(-b).md` (commit `0d891df`).
Label: `[V]` = diverifikasi di worktree · `[RND]` = dari RND, belum diverifikasi ulang · `[BT]` = worker wajib cek dulu.

## 1. Tujuan dan bukan-tujuan

**Permintaan user (verbatim):** "saya berencana untuk menggunakan .env seminimal mungkin sangat minimal atau bahkan jika tanpa .env app tetap bisa dijalankan, sekarang sebar agent untuk R&D untuk meriset dan analisa kedalam project, lalu buat plan/*.md setelah itu sebar agent untuk mengerjakannya".

**Tujuan:** `.env` OPSIONAL TOTAL (bukan dihapus). Tanpa env var, app naik, aman secara default, fitur dinyalakan dari Settings. Env tetap override sah.

**Bukan-tujuan:** hapus dukungan `.env`; rename nama protokol `WEBTERM_*`/`x-webterm-node-token`/`webterm:` (sudah baku) dan `WEBTERM_TOKEN`; skema DB/dependency baru; `Bun.secrets`; UI (PLAN CHENV, §10).

## 2. Fakta dasar (diverifikasi)

| # | Fakta | Bukti |
|---|---|---|
| F1 | Boot tanpa env SUDAH jalan di loopback; kekurangan = keamanan default, `dangerous` terkunci, kebersihan `.env`, pesan galat | RND/52 U1-U2 `[RND]` |
| F2 | Presedensi nyata: override tersimpan > env proses > default kode; bootstrap hanya env > default | `envSettings.service.ts` `apply()` `[V]`; tes `service.test.ts:17,31,202` |
| F3 | 14 kunci `dangerous` butuh root token; `rootGate` = `WEBTERM_TOKEN` tak kosong -> loopback tanpa token = terkunci (celah G1) | `envSettings.runtime.ts:37` `[V]` |
| F4 | `resolveToken` melempar bila non-loopback tanpa token; `writeTokenToEnv` memutasi env | `auth.ts:51,71`, `index.ts:38-45` `[V]` |
| F5 | `authorize()` hanya memeriksa `Origin` vs `Host` request; tidak ada allowlist Host -> DNS rebinding lolos | `auth.ts:95-122` `[V]`, RND/52 U9 |
| F6 | `ptyEnv` menyapu 6 pola; `TELEGRAM_BOT_TOKEN` + kunci `.env` lain diwarisi PTY | `ptyShell.ts:74` `[V]` |
| F7 | `KNOWN_KEYS_FROZEN` memuat 4 kunci mati; tes menegaskan tiap kunci registry ada di daftar beku | `envRegistry.invariants.test.ts:22-32,190` `[V]` |
| F8 | `service.update()` menyimpan kunci tak dikenal (`unknownKept`) -> override lama kunci yang dihapus tidak hilang | `envSettings.service.ts:139-140` `[V]` |
| F9 | Dialek flag: `flagOn` hanya `on`; `LOG_FILE` off-only; kunci keamanan `=== '1'` | `envFlag.ts`, `logger.ts:108` `[V]` |
| F10 | `auth.test.ts` 470 baris (>400, jangan ditambah); `README.md` 17.035 kar (85% batas) | `wc -lm` `[V]` |

## 3. Keputusan terkunci dan daftar veto user

Terkunci = dasar PLAN. "Ubah perilaku?" menandai yang BERUBAH bagi pengguna; user boleh memveto tiap baris (diam = default). Gabungan 51/52/53.

| ID | Keputusan (default tegas) | Asal | Ubah perilaku? | Bila diveto |
|---|---|---|---|---|
| L1 | Sasaran `.env` opsional total; set bootstrap DIDOKUMENTASIKAN = 9 kunci: `HOST PORT WEBTERM_DATA_DIR WEBTERM_TOKEN WEBTERM_ENV_SETTINGS WEBTERM_ALLOW_LOOPBACK_APPROVAL WEBTERM_ALLOW_TOKEN_MINT WEBTERM_STRICT_HOOK_AUTH WEBTERM_ALLOWED_HOSTS`. `WEBTERM_HOST` dan `WEBTERM_TELEGRAM_API_BASE` tetap dibaca, tak didokumentasikan. Kunci non-bootstrap di `.env.example` dilarang | 51 §4.1, 52 K5 | Tidak | — |
| L2 | Presedensi override > env > default dipertahankan (Opsi A); Settings menampilkan sumber nilai (`envShadowed`) | 51 D2, 53 K1 | Tidak | Opsi B (`env-first`) = topik baru; S1 |
| L3 | Token Opsi D: (1) non-loopback tanpa token = bangkitkan + persist 0600 di `<dataDir>/secrets/WEBTERM_TOKEN` (bukan crash); (2) loopback terbuka sampai opt-in; (3) env menang atas berkas; (4) URL ber-token ke stderr hanya bila TTY, sekali, bukan log | 51 D1, 52 K1-K2 | **Ya** (non-loopback tak lagi crash) | Status quo (crash) / token selalu aktif (memutus `curl localhost`, skrip, tes) |
| L4 | Host allowlist di `authorize()`: terima Host = host bind efektif, `localhost`, `127.0.0.1`, `[::1]`, atau entri `WEBTERM_ALLOWED_HOSTS`; menutup DNS rebinding | 52 §5.3 | **Ya**: akses via IP LAN/mDNS/proxy ditolak 403 kecuali `WEBTERM_ALLOWED_HOSTS` diisi | Tanpa allowlist = T2 tetap terbuka (risiko tinggi) |
| L5 | Penyimpan secret = berkas 0600 `envSecrets.store.ts`; `Bun.secrets` dan SQLite terenkripsi ditolak | 52 K4, §6 | Tidak | — |
| L6 | Impor `.env` EKSPLISIT (pratinjau + apply), tak pernah otomatis, berkas pengguna tak disentuh; bootstrap tak diimpor; `dangerous` butuh root token | 53 K2, §6 | Tidak | Impor otomatis ditolak (lewati gerbang `dangerous`) |
| L7 | Dotenv-autoload binary DITUNDA (rilis mayor); bunfig autoload dimatikan SEKARANG di `build:binary`; tes Bun memakai `--no-env-file` | 52 K3, 53 K3/K7 | Sedikit: binary tak memuat `bunfig.toml` cwd | Biarkan bunfig (T6) |
| L8 | `ptyEnv`: sapu `TELEGRAM_BOT_TOKEN` + kunci yang nilainya identik dengan `.env` cwd (provenance); kunci provider TIDAK disapu | 51 D5, 52 §4 | **Ya** (variabel asal `.env` tak masuk PTY) | Hapus WS-EM-05 bagian provenance |
| L9 | Hapus 4 kunci mati (`CENTRAL_TOOL_BRIDGE`, `KNOWLEDGE_GRAPHIFY`, `EMBED_MODEL`, `EMBED_URL`) dari registry; hantu `CHANNEL_HMAC_SECRET` dari `redactSecrets`; alias `TELEGRAM_BOT_TOKEN`: rilis ini `warn` sekali + disapu dari PTY, rilis berikut dihapus. **Pengecualian S2:** `KNOWN_KEYS_FROZEN` dikurangi tepat 4 kunci itu, dipindah ke `RETIRED_KEYS` di tes yang sama (override lama tetap tersimpan, F8) | 51 D3, 53 S2 | Sedikit (kunci tak berefek hilang) | Pertahankan sebagai `stage: experimental` |
| L10 | Satukan dialek flag NON-keamanan: `flagOn` menerima `on`/`1`/`true`; `LOG_FILE` mati bila `off`/`0`/`false`; `WEBTERM_CHANNELS` `1/true`->on, `0/false`->off, asing tetap fail-closed. Tiga kunci keamanan tetap `=== '1'`. UI tetap menulis `on`/`off` | 51 D7 | **Ya** (`WEBTERM_X=1` sebelumnya senyap off, kini on) | Cabut WS-EM-11; dokumentasikan dialek |
| L11 | **Keputusan user (produk):** fitur berkas `FILES_VIEWERS/WATCH/GIT_STATUS/QUICK_OPEN` default `on` (baca-saja) pada zero-config; `MUTATE`/`UPLOAD` tetap off. Env/override eksplisit tetap menang | 51 D4 | **Ya** (fitur berkas terlihat tanpa konfigurasi) | Cabut WS-EM-08 |
| L12 | `VITE_WEBTERM_CENTRAL_CHAT` diganti state server `WEBTERM_CENTRAL_CHAT`; state belum termuat = off | 51 D6, 53 K5 | Sedikit (panel kontrol tak lagi bergantung build) | Biarkan flag build |
| L13 | Data dir `0700`, `webterm.db`/log `0600`; instalasi lama di-`chmod` hanya bila dimiliki uid proses | 52 T4 | **Ya** (uid lain/backup tak lagi bisa membaca) | Biarkan umask |
| L14 | **Celah G1** (kunci `dangerous` di loopback tanpa token) — rekomendasi Opsi P, §4 | 52 T3, 53 G1 | **Ya**, keamanan | Opsi R atau biarkan terkunci |
| L15 | Tombol restart UI ditunda; README hanya bagian kontrak env, baris per-fitur DIFLAG (Rule 16) | 53 K4/K6 | Tidak | — |

## 4. Celah G1 — dua opsi, rekomendasi tegas (keputusan user: mengubah perilaku keamanan)

Masalah: loopback tanpa token -> `rootGate` salah -> 14 kunci `dangerous` tak bisa dinyalakan dari UI; satu-satunya jalan = env (menggagalkan tujuan).

| Opsi | Desain | Untung | Rugi |
|---|---|---|---|
| **P (rekomendasi)** token opt-in dari Settings | `POST /api/settings/token/enable` (hanya bila belum ada token, hanya dari peer loopback, lolos `authorize` + Host allowlist): bangkitkan + persist 0600, `writeTokenToEnv` + token hidup menjadi aktif seketika; token ditampilkan SEKALI di respons (pengecualian S5 yang disengaja, satu-satunya). Sesudahnya `rootGate` benar, `dangerous` terbuka. `rotate` = hapus berkas + bangkitkan ulang | Tak melemahkan apa pun: sebelum opt-in sama dengan sekarang; sesudahnya LEBIH ketat. Nol env | Pemanggil lokal pertama bisa mengaktifkan token; setara T1 (ia sudah punya shell via `/ws`), tak ada eskalasi baru. Tab baru = tempel token |
| R: root-gate terpisah (kode admin) | Berkas `secrets/ADMIN_CODE` dibuat saat boot loopback, TIDAK menegakkan transport; PUT `dangerous` butuh header `x-webterm-admin` | Loopback tetap tanpa login | UI tak bisa memperoleh kode tanpa API yang mengungkapnya (ungkapan lewat API = tak ada proteksi); harus ditempel dari TTY -> UX lebih buruk dari P; dua rahasia |

Tolak: `dangerous` tanpa token (agen shell sesama mesin bisa menyalakan orkestrator). Kontrak P: WS-EM-15 dan (b).

## 5. Kandidat RND: DIEKSEKUSI vs DITUNDA

| Kandidat | Status | Alasan / pemicu |
|---|---|---|
| 52 W1 Host allowlist · W2 token bootstrap · W3 perms · W4 dotenv/PTY/bunfig · W5 galat · W6 token opt-in (server) · W7 docs | **DIEKSEKUSI** (WS-EM-01/02/03/05/06/14/15/16) | Menutup T1-T9  |
| 53 EL-01 (server/shared) · EL-02 (server) · EL-03 · EL-04 · EL-05 · EL-07 · EL-08 | **DIEKSEKUSI** (WS-EM-07/12/05/09/13/06/16) | Sisi UI EL-01/02/06 -> §7 |
| 51 WS-A/B/C/E/G/H | **DIEKSEKUSI** (WS-EM-04/10/11/08/16/14) | Bersih-bersih + tes zero-config |
| `--no-compile-autoload-dotenv` (K3) | DITUNDA | Rilis mayor, setelah impor terbukti dipakai |
| Opsi B/C presedensi, `config.json`, `env-first`, tombol restart, `WEBTERM_TOKEN_FILE`, `Bun.secrets`, cookie sesi `HttpOnly` | DITOLAK/DITUNDA | 53 §5, K4, L5 |

## 6. Peta workstream (WS-EM-nn), gelombang, branch

Branch integrasi `chore/envmin-int` (dari `main`). Tiap WS: `feature|fix|chore/envmin-<nama>` dari int; worker `wkr-envmin-<nama>-01`. Orkestrator merge WS -> int setelah review `git diff`; merge ke `main` hanya atas perintah user. Worker dilarang commit/push/ganti branch. Aturan emas: `src/server/index.ts` hanya disentuh WS-EM-14 (W2) lalu WS-EM-15 (W3); WS lain menyerahkan fungsi murni + tes dan tidak menyentuhnya.

| Gel. | WS | Nama (branch `envmin-`) | Isi (sumber) | Ukuran | Bergantung |
|---|---|---|---|---|---|
| W0 | EM-01 | `hostcheck` | Allowlist Host murni + `authorize()` menerimanya (52 W1) | S | — |
| W0 | EM-02 | `token-bootstrap` | `tokenBootstrap.ts`: baca/bangkitkan/persist token + `tokenState` mutable + cetak TTY (52 W2) | M | — |
| W0 | EM-03 | `data-perms` | Data dir 0700, db/log 0600 (52 W3, L13) | S | — |
| W0 | EM-04 | `registry-clean` | 4 kunci mati, hantu HMAC, `WEBTERM_ALLOWED_HOSTS` di `BOOTSTRAP_ONLY_KEYS` (51 WS-A, L9) | S | — |
| W0 | EM-05 | `dotenv-hygiene` | `dotenvFiles.ts`, provenance `ptyEnv`, sapu alias, notis boot (52 W4 + EL-03) | M | — |
| W0 | EM-06 | `tooling-flags` | `test:bun --no-env-file`, `build:binary --no-compile-autoload-bunfig`, `CLAUDE.md` (EL-07, L7) | S | — |
| W0 | EM-07 | `provenance` | `envShadowed` + `sourceOf` mengenali `*_FILE` (EL-01 server/shared) | S | — |
| W0 | EM-08 | `files-defaults` | Default `on` 4 flag baca-saja (51 WS-E, L11) | S | — |
| W1 | EM-09 | `default-invariants` | Tes default registry == default pembaca; larangan env tingkat-modul (EL-04) | S | 04, 08 |
| W1 | EM-10 | `legacy-alias` | Alias `TELEGRAM_BOT_TOKEN`: `warn` sekali (51 WS-B, L9) | S | 05 |
| W1 | EM-11 | `flag-dialect` | Dialek flag seragam (51 WS-C, L10) | M | 07 |
| W1 | EM-12 | `import-env` | Impor `.env` dry-run + apply, server saja (EL-02) | M | 05, 07 |
| W1 | EM-13 | `central-flag` | `VITE_WEBTERM_CENTRAL_CHAT` -> state server, non-visual (EL-05, L12) | S | — |
| W2 | EM-14 | `boot-wiring` | Kabel `index.ts` (host, token, listen error), `PORT` invalid, tes boot `env -i` (52 W5, 51 WS-H) | M | 01, 02, 03, 05 |
| W3 | EM-15 | `token-optin` | Endpoint token status/enable/rotate (52 W6 server, Opsi P) | M | 02, 14 |
| W4 | EM-16 | `docs` | `.env.example` mini, README terbatas, CHANGELOG, `docs/decisions/env-minimal.md` (EL-08, 52 W7) | S | semua |

Dispatch: W0 = delapan worker dalam SATU pesan; W1 = lima; tiap gelombang menunggu merge + gerbang hijau (§9).

## 7. Kepemilikan file eksklusif (jatah baris, Rule 8)

Kolom: sekarang (baris/karakter) -> batas kerja. Batas: service 300 · utility 200 · test 400 · hard 500/20.000. Tak ada dua WS segelombang pada berkas yang sama.

| File | Pemilik | Aksi | Sekarang | Batas kerja |
|---|---|---|---|---|
| `src/server/hostAllow.ts` (+`.test.ts`) | EM-01 | BARU | — | ~60 / ~100 |
| `src/server/auth.ts` | EM-01 | `authorize()` + opsi `allowedHosts` | 186/9.448 | maks +14 |
| `src/server/auth.host.test.ts` | EM-01 | BARU (jangan sentuh `auth.test.ts` 470) | — | ~90 |
| `src/server/tokenBootstrap.ts` (+`.test.ts`) | EM-02 | BARU | — | ~140 / ~160 |
| `src/server/config.ts` · `db.ts` | EM-03 | mode 0700/0600 | 13/351 · 130/5.024 | maks +14 · +12 |
| `src/server/dataPerms.bun.test.ts` | EM-03 | BARU | — | ~80 |
| `src/server/envRegistry.ts` · `envRegistry.ca2.ts` | EM-04 | +1 kunci bootstrap · -4 spec | 43/1.723 · 59/6.689 | +2 · -15 |
| `src/server/envRegistry.invariants.test.ts` · `envRegistry.test.ts` | EM-04 | `RETIRED_KEYS`, hitung bootstrap 11, buang rujukan 4 kunci | 205/11.278 · 200/12.604 | ±10 · -6 |
| `src/server/redactSecrets.ts` (+`.test.ts`) | EM-04 | buang hantu HMAC | 78/3.871 · 190/8.099 | -1 · ±4 |
| `src/server/dotenvFiles.ts` (+`.test.ts`) | EM-05 | BARU: baca `.env*` cwd dalam memori | — | ~70 / ~100 |
| `src/server/ptyShell.ts` (+`.test.ts`) | EM-05 | provenance + sapu alias | 94/4.728 · 96/4.706 | maks +22 · +45 |
| `src/server/envSettings.runtime.ts` | EM-05 | notis `.env` sekali per boot | 38/1.627 | maks +16 |
| `src/server/envSettings.dotenvNotice.test.ts` | EM-05 | BARU | — | ~60 |
| `package.json` · `CLAUDE.md` | EM-06 | skrip + perintah tes | 53/1.560 · 54/2.712 | ±3 · ±4 |
| `src/server/envSettings.state.ts` · `shared/envSettings.contract.ts` | EM-07 (W0), EM-11 (W1, maks 3 baris) | `envShadowed`, alias `*_FILE` | 97/4.802 · 93/3.446 | +15 · +6 |
| `src/server/envSettings.state.test.ts` | EM-07 | tes provenance | 117/6.278 | +40 |
| `src/server/envRegistry.files.ts` (+`.test.ts`) | EM-08 | default `on` | 53/3.345 · 44/2.404 | +10 · +20 |
| `src/server/envRegistry.defaults.test.ts` · `envModuleRead.test.ts` | EM-09 | BARU | — | ~120 · ~60 |
| `src/server/envRegistry.channels.ts` | EM-09 | sinkron default bila selisih | 63/3.490 | ±3 |
| `src/server/channels/telegramSend.ts` · `telegram.ts` | EM-10 | `warn` alias sekali | 217/7.943 · 108/3.967 | +8 · 0 |
| `src/server/channels/telegramSender.legacy.test.ts` | EM-10 | BARU (`telegramSender.test.ts` 392 jangan ditambah) | — | ~50 |
| `src/server/envFlag.ts` (+`.test.ts`) | EM-11 | dialek | 7/318 · 28/1.259 | +8 · +30 |
| `src/server/logs/logger.ts` · `channels/channelsMasterGate.ts` | EM-11 | baca flag seragam | 120/5.113 · 22/1.163 | ±3 · +4 |
| `src/server/channels/channelsMasterGate.dialect.test.ts` | EM-11 | BARU | — | ~45 |
| `src/server/envSettings.import.ts` (+`.test.ts`) | EM-12 | BARU | — | ~150 / ~220 |
| `src/shared/envSettings.import.contract.ts` | EM-12 | BARU: tipe pratinjau | — | ~40 |
| `src/server/envSettings.api.ts` (+`.test.ts`) | EM-12 | rute `/import` | 59/2.717 · 84/4.056 | +20 · +40 |
| `src/client/central/centralControlApi.ts` · `CentralControlPanel.tsx` · `centralHost.test.tsx` | EM-13 | flag dari state server | 104/6.416 · 62/3.101 · 92/4.820 | ±10 · ±6 · ±15 |
| `src/server/index.ts` | EM-14 (W2), EM-15 (W3) | kabel | 259/13.642 | EM-14 maks +30 baris/+1.800 kar; EM-15 maks +8 |
| `src/server/serverConfig.ts` · `listenError.ts` (+tes) | EM-14 | `PORT` invalid, EADDRINUSE ramah | 12/555 · baru | ≤40 · ~30 |
| `src/server/boot.zeroenv.bun.test.ts` | EM-14 | BARU: spawn `env -i` | — | ~160 |
| `src/server/tokenAccess.api.ts` (+`.test.ts`) | EM-15 | BARU | — | ~110 / ~160 |
| `src/server/settingsApi.ts` | EM-15 | pasang rute | 75/3.377 | maks +6 |
| `.env.example` · `README.md` · `CHANGELOG.md` · `docs/decisions/env-minimal.md` | EM-16 | edit terbatas | 131 · 133/17.035 · 205 · baru | ~12 baris · net karakter ≤ 0 · +entri · ≤150 |

**TIDAK disentuh siapa pun:** `envSecrets.store.ts`, `envSettings.service/validate/store.ts`, registry lain, `Env*.tsx`/`Channels*.tsx`/`Settings*.tsx` (CHENV), `Dock.tsx`, `shared/protocol.ts`, `pty.ts`, `src/server/browser/`. **Tidak ada migrasi** (Rule 4 tidak terpicu: tak ada perubahan skema; token/secret = berkas, override = blob JSON yang ada).

## 8. Migrasi dan kompat (ringkas; rinci + rollback di b)

| Hal | Perilaku |
|---|---|
| `.env` lama | Tetap dimuat dan berlaku (env > default); boot `warn` sekali (nama kunci saja); impor eksplisit (L6) memindahkan ke override |
| Override/secret tersimpan | Utuh; kunci terpensiun tetap di blob (F8); format tak berubah |
| Loopback tanpa token · non-loopback dengan `WEBTERM_TOKEN` | Identik dengan sekarang (loopback sampai opt-in, Opsi P; env menang atas berkas) |
| Akses via IP LAN/proxy | BERUBAH (L4): wajib `WEBTERM_ALLOWED_HOSTS`; log memuat host saja |
| `WEBTERM_X=1` flag non-keamanan | BERUBAH (L10): kini on; `on`/`off` tak berubah |

## 9. Gerbang per gelombang dan stop-gate (ringkas; lengkap di b)

Gerbang tiap WS: `TMPDIR=/tmp/st npm run typecheck` · `TMPDIR=/tmp/st npm test` · `TMPDIR=/tmp/st bun test --no-env-file src/server/*.bun.test.ts` (sebelum EM-06 merge: tanpa flag, dari cwd tanpa `.env`). Gerbang gelombang: ketiganya pada branch int.

| Stop-gate | Kondisi (berhenti dan lapor) |
|---|---|
| S1 | `service.test.ts:17,31,202` perlu diubah (presedensi bergeser) |
| S2 | `KNOWN_KEYS_FROZEN` berubah SELAIN tepat 4 kunci L9 -> `RETIRED_KEYS` |
| S3 | tes/kode menulis ke `~/.webterm-server` atau membaca `.env` nyata pengguna |
| S4 | impor menulis kunci bootstrap atau melewati `dangerous` + root |
| S5 | nilai secret di log/pesan galat/respons API (satu-satunya pengecualian: respons `enable` token, sekali) |
| S6 | `env -i` + `WEBTERM_DATA_DIR=/tmp/...` gagal boot (setelah EM-14) |
| S7 | perubahan keamanan (L3/L4/L13/G1) di luar tabel §3-4 atau tanpa tes asersi |

## 10. DITANGGUHKAN ke PLAN CHENV (UI Settings Channels/Environment minimal)

Plan ini TIDAK mengubah `Env*.tsx`, `Channels*.tsx`, kartu run-pertama, atau teks UI. WS server menyediakan kontrak yang HARUS dipenuhi; CHENV mengonsumsinya. Perubahan kontrak = lewat orkestrator.

| ID | Pekerjaan UI (ditangguhkan) | Asal | Kontrak server/shared (penyedia) |
|---|---|---|---|
| DU-1 | Lencana "env diabaikan, override aktif" per entri | EL-01 | `EnvEntryV2.envShadowed?: boolean` (opsional, hanya ditambah) di `shared/envSettings.contract.ts`; benar bila override/secret aktif DAN env proses (snapshot `base`) berisi nilai berbeda. Penyedia: EM-07 |
| DU-2 | Tombol "Impor dari .env" + dialog pratinjau + konfirmasi | EL-02 | `POST /api/settings/env/import` body `{ apply?: boolean }` (default dry-run) -> `{ items: { key, action: 'add'\|'same'\|'conflict'\|'skip', dangerous, secret }[], applied?: number, restartRequired?: string[] }`; TANPA nilai; berkas tetap cwd `.env` (bukan input pengguna); `dangerous` tanpa root = `skip`. Tipe di `shared/envSettings.import.contract.ts`. Penyedia: EM-12 |
| DU-3 | Kartu run-pertama (18 kunci `audience:user`, sisanya "Lanjutan") | EL-06 | Tanpa API baru: `audience` ada di `EnvEntryV2`; kartu tampil bila belum ada override. Butuh DU-4 |
| DU-4 | Tombol "Aktifkan token akses" / "Putar token" + layar tempel token | W6 | `GET /api/settings/token` -> `{ enforced: boolean, source: 'env'\|'file'\|'none', canEnable: boolean }`; `POST /api/settings/token/enable` -> `{ token }` (SEKALI, `Cache-Control: no-store`); `POST /api/settings/token/rotate` (butuh token berlaku) -> `{ token }`. Penyedia: EM-15. `Login.tsx` sudah ada |
| DU-5 | Teks banner restart per mode (dev/biner/service) | EL-06 | Tanpa API baru: `restartRequired` di respons PUT sudah ada |
| DU-6 | Pesan `noRootGate` di `EnvServerCard` mengarah ke DU-4 | G1 | Memakai `GET /api/settings/token` (`enforced`) |
| DU-7 | (opsional) pesan "Host ditolak" | L4 | 403 `{ "error": "host_not_allowed" }`, header tak dipantulkan |

CHENV tidak boleh menambah kunci registry atau mengubah presedensi tanpa lewat plan ini.

## 11. Di luar plan (diflag, Rule 21)

Env penuh ke spawn `nameGen`/`memoryFilePath`/`gitInfo`/`fsGit` (53 §3); `goldenHarness.ts` memutasi `process.env` tanpa restore; cookie sesi `HttpOnly`. `README.md` di 85% batas: EM-16 net-negatif; ragu editorial = flag.
