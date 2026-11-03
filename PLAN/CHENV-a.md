# CHENV-a — Rencana kerja: desain ulang Settings "Channels" & "Environment"

Dokumen perencana (a): keputusan, inventori, peta workstream, kepemilikan file, stop-gate, urutan
terhadap envmin. Kontrak teknis rinci (bentuk JSON, daftar `reason`, matriks tes) = `CHENV-b.md`.
Kalau a dan b bentrok, orkestrator memutus; ID `C*`, `CH-*`, `S-C*` milik dokumen ini.
Label: **[V]** terverifikasi di kode saat ini, **[RND]** dari RND/54-55, **[BT]** belum terbukti
(worker wajib memverifikasi sebelum menulis kode). Basis kode = `chore/envmin-int` (envmin W0+W1).

## 1. Ringkasan & kriteria sukses

Masalah: tab Channels memajang 9 key env (termasuk master `CHANNELS`, mode, rahasia webhook) dan
tab Environment 53 key (13 terbuka + 40 di fold "Lanjutan"); banyak key adalah angka tuning,
bendera internal, atau nama env mentah. Pengguna tidak bisa membedakan "yang harus kuisi" dari
"yang cuma ada". Tujuan: tampilkan hanya yang berguna, sambungkan Telegram dalam satu kartu.

| # | Kriteria terukur | Sekarang [V] | Target |
|---|---|---|---|
| M1 | Baris setting terbuka secara default (tanpa buka fold) | 22 (9 Channels + 13 Environment) | 12 (3 Integrasi + 9 Server & fitur) |
| M2 | Baris yang dapat dijangkau lewat UI (termasuk Lanjutan) | 62 | 43 (12 utama + 31 Lanjutan) |
| M3 | Key disembunyikan dari UI (hanya env/`.env`) | 0 | 19 (tetap ada di registry) |
| M4 | Key terlihat tanpa pengaruh nyata di runtime | belum diaudit penuh | 0: tes konsumen (CH-01) |
| M5 | Teks UI berbahasa Inggris (label, aria-label, title) di dua section | ada (mis. "Section settings", "Environment") | 0 (K4) |
| M6 | Status Telegram menyebut penyebab ("Token ditolak", "Menunggu mulai ulang") | 404 = 4 penyebab tak terbedakan | 7 status berpenyebab |
| M7 | Nama env mentah di baris utama | semua baris menampilkan `<code>KEY</code>` | hanya di Lanjutan/tooltip |

Semua gerbang hijau di tiap WS: `TMPDIR=/tmp/st npm run typecheck`, `TMPDIR=/tmp/st npm test`,
`TMPDIR=/tmp/st bun test --no-env-file src/server/*.bun.test.ts`.

## 2. Keputusan terkunci

