# 54-b — Audit 60 kunci Environment + Implikasi

Lanjutan `54-CHENV-AUDIT.md` (Channels, saklar, token, hitungan). Prefiks `WEBTERM_` dibuang dari kolom Kunci. `51:NN` = baris `RND/51-ENV-MINIMAL-INVENTORY.md` (pembaca/default/restart tidak diulang). Aud: U pengguna, O operator, D dev. `D` pada Kunci = `dangerous` (butuh root token). Label dari `server/envRegistry*.ts` (dump registry). Vonis: T = TAMPIL-SETTINGS, G = GABUNG, A = SEMBUNYI-ADVANCED, E = PINDAH-KE-ENV-SAJA, X = HAPUS. Semua bernilai nyata (ada pembaca) kecuali ditandai; verifikasi pembaca = tes invarian 6 (`server/envRegistry.invariants.test.ts:149-163`) + `51`.

## 1. Tabel kunci

### 1.1 Dasar, Central (13 kunci utama + model)

| Kunci | Label UI | Efek nyata / tumpang tindih | Aud | Vonis | Alasan |
|---|---|---|---|---|---|
| LEDGER | Ledger | `ledger/ledgerRuntime.ts:74` (`51:44`). Prasyarat Telegram dan CA2. Istilah "ledger" tak berarti bagi pengguna | U | T | Prasyarat kanal+approval. Beri nama tujuan ("Catatan proyek & approval"); opsi "Bayangan" jelaskan atau sembunyikan. Default `off` membuat Telegram mati (Keputusan D2) |
| CENTRAL | Central | `central/centralModel.ts:67` (`51:57`) | U | T | Saklar utama fitur Central |
| CENTRAL_CHAT | Central chat | `centralChatApi.ts:49` (`51:58`). Tumpang tindih dengan CENTRAL: butuh CENTRAL on; perbedaan nilai bagi pengguna tak jelas `[BT]` | U | G | Satu saklar "Central"; CHAT tetap dibaca. Syarat: pastikan tak ada skenario sah CENTRAL on + CHAT off yang berguna `[BT]` |
| CENTRAL_RUNTIME | Mesin agen central | `runtimeFlag.ts:19,26`; `codex` ada di `SUPPORTED` tapi `buildService` null (`51:59`); `mock` untuk dev | U | T | Pilihan nyata (Claude/OpenCode/Mati). Sembunyikan `mock`/`codex` dari opsi UI `[opini]`; perbaiki `requires` yang menolak `claude` (54 T2) |
| CENTRAL_MODEL | Model (OpenCode / Claude) | `opencodeOptions.ts:56`, `claudeRuntime.ts:142` (`51:60`). String bebas, tanpa daftar | O | A | Dikosongkan = default runtime. Teks bebas rawan salah ketik |
| CENTRAL_PLANNER | Central planner | `chat/turnService.ts:117-123` (`51:61`). Label "planner" tak jelas | O | A | Kemampuan tuning; default off sudah aman |
| CENTRAL_TOOLS | Tools central | idem; `read\|write` (`51:61`). `write` memberi tulis ke Central; mirip OPENCODE_ALLOW_TOOLS | O | A | Dua kunci "izinkan tool tulis" berbeda (TOOLS dan OPENCODE_ALLOW_TOOLS) membingungkan; satukan konsep di Topik 2 |
| CENTRAL_MEMORY | Memori central | `turnService.ts:117-123` (`51:61`). Nama mirip MEMORY_FILES (fitur berbeda) | O | A | Tumpang tindih nama dengan MEMORY_FILES; jelaskan atau gabungkan sebagai "Memori" |
| CENTRAL_AUTONOMY D | Otonomi central | `centralAutonomy.ts:100`, `centralAutonomyBoot.ts:43` (`51:62`). Locked tanpa root token (`51:13`) | U | T | Kemampuan inti CA2. Tampil dengan peringatan + alasan terkunci |
| OPENCODE_BIN D | Biner opencode | `opencodeOptions.ts:61` (`51:63`) | O | A | Auto-detect PATH; relevan hanya runtime opencode (tampilkan bersyarat) |
| OPENCODE_ALLOW_TOOLS D | Izinkan tool mutasi opencode | `opencodeOptions.ts:67` (`51:63`) | O | A | Keamanan operator; bersyarat runtime opencode |

### 1.2 Central — agen (batch CA2, audience `advanced` semua)