| ID | Keputusan | Ubah perilaku? | Bila diveto |
|---|---|---|---|
| K1 | Master `WEBTERM_CHANNELS` pindah ke Lanjutan | UI saja | tetap di kartu Telegram |
| K2 | Sidebar: "Integrasi" (ex Channels), "Server & fitur" (ex Environment) | UI saja | - |
| K3 | Tombol "Tes koneksi" + "Hapus token" | tambah endpoint tes (CH-02) | - |
| K4 | Semua label Indonesia, termasuk aria-label/title | UI saja | - |
| K5 | Webhook (mode + rahasia) hanya di Lanjutan | UI saja | - |
| K6 | Badge "Dari .env" hanya bila nilai terkunci oleh env | UI saja | - |
| K7 | Wizard menautkan chat DITUNDA | - | - |
| C1 | Satu kartu "Telegram": saklar Aktif (`WEBTERM_TELEGRAM`), kolom token, status, Tes koneksi, Hapus token. `CHANNELS` default on, tak perlu disentuh | UI | kembali ke 3 baris terpisah |
| C2 | Status memakai field baru `reason` di respons status; 404 lama dipertahankan agar klien lama tidak pecah | tambahan aditif | - |
| C3 | "Tes koneksi" memakai token TERSIMPAN di server (`getMe`), body tanpa token, respons `{ok, botUsername?, reason}` tanpa token | endpoint baru | - |
| C4 | "Hapus token" = hapus override token saja. Bila token datang dari env: tombol nonaktif + badge "Dari .env" (K6) | UI | - |
| C5 | Audience `user`->`advanced` untuk `CHANNELS`, `TELEGRAM_MODE`, `CENTRAL_CHAT`, `CENTRAL_PLANNER`, `CENTRAL_TOOLS`, `CENTRAL_MEMORY` | metadata registry | - |
| C6 | Perbaiki `requires`: `TELEGRAM_WEBHOOK_SECRET` mode `['webhook']` (bukan `['webhook','']`); `CENTRAL_TELEGRAM` runtime tak boleh menolak `claude` [BT: cocokkan dgn `buildTelegramCentralPort` yg hanya menolak `off`] | metadata | - |
| C7 | Kunci tak dihapus dari registry hanya karena disembunyikan; `KNOWN_KEYS_FROZEN` tak berubah | - | - |
| C8 | Daftar sembunyi = konstanta klien `UI_HIDDEN_KEYS` (file baru `envUiHidden.ts`). Key tersembunyi yang punya override aktif tetap muncul di Lanjutan agar bisa direset | UI | - |
| C9 | "Dari .env" (K6) muncul bila `source==='env'` DAN terkunci/tak bisa diedit. Badge terpisah "Diabaikan (.env)" untuk `envShadowed` (DU-1) hanya di Lanjutan | UI | - |
| C10 | Nama env mentah hanya di grup Lanjutan atau tooltip; baris utama memakai label Indonesia | UI | - |
| C11 | Kartu Telegram wajib ikut pencarian Settings (hook `useChannels` diberi opsi `enabled`, bukan `return null`) | UI | - |
| C12 | Nama protokol `nodeterm:`/`NODETERM_*`/`x-nodeterm-node-token` TIDAK diubah | - | - |
| C13 | Tombol/aksi token tak pernah menampilkan nilai token; kolom tulis-saja tetap (kontrak tes `ChannelsTelegramConfig.test.tsx`) | - | - |
| C14 | Tuning, flag internal CA2 dan flag file diperlakukan sesuai inventori sec.3 | UI | lihat Q3 |
| C15 | Satu worker per file per gelombang; dokumen rangkuman (README/CHANGELOG/decision) satu worker di akhir (CH-11) | - | - |
| C16 | Hot-apply poller saat token disimpan (CH-03): batasi ke runtime yang SUDAH berjalan; aktivasi pertama (`TELEGRAM` off -> on) tetap butuh mulai ulang dgn banner jujur | perilaku server | [KEPUTUSAN USER] Q1 |
| C17 | Sambil CH-03 belum merge, `restart` token di registry tetap dilabeli jujur ("Perlu mulai ulang") agar tak mengklaim `hot` | metadata | - |

[KEPUTUSAN USER]: C16 (Q1), C14 bagian sembunyikan 19 key (Q3). Sisanya diputuskan perencana.

## 3. Inventori: nasib tiap key (62 entri registry [V])

Prefix `WEBTERM_` dihilangkan. Hasil: **Utama 12 · Lanjutan 31 · Env-saja 19 = 62**.

### 3a. Tab Channels sekarang -> Integrasi (9 key)
| Key | Sekarang | Nasib | Alasan |
|---|---|---|---|
| TELEGRAM | user, boot | UTAMA (saklar "Aktif") | satu-satunya sakelar yang dimengerti pengguna |
| TELEGRAM_BOT_TOKEN | secret, user, hot* | UTAMA (kolom token + Tes koneksi + Hapus) | input wajib; *`hot` belum benar sampai CH-03 [V] |
| CENTRAL_TELEGRAM | user, boot | UTAMA bersyarat (hanya bila Central aktif) | tak ada gunanya tanpa Central |
| CHANNELS | user, boot, default on | Lanjutan (K1) | master default on; mengisinya hanya mematikan semua kanal |
| TELEGRAM_MODE | user, boot | Lanjutan (K5) | auto: token ada = poll; webhook jarang |
| TELEGRAM_WEBHOOK_SECRET | secret, adv | Lanjutan, tampil bila mode webhook eksplisit | tak relevan di poll; perbaiki `requires` (C6) |
| CENTRAL_BOTS | adv (owner channels) | Lanjutan | bot terkelola; fitur lanjutan |
| CHANNEL_APPROVAL_BUTTONS | adv (owner channels) | Lanjutan | tombol setuju; jarang diubah |
| TRUST_PROXY | adv (owner channels) | Env-saja | konfigurasi deploy di balik proxy, bukan preferensi |