| Kunci | Label UI | Efek nyata / tumpang tindih | Aud | Vonis | Alasan |
|---|---|---|---|---|---|
| CENTRAL_AGENTS D | Agen central | `ca2Boot.ts:42-53` (`51:64`). Saklar master CA2 | O | T | Satu saklar "Agen central" untuk paket CA2; terkunci tanpa token (`51:13`) |
| CENTRAL_CHECKPOINT | Checkpoint percakapan | `ca2Boot.ts:42-53,122-132` (`51:65`) | O | G | Bagian paket CA2; granular tetap via env |
| CENTRAL_SKILLS | Skill central | idem | O | G | idem |
| CENTRAL_SKILL_PROPOSE | Usul skill central | idem; butuh SKILLS `[BT]` | O | G | idem |
| CENTRAL_BOTS | Bot per project | `ca2.ts:37` requires TELEGRAM+CHANNELS | O | G | Bagian paket; bergantung kanal Telegram |
| KNOWLEDGE | Knowledge base | `contextAssembler.ts:87` (`51:65`) | O | G | Bagian paket |
| AGENT_MAIL | Mailbox agen | `51:65` | O | G | Bagian paket |
| CENTRAL_READ_TOOLS | Tool baca central | `51:65`. Tumpang tindih dengan CENTRAL_TOOLS=read | O | G | Dua kunci untuk gagasan serupa; pastikan hubungan sebelum dijadikan sub-opsi `[BT]` |
| CENTRAL_RELIABILITY | Reliabilitas autonomy | `autonomyDispatch.ts:19` (`51:65`) | O | G | Bagian paket |
| CHANNEL_APPROVAL_BUTTONS | Tombol approval Telegram | `channelButtons.ts:60` (`51:51`); owner `central` padahal fitur Telegram (`ca2.ts:38`) | O | G | Pindah ke kartu Telegram; nyalakan otomatis bila Telegram on (Keputusan D4) |
| CENTRAL_MAX_STEPS | Langkah maks per turn | `toolLoop.ts:18` (`51:66`). Nama hampir sama dengan TURN_STEPS | D | E | Tuning; default benar. Pasangan MAX_STEPS/TURN_STEPS ambigu |
| CENTRAL_TURN_STEPS | Giliran maks per turn | `turnLimits.ts:25` (`51:66`) | D | E | idem; jelaskan perbedaan di `.env.example` atau satukan `[BT]` |
| CENTRAL_TURN_WALL_MS | Batas waktu turn (ms) | `turnLimits.ts:25` (`51:66`) | D | E | Satuan ms asing bagi pengguna |
| CENTRAL_TURN_TOKENS | Batas token turn | `51:66` | D | E | Tuning |
| CENTRAL_DAILY_TOKENS | Budget token harian | `guard/budgetStore.ts:29` (`51:67`) | O | A | Guard rail biaya yang sah; tampil di Lanjutan |
| CENTRAL_DAILY_SPAWNS | Budget spawn harian | idem | O | A | Guard rail |
| CENTRAL_DAILY_COST_MICROS | Budget biaya harian (mikro) | idem; satuan "mikro" tak ramah, default `0` = arti? `[BT]` | O | A | Ganti satuan ke USD saat tampil; dokumentasikan arti 0 |
| CENTRAL_CONTEXT_WINDOW | Jendela konteks (token) | `rotationPolicy.ts:15` (`51:68`) | D | E | Turun dari model; tak pernah perlu diubah |
| CENTRAL_MAX_INFLIGHT | Worker bersamaan maks | `autonomyDispatch.ts:24` (`51:68`) | D | E | Tuning |
| AGENT_IDLE_DONE_MS | Idle = kandidat selesai (ms) | `orchestrator/workerSignal.ts:17` (`51:68`) | D | E | Tuning heuristik internal |
| CENTRAL_TOOL_BRIDGE | Jembatan tool | tanpa pembaca; "Belum dipakai server" (`51:85-87`); allowlist invarian `invariants.test.ts:43` | D | X | Hantu; `.env.example:111` ikut dibersihkan |
| KNOWLEDGE_GRAPHIFY | Knowledge via graphify | tanpa pembaca (`51:88`) | D | X | idem |
| EMBED_MODEL | Model embedding | tanpa pembaca (`51:89`) | D | X | idem |
| EMBED_URL D | URL embedding | hanya TODO `memory/memoryHybrid.ts:118` (`51:90`) | D | X | `dangerous` tanpa efek; tambah ulang bila fitur ada |

### 1.3 Orkestrator, memori, kontrol, log

| Kunci | Label UI | Efek nyata / tumpang tindih | Aud | Vonis | Alasan |
|---|---|---|---|---|---|
| ORCHESTRATOR_RUN D | Orchestrator run | `orchestratorRunModel.ts:11-44` (`51:69`) | U | T | Fitur nyata; terkunci tanpa token |
| RUN_REQUIRE_APPROVAL | Run wajib approval | idem (`51:69`) | U | T | Sub-opsi RUN; tampil hanya bila RUN on (`requires`) |
| MEMORY_FILES | Memory files | `memory/memoryFilePath.ts:23`, `memoryFileHttp.ts:27` (`51:70`) | U | T | Fitur nyata; nama mirip CENTRAL_MEMORY |
| MEMORY_DIR D | Direktori memory | `memoryFilePath.ts:19-112` (`51:70`) | O | A | Path; default memadai |
| CONTROL_CWD_ROOTS D | Root cwd control | `control/controlCwd.ts:15` (`51:71`) | O | A | Batas keamanan operator |
| TRUST_PROXY D | Percaya proxy | `webhookPeer.ts:21,45` (`51:52`) | O | E | Keamanan proksi (`51` vonis TETAP-ENV); salah set = spoof peer; jangan di UI |
| LOG_LEVEL | Level log | `logger.ts:34,104-108` (`51` §3.3) | D | A | Berguna saat debug; bukan pengguna |
| LOG_BUFFER | Buffer log | `logBus.ts:117` | D | E | Angka tuning |
| LOG_FILE | File log | `logger.ts:108`; hanya literal `off` mematikan (dialek beda, `51:F4`) | D | E | Dialek flag berbeda = ambigu bila diedit di UI |

### 1.4 Browser, File manager

| Kunci | Label UI | Efek nyata / tumpang tindih | Aud | Vonis | Alasan |
|---|---|---|---|---|---|
| BROWSER D | Node Browser | `browser/browser.runtime.ts:53-75` (`51:76`) | U | T | Fitur nyata; terkunci tanpa token |
| BROWSER_BIN D | Path biner Chromium | `chromium.launch.ts:35-41` | O | A | Auto-detect; override operator |
| BROWSER_AGENT D | Kendali agent | `ca2Boot.browser.ts:24` | O | A | Persetujuan keamanan; bersyarat BROWSER on |
| BROWSER_ALLOW_HOSTS D | Host privat yang diizinkan | `browser.runtime.ts` | O | A | Keamanan jaringan |
| BROWSER_COOKIE_IMPORT D | Impor cookie | `browser.runtime.ts` | O | A | Keamanan privasi |
| BROWSER_MAX_LIVE | Batas tab live | `browserLifecycle.service.ts:20-21` (`51:77`) | D | E | Tuning |
| BROWSER_DISCARD_MS | Jeda buang tab (ms) | idem | D | E | Tuning |
| BROWSER_COOKIE_TTL_DAYS | Umur cookie tersimpan (hari) | `browser.runtime.ts` | O | E | Tuning; default 7 |
| FILES_MUTATE | Files: mutasi | `envRegistry.files.ts:23`, `fsApi.ts:97-98,130` (`51:78`) | U | T | Default `off`: file manager baca-saja pada zero-config (Keputusan D5) |
| FILES_UPLOAD | Files: upload/download | idem | O | G | Menulis ke disk seperti MUTATE; satukan di "Izinkan ubah file" |
| FILES_VIEWERS | Files: viewer | idem | U | E | Fitur baca tak berisiko; default sebaiknya aktif, flag jadi kill-switch |
| FILES_WATCH | Files: watcher | idem | D | E | Detail implementasi |
| FILES_GIT_STATUS | Files: status git | idem | D | E | Fitur baca; default aktif |
| FILES_QUICK_OPEN | Files: Quick Open | idem | D | E | Fitur baca; default aktif |
| FILES_LIST_MAX | Files: batas entri | `envRegistry.files.ts:33` (`51:79`) | D | E | Tuning |
| FILES_UPLOAD_MAX_MB | Files: batas upload (MB) | `envRegistry.files.ts:38` | O | E | Tuning operator |

## 2. Implikasi

### 2.1 Rekomendasi tegas

1. Jadikan satu kartu Telegram: switch Telegram, token (dengan tes `getMe` dan status), jembatan Central bersyarat. `CHANNELS`, `MODE`, `WEBHOOK_SECRET` keluar dari tampilan utama.
2. Hapus tab "Environment" sebagai konsep; bagi menurut fitur plus satu panel Lanjutan untuk operator (rancangan di `55`).
3. Bereskan bug sebelum merombak UI: `requires` runtime `claude`, banner restart token/ingress, `requires` secret webhook.
4. Hapus 4 kunci mati dan alias `TELEGRAM_BOT_TOKEN` (selaras `51` vonis HAPUS).
5. Kunci `dangerous` (14, `51:13`) membuat 4 kontrol TAMPIL (AUTONOMY, AGENTS, ORCHESTRATOR_RUN, BROWSER) hanya-baca pada loopback tanpa token. Perombakan ini bergantung pada `WEBTERM_TOKEN` DEFAULT-OTOMATIS (`52`); tanpanya, sertakan alasan terkunci di UI.