### 3b. Tab Environment sekarang -> Server & fitur (53 key)
| Key(s) | Nasib | Alasan |
|---|---|---|
| LEDGER | UTAMA | prasyarat Central/kanal; satu sakelar penting |
| CENTRAL, CENTRAL_RUNTIME, CENTRAL_AUTONOMY | UTAMA | inti fitur Central |
| ORCHESTRATOR_RUN, RUN_REQUIRE_APPROVAL | UTAMA | pengaman eksekusi yang user pahami |
| MEMORY_FILES, BROWSER, FILES_MUTATE | UTAMA | tiga fitur dengan efek terlihat |
| CENTRAL_CHAT, CENTRAL_PLANNER, CENTRAL_TOOLS, CENTRAL_MEMORY | Lanjutan (C5) | sub-fitur Central; hubungan CHAT vs CENTRAL [BT], tidak digabung (Q2) |
| CENTRAL_MODEL, OPENCODE_BIN, OPENCODE_ALLOW_TOOLS, CENTRAL_AGENTS | Lanjutan | untuk yang paham runtime |
| CENTRAL_DAILY_TOKENS, _SPAWNS, _COST_MICROS | Lanjutan | batas biaya; arti `COST_MICROS=0` [BT] |
| CENTRAL_CHECKPOINT, _SKILLS, _SKILL_PROPOSE, KNOWLEDGE, AGENT_MAIL, CENTRAL_READ_TOOLS, CENTRAL_RELIABILITY | Lanjutan (grup "Agen central") | 7 flag CA2; efek nyata tapi spesialis. Tidak digabung (Q4) |
| MEMORY_DIR, CONTROL_CWD_ROOTS, LOG_LEVEL | Lanjutan | path/batas; berguna tapi jarang |
| BROWSER_BIN, BROWSER_AGENT, BROWSER_ALLOW_HOSTS, BROWSER_COOKIE_IMPORT | Lanjutan | sub-opsi BROWSER; cookie import berbahaya |
| FILES_UPLOAD | Lanjutan | pasangan FILES_MUTATE |
| CENTRAL_MAX_STEPS, CENTRAL_TURN_STEPS, CENTRAL_TURN_WALL_MS, CENTRAL_TURN_TOKENS, CENTRAL_CONTEXT_WINDOW, CENTRAL_MAX_INFLIGHT, AGENT_IDLE_DONE_MS | Env-saja (7) | angka tuning; default waras; MAX_STEPS vs TURN_STEPS bertumpang [BT] |
| LOG_BUFFER, LOG_FILE | Env-saja (2) | tuning log; tak ada alasan pengguna mengubahnya di UI |
| BROWSER_MAX_LIVE, BROWSER_DISCARD_MS, BROWSER_COOKIE_TTL_DAYS | Env-saja (3) | tuning browser |
| FILES_LIST_MAX, FILES_UPLOAD_MAX_MB | Env-saja (2) | batas teknis |
| FILES_VIEWERS, FILES_WATCH, FILES_GIT_STATUS, FILES_QUICK_OPEN | Env-saja (4) | default on sejak EM-08; sakelar mati tak berguna di UI |

Penghitungan: Utama = 3 (Integrasi) + 9 (Server). Lanjutan = 5 (Integrasi: CHANNELS, MODE,
WEBHOOK_SECRET, CENTRAL_BOTS, CHANNEL_APPROVAL_BUTTONS) + 26 (Server). Env-saja = 18 + TRUST_PROXY.
Empat key mati sudah dihapus envmin EM-04; tak ada lagi kategori "hapus" (0).
Bukti klaim (M4): CH-01 menambah tes yang memastikan tiap key non-tersembunyi dirujuk sumber
server di luar registry [BT: bentuk tes yang stabil].

## 4. Peta workstream

Cabang integrasi: `chore/chenv-int` (dari `chore/envmin-int`). Worker `wkr-chenv-<nama>-01`; dilarang
commit/push/ganti cabang; orkestrator commit dan merge `--no-ff`. Ukuran: S <1 hari, M ~1, L >1.

| Gel. | WS | Nama / cabang | Isi | Uk. | Bergantung |
|---|---|---|---|---|---|
| W0 | CH-00 | `refactor/chenv-settings-split` · `wkr-chenv-settingssplit-01` | Pecah `SettingsPanel.tsx` (278/11.8k) tanpa ubah perilaku: `settingsSections.ts`, `SettingsNav.tsx`, `SettingsSearchHits.tsx` | S | - |
| W0 | CH-01 | `fix/chenv-registry` · `wkr-chenv-registry-01` | C5, C6, C17, label registry Indonesia [BT bila masih Inggris], tes konsumen (M4), perbarui invariants | S-M | - |
| W0 | CH-02 | `feature/chenv-telegram-status` · `wkr-chenv-tgstatus-01` | Field `reason` di status (aditif, 404 tetap), endpoint "Tes koneksi" (`getMe`, token tersimpan), tes server | M | - |
| W1 | CH-04 | `feature/chenv-shell` · `wkr-chenv-shell-01` | K2/K4: rename sidebar, "Server & fitur", aria Indonesia, `UI_HIDDEN_KEYS` (C8), partisi Utama/Lanjutan, C10 | M | CH-00, CH-01 |
| W1 | CH-06 | `feature/chenv-provenance` · `wkr-chenv-badge-01` | K6/C9 (DU-1): logika badge di `EnvBadges.tsx`, tes baru | S | - |
| W2 | CH-05 | `feature/chenv-telegram-card` · `wkr-chenv-tgcard-01` | Kartu Telegram tunggal (C1-C4, C11, C13), status berpenyebab, Tes koneksi/Hapus token, pencarian | M-L | CH-02, CH-04 |
| W2 | CH-08 | `feature/chenv-import-ui` · `wkr-chenv-import-01` | UI impor `.env` (DU-2): pratinjau item, konflik, terapkan; endpoint sudah ada (EM-12) | M | CH-04 |
| W3 | CH-03 | `feature/chenv-hot-token` · `wkr-chenv-hottoken-01` | Hot-apply poller pada token baru bila runtime sudah jalan (C16) | M-L | EM-15 merge, CH-02, Q1 |
| W3 | CH-07 | `feature/chenv-token-optin` · `wkr-chenv-tokenui-01` | DU-4/DU-6: kartu "Aktifkan token", rotasi; DU-5 teks banner per mode; DU-7 pesan `host_not_allowed` | M | EM-15 merge, CH-05 |
| W4 | CH-09 | `feature/chenv-firstrun` · `wkr-chenv-firstrun-01` | DU-3: kartu run-pertama (bukan wizard; K7 tetap tunda) | S | CH-07 |
| W5 | CH-11 | `docs/chenv-final` · `wkr-chenv-docs-01` | README (terbatas), CHANGELOG, `docs/decisions/`; satu worker setelah semua bukti masuk | S | semua + EM-16 |

Catatan pemetaan: WS-1 RND/55 = CH-04; WS-2 = CH-05; WS-3 = CH-02; WS-4 = CH-03; WS-5 (cari + a11y)
dilebur ke CH-04/CH-05 karena menyentuh file yang sama. CH-5 audit (default file) sudah selesai di EM-08.
CH-10 sengaja tidak ada (nomor kosong demi kestabilan referensi).