### 2.2 Keputusan produk (default disarankan + opsi veto)

| ID | Keputusan | Default saya | Veto |
|---|---|---|---|
| D1 | `WEBTERM_CHANNELS` keluar dari UI, tetap dibaca env | Ya | Pertahankan di Lanjutan |
| D2 | `LEDGER` default `on` (Telegram dan approval tak berguna tanpanya) | Ya, bila migrasi ledger terbukti aman `[BT]` | Tetap `off`, UI menjelaskan prasyarat |
| D3 | Satu aksi "Hubungkan Telegram" mengisi `TELEGRAM=on` otomatis saat token tervalidasi | Ya | Pertahankan switch terpisah |
| D4 | Tombol approval Telegram otomatis on bersama Telegram (kunci tetap sebagai env) | Ya | Pertahankan saklar |
| D5 | Default `FILES_VIEWERS/WATCH/GIT_STATUS/QUICK_OPEN` jadi on; `MUTATE/UPLOAD` tetap off | Ya (membuka fitur baca di zero-config) | Semua tetap off |
| D6 | Webhook otomatis (server memanggil `setWebhook` + bangkitkan secret) | Tunda; webhook tetap operator | Bangun sekarang |
| D7 | Paket CA2 (8 flag) satu saklar | Ya | Granular tetap tampil di Lanjutan |
| D8 | Hapus 4 kunci mati + alias token (deprecate 1 rilis) | Ya (`51` D3) | Pertahankan |

### 2.3 Workstream usulan

| WS | Nama | Berkas milik | Ukuran | Tes yang dijaga |
|---|---|---|---|---|
| CH-1 | Bersih-bersih registri channels/central | `server/envRegistry.channels.ts`, `envRegistry.ca2.ts`, `envRegistry.central.ts`, daftar beku di `envRegistry.invariants.test.ts` | S | invarian 4/6/8/9 (`:114,149,184,199`); `envRegistry.test.ts`; `envRegistry.central.runtime.test.ts` |
| CH-2 | Perbaikan perilaku Telegram: restart/poller hot, alasan mati, tes token via `getMe` | `server/channels/channelsRuntime.ts`, `telegramPollWiring.ts`, `channelStatus.ts`, `botManager.ts` | M | tes channels server (round-trip, status); `ChannelsSection.test.tsx` |
| CH-3 | Kartu Telegram tunggal (UI) | `client/ChannelsSection.tsx`, `ChannelsTelegramConfig.tsx`, `channelsLabels.ts`, `useChannels.ts` | M | `ChannelsSection.test.tsx`, `ChannelsTelegramConfig.test.tsx`, `EnvValueControl.test.tsx:91-92` (teks `inactiveHint`) |
| CH-4 | Struktur sidebar + panel Lanjutan | `client/SettingsPanel.tsx`, `EnvSection.tsx`, `envSectionLabels.ts`, `EnvEntryRow.tsx`, `EnvBadges.tsx` | L | `EnvSection.test.tsx`, `SettingsPanel.envsearch.test.tsx`, `EnvEntryRow.test.tsx`, `envSearch.test.ts` |
| CH-5 | Default dan flag berkas (D5), docs/`.env.example` | `server/envRegistry.files.ts`, `.env.example`, README bagian env | S | `envRegistry.files.test.ts`; tes fs |

Urutan: CH-1 -> CH-2 || CH-3 -> CH-4; CH-5 mandiri. Dokumen rangkuman (README/CHANGELOG) sekali di akhir (Rule 16).

### 2.4 Risiko dan asumsi `[BT]`

- Mengubah `requires`/menghapus kunci memicu invarian 8 (daftar beku) dan 6 (pembaca); perubahan harus sadar.
- Batas teks invarian 5 (label <=40, deskripsi <=160, `invariants.test.ts:136-147`) dan invarian 9 (berkas registry <=100 baris) membatasi cara menambah penjelasan di registri; penjelasan panjang taruh di klien.
- Belum diverifikasi: perilaku `EnvSecretField` untuk "hapus token"; hubungan CENTRAL vs CENTRAL_CHAT; arti `DAILY_COST_MICROS=0`; perbedaan MAX_STEPS vs TURN_STEPS; keamanan migrasi LEDGER default `on`.
- Pembanding industri (Home Assistant, Portainer, GitHub Secrets) tidak diverifikasi di dokumen ini; dirujuk ke `55`.