## 5. Kepemilikan file eksklusif (sekarang -> batas kerja)

Batas = baris maksimum setelah WS selesai (Rule 8; tes <=400; komponen/layanan <=300). File baru
ditandai (baru). Tidak ada WS lain boleh menyentuh file di baris yang sama dalam gelombang yang sama.

| WS | File (baris sekarang -> batas) |
|---|---|
| CH-00 | `SettingsPanel.tsx` 278 -> 200; (baru) `settingsSections.ts` -> 80; (baru) `SettingsNav.tsx` -> 120; (baru) `SettingsSearchHits.tsx` -> 120; `SettingsPanel.test.tsx` 310 -> 330 (hanya impor), `SettingsPanel.envsearch.test.tsx` 106 -> 110 |
| CH-01 | `envRegistry.channels.ts` 63 -> 70; `envRegistry.central.ts` 57 -> 62; `envRegistry.ca2.ts` 53 -> 58; `envRegistry.platform.ts` 56 -> 60; `envRegistry.files.ts` 63 -> 65 (batas file registry <=100); `envRegistry.invariants.test.ts` 213 -> 300; `envRegistry.test.ts` 232 -> 300; (baru) `envRegistry.consumers.test.ts` -> 120. Tidak menyentuh `envRegistry.meta.ts`/`.types.ts` kecuali orkestrator izinkan |
| CH-02 | `channelStatus.ts` 61 -> 90; `channelStatusHttp.ts` 54 -> 110; (baru) `channelTest.api.ts` -> 120; `channelsRuntime.ts` 256 -> 266 (hanya satu rantai handler, <10 baris); tes baru `channelStatusHttp.bun.test.ts`/`channelTest.bun.test.ts` -> 250 masing-masing |
| CH-04 | `EnvSection.tsx` 117 -> 170; `envSectionLabels.ts` 32 -> 60; `envDraft.ts` 97 -> 150; `envLabels.ts` 46 -> 70; `EnvGroupSection.tsx` 53 -> 80; `EnvEntryRow.tsx` 81 -> 100; (baru) `envUiHidden.ts` -> 60; `settingsSections.ts`, `SettingsNav.tsx`, `SettingsSearchHits.tsx` (pasca CH-00) -> batas CH-00 +20; tes: `EnvSection.test.tsx` 157, `EnvGroupSection.test.tsx` 108, `EnvEntryRow.test.tsx` 149, `envDraft.test.ts` 134, `SettingsPanel.test.tsx` -> masing-masing <=250/<=400 |
| CH-06 | `EnvBadges.tsx` 29 -> 70; (baru) `EnvBadges.test.tsx` -> 120. Tidak menyentuh `EnvEntryRow.tsx` |
| CH-05 | `ChannelsSection.tsx` 94 -> 200; `ChannelsTelegramConfig.tsx` 83 -> 150; `ChannelsLists.tsx` 141 -> 180; `channelsLabels.ts` 65 -> 100; `channelsApi.ts` 106 -> 170; `useChannels.ts` 119 -> 170; `EnvSecretField.tsx` 37 -> 90; `settings-channels.css` 98 -> 160; `SettingsSearchHits.tsx` (pasca CH-04); tes: `ChannelsSection.test.tsx` 180, `ChannelsTelegramConfig.test.tsx` 92, `ChannelsEnvBridge.sa08.test.tsx` 105, `EnvValueControl.test.tsx` 94 (hanya bila teks `inactiveHint` berubah) -> <=400 |
| CH-08 | (baru) `EnvImportCard.tsx` -> 150; (baru) `envImportApi.ts` -> 60; (baru) `EnvImportCard.test.tsx` -> 200; `EnvSection.tsx` (pasca CH-04, hanya titik pasang <=10 baris); `settings-env.css` 219 -> 260 |
| CH-03 | `telegramPollWiring.ts` 68 -> 120; `channelSenderBoot.ts` 88 -> 120; `channelsRuntime.ts` (pasca CH-02) -> 290; `index.ts` 259 -> 270 HANYA setelah EM-15 merge dan dgn izin; tes baru -> 250 |
| CH-07 | `EnvServerCard.tsx` 23 -> 120; (baru) `TokenCard.tsx` -> 150; (baru) `tokenApi.ts` -> 80; `EnvRestartBanner.tsx` 16 -> 50; `envSettingsApi.ts` 82 -> 110; `Login.tsx` 54 -> 80 [BT perlu]; tes: `EnvServerCard.test.tsx` 31, `EnvRestartBanner.test.tsx` 44, `Login.test.tsx` 40 -> <=200; `envLabels.ts` (pasca CH-04) |
| CH-09 | (baru) `FirstRunCard.tsx` -> 120; (baru) `FirstRunCard.test.tsx` -> 150; `EnvSection.tsx` atau `SettingsPanel.tsx` titik pasang <=10 baris |
| CH-11 | `README.md`, `CHANGELOG.md`, `docs/decisions/chenv.md` (baru) saja. README ~85% dari batas karakter: edit terbatas, jangan tulis ulang (Rule 16) |

W0 tidak bentrok (client vs registry vs channels server). W1: CH-04 dan CH-06 tidak berbagi file.
W2: CH-05 dan CH-08 berbagi `EnvSection.tsx` hanya lewat titik pasang CH-08 yang kecil; CH-05 tidak
boleh menyentuhnya. W3: CH-03 (server) dan CH-07 (klien) terpisah. `envLabels.ts` berpindah tangan
berurutan CH-04 -> CH-07; `SettingsSearchHits.tsx` CH-00 -> CH-04 -> CH-05.

## 6. Stop-gate khusus (S-C*)

Semua S1..S* umum di ENV-MINIMAL-a tetap berlaku. Tambahan:

| ID | Pemicu | Tindakan |
|---|---|---|
| S-C1 | Worker mengubah file di luar tabel sec.5 atau melewati batas barisnya | STOP, lapor; orkestrator putuskan |
| S-C2 | Perubahan kontrak kawat yang bisa memecahkan klien lama (hapus/ganti field respons, ubah 404 status, ubah bentuk `EnvStateV2`) | STOP; hanya perubahan aditif yang boleh |
| S-C3 | Nama `nodeterm:`, `NODETERM_NODE_ID/PORT`, `x-nodeterm-node-token`, `~/.nodeterm*` diubah | STOP, kembalikan |
| S-C4 | Secret (token bot, rahasia webhook, token root) muncul di respons, log, DOM, snapshot tes, atau error. Pengecualian tunggal: respons `token/enable` envmin satu kali, no-store | STOP, rotasi diingatkan |
| S-C5 | Key dihapus dari `ENV_REGISTRY`, `KNOWN_KEYS_FROZEN` diedit, atau invariant dilonggarkan untuk meloloskan tes | STOP |
| S-C6 | Gerbang merah (typecheck/test/bun test) tanpa akar penyebab dan label "mitigasi sementara" | STOP |
| S-C7 | CH-03/CH-07/CH-09 mulai sebelum EM-15 merge ke `chore/envmin-int` dan disinkron ke `chore/chenv-int` | tahan sampai sinkron |
| S-C8 | Kontrak envmin yang dikonsumsi UI (DU-2/DU-4/DU-5/DU-7) berbeda dari ENV-MINIMAL-a sec.10 | STOP, minta orkestrator cocokkan dgn pemilik envmin |
| S-C9 | Tes lama bergantung teks/label (`getByLabelText('WEBTERM_TELEGRAM')`, nama tombol section, `Section settings`, `inactiveHint`) rusak dan tidak diperbarui dalam WS yang sama | STOP; perbarui tes di WS yang mengubah teks |
| S-C10 | Fitur baru tanpa tes nyata, atau UI baru tanpa `role`/`aria-live`/label Indonesia (K4) | STOP |
| S-C11 | Aksi UI mengubah perilaku di luar yang tertulis (mis. otomatis menyalakan `TELEGRAM` saat token valid, menggabungkan flag CA2) | STOP; butuh keputusan user |
| S-C12 | Laporan worker "selesai" tanpa `git diff` yang cocok | orkestrator wajib verifikasi diff sebelum menerima |

## 7. Interaksi dengan envmin

Status envmin [V]: W0+W1 sudah di `chore/envmin-int` (EM-04 key mati, EM-07 `envShadowed`, EM-08 file
default on, EM-10 alias warn, EM-11 dialek flag, EM-12 impor, EM-13 central-flag). Belum: EM-14
boot-wiring (W2, cabang ada, belum merge), EM-15 token opt-in (W3; `tokenAccess.api.ts` belum ada),
EM-16 docs (W4).

| Gelombang CHENV | Harus sudah merge | Catatan |
|---|---|---|
| W0 (CH-00, 01, 02) | basis saat ini | tak bersentuhan dgn file EM-14/15 [BT: cek `channelsRuntime.ts` oleh EM-14] |
| W1 (CH-04, 06) | W0 CHENV | `envShadowed` sudah ada |
| W2 (CH-05, 08) | CH-02, CH-04; EM-12 (sudah) | EM-14 tak diperlukan; sinkron bila EM-14 sudah merge |
| W3 (CH-03, 07) | EM-14 + EM-15 ke envmin-int, lalu envmin-int -> chenv-int | `index.ts` & kontrak `GET /api/settings/token` dikunci di sini |
| W4 (CH-09) | CH-07 | |
| W5 (CH-11) | semua CHENV + EM-16 | hindari konflik README/CHANGELOG |

Urutan global: W0 -> W1 -> W2 (paralel dgn envmin W2/W3) -> sinkron EM-14/15 -> W3 -> W4 -> EM-16 ->
W5 -> checklist pre-deploy (Rule 6) -> menunggu perintah merge/push dari user.

## 8. Pertanyaan terbuka untuk user (maks 5)

| # | Pertanyaan | Rekomendasi |
|---|---|---|
| Q1 | CH-03: hot-apply poller saat token disimpan (tanpa mulai ulang) hanya bila kanal sudah hidup, mau dikerjakan? Aktivasi pertama tetap mulai ulang | Ya. Tanpa ini "Sambungkan" jujur = "Simpan lalu mulai ulang"; tetap bisa dirilis tanpa CH-03 (C17) |
| Q2 | Gabung `CENTRAL_CHAT` ke `CENTRAL`? | Jangan; hubungan belum terbukti [BT], cukup pindah ke Lanjutan |
| Q3 | Sembunyikan 19 key tuning/internal dari UI (hanya env, tampil bila ada override)? | Ya: nol efek bagi pengguna biasa; dapat dibalik lewat `envUiHidden.ts` |
| Q4 | Tujuh flag CA2 jadi satu sakelar "Agen central penuh"? | Jangan; mengubah perilaku. Biarkan 7 flag di Lanjutan, grup "Agen central" |
| Q5 | "Hapus token" juga mematikan `TELEGRAM`? | Tidak; hanya menghapus override token. Status berganti "Belum disambung" |

## 9. [BT] yang tersisa

1. Bahasa label/deskripsi registry saat ini dan efeknya pada invariants (label <=40, desc <=160).
2. Hubungan `CENTRAL` vs `CENTRAL_CHAT`; arti `CENTRAL_DAILY_COST_MICROS=0`; `MAX_STEPS` vs `TURN_STEPS`.
3. Mekanisme hapus override secret lewat API env yang ada (cukup untuk "Hapus token"?).
4. Apakah EM-14 menyentuh `channelsRuntime.ts`/`index.ts` yang dipakai CH-02/CH-03.
5. Bentuk final `GET /api/settings/token` (EM-15) dan apakah `Login.tsx` perlu diubah (CH-07).
6. Desain hot-apply: mode di-resolve saat start (`resolveTelegramMode`), jadi token yang datang
   belakangan butuh re-resolve mode; detail ada di CHENV-b.
7. Kelayakan tes konsumen M4 yang stabil (tanpa grep rapuh).
