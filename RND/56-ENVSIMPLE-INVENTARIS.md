# RND-56 Inventaris kunci env dan klasifikasi (base chore/envmin-int 620b9cf)

Prefiks `WEBTERM_` dihilangkan di tabel kecuali disebut. Path relatif `src/server/` kecuali tertulis lain. `[T]` = TERVERIFIKASI (kode dibaca), `[A]` = ASUMSI. Registry = `envRegistry.{channels,central,ca2,platform,files}.ts` + `browser/browser.envRegistry.ts`; builder `envRegistry.types.ts:48-70`; bootstrap-only `envRegistry.ts:19-32`.

## 1. Angka sebenarnya (koreksi "97")

- Nama `WEBTERM_*/NODETERM_*` unik di seluruh `src` (termasuk tes) = 97. Tanpa tes: **82 kunci nyata** = 62 registry + 11 bootstrap-only non-registry (`HOST PORT WEBTERM_HOST DATA_DIR TOKEN ALLOW_LOOPBACK_APPROVAL ALLOW_TOKEN_MINT STRICT_HOOK_AUTH TELEGRAM_API_BASE ALLOWED_HOSTS ENV_SETTINGS`, `envRegistry.ts:20-31`) + 9 dibaca tapi bukan registry (lihat 5.3). [T]
- 15 sisanya bukan kunci: 5 tombstone/mati (`CENTRAL_TOOL_BRIDGE KNOWLEDGE_GRAPHIFY EMBED_URL EMBED_MODEL CHANNEL_HMAC_SECRET`, hanya di `envRegistry.invariants.test.ts:43` dan satu komentar TODO `memory/memoryHybrid.ts:118`), `CENTRAL_NOTIFY`, `PORT` berprefiks, `ROOT_TOKEN`, fixture tes (`FUTURE* NEW_* OLD_* X TEST_FLAG SECRET_PROBE`). [T: grep non-test kosong]
- Konsekuensi: kejujuran angka. Yang harus dikurangi adalah 82, dan 62-nya sudah tampil di Settings.

## 2. Ringkasan per ember

| # | Ember | Jml | Kunci |
|---|-------|-----|-------|
| 1 | HAPUS | 17 | HOST-alias `WEBTERM_HOST`, alias `TELEGRAM_BOT_TOKEN`, `CENTRAL_TURN_STEPS`, `LOG_FILE`, `CENTRAL_MEMORY`, `CENTRAL_CHECKPOINT/SKILLS/SKILL_PROPOSE/BOTS/KNOWLEDGE/RELIABILITY/READ_TOOLS`, `AGENT_MAIL`, `CHANNEL_APPROVAL_BUTTONS`, `FILES_VIEWERS/GIT_STATUS/QUICK_OPEN` |
| 2 | TURUNAN | 14 | `NODETERM_NODE_ID/NODE_TOKEN/PORT`, `BROWSER_READ_CAP/ACT_CAP/NODE_ID`, `LEDGER`, `CHANNELS`, `TELEGRAM`, `CENTRAL_TELEGRAM`, `CENTRAL_CHAT`, `TELEGRAM_WEBHOOK_SECRET`, `..._SECRET_FILE`, `CONTROL_CWD_ROOTS` |
| 3 | DETEKSI | 6 | `TELEGRAM_MODE`, `CENTRAL_RUNTIME`, `CENTRAL_CONTEXT_WINDOW`, `OPENCODE_BIN`, `BROWSER_BIN`, `MEMORY_DIR` |
| 4 | BOOTSTRAP | 11 | `HOST PORT DATA_DIR TOKEN ENV_SETTINGS ALLOW_LOOPBACK_APPROVAL ALLOW_TOKEN_MINT STRICT_HOOK_AUTH ALLOWED_HOSTS TELEGRAM_API_BASE TRUST_PROXY` |
| 5 | KEPUTUSAN | 17 | `TELEGRAM_BOT_TOKEN CENTRAL CENTRAL_MODEL CENTRAL_TOOLS OPENCODE_ALLOW_TOOLS CENTRAL_AGENTS CENTRAL_AUTONOMY ORCHESTRATOR_RUN RUN_REQUIRE_APPROVAL CENTRAL_DAILY_TOKENS BROWSER BROWSER_AGENT BROWSER_ALLOW_HOSTS BROWSER_COOKIE_IMPORT MEMORY_FILES FILES_MUTATE FILES_UPLOAD` |
| 6 | TUNING | 17 | `CENTRAL_MAX_STEPS/TURN_WALL_MS/TURN_TOKENS/MAX_INFLIGHT/PLANNER/DAILY_SPAWNS/DAILY_COST_MICROS`, `AGENT_IDLE_DONE_MS`, `NODETERM_PERM_WAIT_SECS`, `LOG_LEVEL LOG_BUFFER`, `BROWSER_MAX_LIVE/DISCARD_MS/COOKIE_TTL_DAYS`, `FILES_LIST_MAX/UPLOAD_MAX_MB/WATCH` |

Total 17+14+6+11+17+17 = 82. Ember 5 yang 17 kunci runtuh menjadi **12 keputusan** (lihat 4).

## 3. Detail per kunci (ember 2-5; 1 dan 6 ada di 3.3)

Kolom: baca = titik baca runtime; T/D = tipe/default efektif; R = restart (b boot, h hot); dep = dependensi yang dipaksakan KODE (bukan registry); siapa = U pengguna, O operator, D dev, - tak seorang pun.

### 3.1 BOOTSTRAP (4) dan KEPUTUSAN (5)

| Kunci | baca [T] | T/D | R | dep | siapa | Ember + alasan |
|---|---|---|---|---|---|---|
| HOST | `serverConfig.ts:25` (`HOST\|\|WEBTERM_HOST\|\|DEFAULT_HOST`), `launchLine.ts:18` | str, 127.0.0.1 | b | menentukan apakah token dibangkitkan (`tokenBootstrap.ts:82`) | O | 4: dibaca sebelum DB ada |
| PORT | `serverConfig.ts:26`, `launchLine.ts`, juga dibaca di tempat lain (lihat 5.1) | int, 8700; tak valid = exit | b | - | O | 4: bind socket |
| DATA_DIR | `config.ts:12`, `contextLinkSkill.ts:110` | path, `~/.webterm-server` | b | lokasi DB, secrets/ | O | 4: lokasi DB itu sendiri |
| TOKEN | `tokenBootstrap.ts:68`, `approvalAuth.ts:13` | secret, kosong=loopback terbuka | b | host non-loopback membangkitkan berkas | U/O | 4 (sudah ada jalur in-app U1) |
| ENV_SETTINGS | `envSettings.runtime.ts` (switch overlay) | flag | b | mematikan seluruh overlay Settings | D | 4: sakelar darurat; tidak untuk user |
| ALLOW_LOOPBACK_APPROVAL | `approvalAuth.ts:15` (persis `'1'`) | flag, off | b | butuh TOKEN aktif agar bermakna [A] | O | 4: pelonggar keamanan, sengaja di luar API |
| ALLOW_TOKEN_MINT | `control/mount.ts:66` (persis `'1'`) | flag, off | b | - | O | 4 idem |
| STRICT_HOOK_AUTH | `agentStatusAuth.ts:15` (persis `'1'`) | flag, off | b | - | O | 4 idem |
| ALLOWED_HOSTS | `bootWiring.ts:50`, `hostAllow.ts:3` | csv | b | aktif hanya bila tanpa token (L4/U2) | O | 4: harus aktif sebelum overlay |
| TELEGRAM_API_BASE | `telegramPollApi.ts:56`, `telegramSend.ts:125` | url | b | - | D (tes/proxy) | 4: mengalihkan token bot |
| TRUST_PROXY | `channels/webhookPeer.ts:11` | flag, off, dangerous | h(?) | hanya webhook | O | 4: fakta deployment, tak bisa dideteksi aman (header bisa dipalsu) |
| TELEGRAM_BOT_TOKEN (`WEBTERM_` prefiks) | `channels/channelSenderBoot.ts:20`, `telegram.ts:4` | secret | h | menyalakan Telegram (lihat TELEGRAM) | U | 5: satu-satunya masukan nyata Telegram |
| CENTRAL | `central/centralModel.ts:67`, `telegramPollWiring.ts:20` | flag, off | h | kode TIDAK butuh LEDGER; hanya CENTRAL_TELEGRAM yang butuh | U | 5: "pakai agen Central" |
| CENTRAL_MODEL | `central/runtime/opencodeOptions.ts:10` | str | h | runtime opencode | U | 5: pilihan model (boleh kosong=default engine) |
| CENTRAL_TOOLS | `turnService.ts:118` | enum, `read` (case-sensitive) | h | - | U | 5: izin tool; digabung dgn OPENCODE_ALLOW_TOOLS |
| OPENCODE_ALLOW_TOOLS | `opencodeOptions.ts:12` | flag, dangerous | h | runtime opencode | U | 5 idem |
| CENTRAL_AGENTS | `central/ca2Boot.ts:42,53,129` | enum off/propose/auto, dangerous | b | registry bilang butuh X; kode: tidak [A] | U | 5: tingkat otonomi (1 keputusan dgn AUTONOMY) |
| CENTRAL_AUTONOMY | `centralAutonomyBoot.ts:44,104`, `central/centralAutonomy.ts:100` | flag, dangerous | b | registry: butuh CENTRAL; kode: tidak terlihat | U | 5 idem |
| ORCHESTRATOR_RUN | `orchestratorRunModel.ts:12`, `centralAutonomyBoot.ts:109` | flag, dangerous | b | registry: LEDGER on/shadow | U | 5: boleh jalankan perintah |
| RUN_REQUIRE_APPROVAL | `orchestratorRunModel.ts:14`, `centralAutonomyBoot.ts:114` | flag | h | bermakna hanya bila RUN on | U | 5: digabung dgn RUN jadi satu 3-pilihan (off/tanya/otomatis) |
| CENTRAL_DAILY_TOKENS | `central/guard/budgetStore.ts:17-29` | int, 1.000.000 | h | - | U | 5: anggaran harian (satu-satunya tuas biaya yang dimengerti user) |
| BROWSER | `browser/browser.runtime.ts:53` | flag, dangerous | b | - | U | 5: nyalakan node browser |
| BROWSER_AGENT | `central/tools/defs/browser.act.ts:14`, `workspace.shape.ts:67` | flag | h | butuh BROWSER | U | 5: agen boleh menyetir browser |
| BROWSER_ALLOW_HOSTS | `browser/ssrf.allowlist.ts:1` | csv | h | butuh BROWSER | U | 5: batas SSRF = keputusan keamanan |
| BROWSER_COOKIE_IMPORT | `browser.runtime.ts:68,75` [A] | flag | h | butuh BROWSER | U | 5: izin impor cookie |
| MEMORY_FILES | `memory/memoryFilePath.ts:19` | flag | b | MEMORY_DIR ikut | U | 5: memori berbasis berkas |
| FILES_MUTATE | `index.ts:139`, `envRegistry.files.ts:32-50` | flag, off | b | - | U | 5: izin tulis/hapus berkas (L11 menjaga off) |
| FILES_UPLOAD | `envRegistry.files.ts:32-50`, `fsApi.ts` | flag, off | b | [A] butuh MUTATE | U | 5: izin unggah |

### 3.2 TURUNAN (2) dan DETEKSI (3)

| Kunci | baca [T] | T/D | R | Ember + cara menurunkan |
|---|---|---|---|---|
| LEDGER | `ledger/ledgerRuntime.ts:74`, `channelsRuntime.ts:181` | enum off/shadow/on, off; parse sendiri | b | 2: aktif otomatis bila ada konsumen (Telegram, ORCHESTRATOR_RUN, CHECKPOINT). `shadow` = alat dev |
| CHANNELS | `channels/channelsMasterGate.ts:6,21` | on/off tristate, on | b | 2: gerbang induk redundan; = ada saluran terkonfigurasi |
| TELEGRAM | `channelsRuntime.ts:52` | flag, off | b | 2: = token bot terisi |
| TELEGRAM_MODE | `channels/telegramMode.ts:6` | ''/poll/webhook | b | 3: webhook bila secret+URL publik ada, kalau tidak poll |
| TELEGRAM_WEBHOOK_SECRET(+_FILE) | `channels/channelSecret.ts:9,11,70`, `channelStatusHttp.ts:29` | secret / path | h | 2: bangkitkan otomatis ke `secrets/` seperti TOKEN (L3); dua jalur = satu kebutuhan |
| CENTRAL_TELEGRAM | `channels/telegramCentralBridge.ts:16`, `telegramPollWiring.ts:19` | flag | h | 2: = CENTRAL on dan Telegram aktif. Registry minta RUNTIME `mock\|opencode`, kode hanya cek non-off (lihat 5.4) |
| CENTRAL_CHAT | `centralChatApi.ts:26`, `telegramPollWiring.ts:18` | flag | h | 2: panel = CENTRAL on (L12 sudah jadikan state server) |
| CENTRAL_RUNTIME | `central/runtime/runtimeFlag.ts:6,19,26` | enum mock/opencode, off | h | 3: pilih dari engine terpasang (`opencode` di PATH dst.); `codex` tak ada di enum [T] |
| CENTRAL_CONTEXT_WINDOW | `central/context/rotationPolicy.ts:10` | int 128000 | h | 3: tabel per model |
| OPENCODE_BIN / BROWSER_BIN | `opencodeOptions.ts:11`; `browser/chromium.launch.ts:19-41` | path | h | 3: PATH + `BIN_CANDIDATES` sudah ada (`chromium.launch.ts:19-21,40`); override boleh tetap tersembunyi |
| MEMORY_DIR | `memoryFileHttp.ts:27`, `memory/memoryUserStore.ts:46` | path, dangerous | b | 3: default di bawah DATA_DIR; registry minta MEMORY_FILES, kode tidak |
| CONTROL_CWD_ROOTS | `control/controlCwd.ts:15` | csv path, dangerous | h | 2: dari cwd workspace yang ada |
| NODETERM_NODE_ID/NODE_TOKEN/PORT | `ptyShell.ts:88`, `contextLinkSkill.ts:19-41`, `hooksTokens.ts:14`, `sessions.ts:83` | diset server ke PTY | - | 2: protokol, JANGAN rename; user tak pernah set |
| BROWSER_READ_CAP/ACT_CAP/NODE_ID | `browser/browser.sessionCaps.ts:48`, `browserAgentShim.ts:12-15,54-55` | token per sesi | - | 2: diinjeksi server |

### 3.3 HAPUS (1) dan TUNING (6), satu baris per kelompok

- HAPUS-a, alias: `WEBTERM_HOST` (`serverConfig.ts:25`, sudah ada `HOST`); `TELEGRAM_BOT_TOKEN` tanpa prefiks (`ptyShell.ts:91`, `telegramSend.ts:26-35`; L9 sudah jadwalkan hapus).
- HAPUS-b, flag rilis bertahap boot-only default off (`ca2Boot.ts:42-56,129-132`; `centralAutonomyBoot.ts`; `channelButtons.ts:17`; `registerAll.ts:25-26`): `CENTRAL_CHECKPOINT SKILLS SKILL_PROPOSE BOTS KNOWLEDGE RELIABILITY READ_TOOLS CENTRAL_MEMORY AGENT_MAIL CHANNEL_APPROVAL_BUTTONS`. Tak satu pun dangerous; jadikan perilaku tetap saat CENTRAL on. [A: kestabilan fitur butuh konfirmasi user]
- HAPUS-c: `CENTRAL_TURN_STEPS` (`chat/turnLimits.ts:4`) tumpang tindih `CENTRAL_MAX_STEPS` (`chat/toolLoop.ts:18`); `LOG_FILE` (`logs/logger.ts:109`, parse fail-open); `FILES_VIEWERS/GIT_STATUS/QUICK_OPEN` (default on sejak L11, tak ada alasan mematikan).
- TUNING agen: `CENTRAL_MAX_STEPS`, `TURN_WALL_MS` 120000, `TURN_TOKENS` 60000 (`turnLimits.ts:6,29`; penegakan token per giliran tak terlacak [A]), `MAX_INFLIGHT` 3 (`autonomyDispatch.ts:13`), `PLANNER` (`turnService.ts:117`), `DAILY_SPAWNS` 20, `DAILY_COST_MICROS` 0 (`budgetStore.ts:29`), `AGENT_IDLE_DONE_MS` 45000 (`orchestrator/workerSignal.ts:18`), `NODETERM_PERM_WAIT_SECS` (`hooks.ts:40`, UI `SettingsAgents.tsx:91`).
- TUNING platform: `LOG_LEVEL` info (`logger.ts:35,106`), `LOG_BUFFER` 5000 (`logs/logBus.ts:13-16,117`), `BROWSER_MAX_LIVE` 3, `DISCARD_MS` 300000, `COOKIE_TTL_DAYS` 7 (`browserLifecycle.service.ts:20-21`), `FILES_LIST_MAX` 5000, `UPLOAD_MAX_MB` 100, `FILES_WATCH` (`envRegistry.files.ts:32-50`).

## 4. Berapa dari "97" yang jadi keputusan pengguna

- Dari 82 kunci nyata: 17 kunci ember 5 = **12 keputusan**: (1) token Telegram, (2) Central on + model, (3) izin tool Central (TOOLS+ALLOW_TOOLS), (4) otonomi (AGENTS+AUTONOMY), (5) orchestrator: off/tanya/otomatis (RUN+REQUIRE_APPROVAL), (6) anggaran harian, (7) browser on, (8) agen boleh menyetir browser, (9) allow-hosts browser, (10) impor cookie, (11) memori berkas, (12) tulis berkas (MUTATE+UPLOAD). Ditambah token akses (sudah in-app, U1) = **13 dari 97 (13%)**, 15% dari 82.
- Permukaan akhir yang direkomendasikan: **~13 saklar in-app** (kartu "izin": tiap satu = persetujuan sadar satu langkah) + **11 env bootstrap** (hanya operator; `.env.example` tetap 9) + 0 kunci tuning di UI (konstanta; satu "Mode performa" hanya bila ada bukti kebutuhan). Total yang bisa disentuh orang: ~24 vs 97; yang tampil di Settings: 13 vs 62 hari ini.
- Keputusan lama yang perlu dikoreksi: `docs/decisions/env-minimal.md` L11 (empat flag baca-saja "default on tapi tetap kunci") menjaga kunci yang tak seorang pun matikan; ember 1 lebih sederhana. `RND/55-CHENV-DESIGN.md` mempertahankan semua kunci di registry (`KNOWN_KEYS_FROZEN`, `envRegistry.invariants.test.ts:22,185`) dan hanya menata UI; itu tidak menyentuh akar (kunci tak berpengaruh tetap ada). Tetap benar: L1 (9 bootstrap), L3/L4, U1, nama protokol `NODETERM_*`. [T]

## 5. Inkonsistensi

### 5.1 Dibaca di banyak tempat / dialek parse berbeda [T kecuali ditandai]

| Kunci | Tempat | Masalah |
|---|---|---|
| PORT | `serverConfig.ts:26`, `launchLine.ts:18`, (dan jalur lain) | baca ganda; satu tak valid=exit (U), lainnya default 8700 [A] |
| TELEGRAM_API_BASE | `telegramPollApi.ts:56` vs `telegramSend.ts:125` | dua pembacaan, dua default [A] |
| ALLOW_LOOPBACK_APPROVAL, ALLOW_TOKEN_MINT, STRICT_HOOK_AUTH | `approvalAuth.ts:15`, `control/mount.ts:66`, `agentStatusAuth.ts:15` | persis `'1'`, disengaja (L10) tapi `on/true` diam-diam off |
| LOG_FILE | `logs/logger.ts:109` | fail-open; kunci lain fail-closed (`envFlag.ts` parseFlag) |
| CHANNELS | `channelsMasterGate.ts:6,21` | tristate sendiri |
| LEDGER | `ledgerRuntime.ts:74`, `channelsRuntime.ts:181` | parse sendiri, dua pembaca |
| CENTRAL_TOOLS | `turnService.ts:118`, `goldenHarness.ts:104,114` | case-sensitive, beda dari enum lain |
| CENTRAL_RUNTIME | `runtimeFlag.ts:6,19,26` | kode terima nilai non-off apa pun; registry hanya `mock\|opencode` |
| Angka (TURN_*, DAILY_*, MAX_*, BROWSER lifecycle) | `turnLimits.ts:29`, `budgetStore.ts:17-29`, `browserLifecycle.service.ts:20-21`, `rotationPolicy.ts:10` | minimal 4 varian parse angka (positiveInt vs Number vs clamp) |
| NODETERM_PERM_WAIT_SECS | `hooks.ts:40` dan `sessionsTypes.ts:45`, klien `SettingsAgents.tsx:91` | dibaca server dan ditampilkan klien |

### 5.2 Ada di registry, tak berpengaruh / mati
- `CENTRAL_TURN_TOKENS`: dibaca `turnLimits.ts:29`; penegakan tak ditemukan [A].
- `CENTRAL_TURN_STEPS` vs `CENTRAL_MAX_STEPS`: dua batas langkah untuk satu loop (`turnLimits.ts:4`, `toolLoop.ts:18`).
- Dependensi hantu pada `requires`: `AGENTS`, `AUTONOMY->CENTRAL`, `MEMORY_DIR->MEMORY_FILES`, `ORCHESTRATOR_RUN->LEDGER` memunculkan "Belum berpengaruh" meski kodenya (`orchestratorRunModel.ts:12-14`, `centralAutonomyBoot.ts:104-114`) tidak mengecek rantai itu secara terpisah [A: butuh uji jalan]. Inilah akar gejala "tiga flag berantai".
- `WEBTERM_PORT`, `ROOT_TOKEN`: tak ada pembaca non-tes.

### 5.3 Dibaca tapi tak ada di registry
`NODETERM_NODE_ID/NODE_TOKEN/PORT/PERM_WAIT_SECS` (protokol, sengaja), `BROWSER_READ_CAP/ACT_CAP/NODE_ID` (injeksi server), `TELEGRAM_WEBHOOK_SECRET_FILE` (disebut di deskripsi `envRegistry.channels.ts:51`, dibaca `channelSecret.ts:70`), `TELEGRAM_BOT_TOKEN` alias (`ptyShell.ts:91`). `BROWSER_VAULT_KEY` BUKAN env: nama kunci di SecretStore (`browser/cookieVault.store.ts:57`). [T]

### 5.4 Registry vs kode (salah)
`CENTRAL_TELEGRAM` requires `RUNTIME mock|opencode` + `LEDGER`, sedangkan `telegramCentralBridge.ts:16` hanya cek flag sendiri [A]. Enum `CENTRAL_RUNTIME` tak memuat `codex`.

## REKOMENDASI TEGAS

1. **Hapus rantai dependensi di kode, bukan UI**: jadikan LEDGER/CHANNELS/TELEGRAM/CENTRAL_TELEGRAM/CENTRAL_CHAT turunan (ember 2). Kenapa: sumber "Belum berpengaruh". Risiko: pengguna `shadow` kehilangan mode uji (pindah ke env dev). Ukuran: M.
2. **Satu fungsi `capability(key)` sebagai sumber status**, menggantikan `requires` di registry; UI hanya menampilkan on/off + alasan konkret. Kenapa: konfigurasi tanpa keadaan "tak berpengaruh". Risiko: kerja ulang `envSettings` kontrak. Ukuran: M.
3. **Gabungkan keputusan berisiko jadi saklar persetujuan satu langkah** (otonomi, orchestrator off/tanya/otomatis, izin tool, tulis berkas): 17 kunci jadi 12 saklar. Kenapa: kurangi beban kognitif, pertahankan gerbang root token. Risiko: migrasi override tersimpan. Ukuran: M.
4. **Hapus 17 kunci ember 1** (flag rilis bertahap CA2, alias, duplikat, FILES baca-saja) dan masukkan ke `RETIRED_KEYS` (blob lama tetap, rollback aman, pola L9). Risiko: nyalakan fitur CA2 yang belum stabil; mitigasi: tetap di balik CENTRAL on. Ukuran: S-M.
5. **Satukan dialek parse**: satu `parseFlag`/`parseInt` kanonik di `envFlag.ts`, termasuk LOG_FILE, CHANNELS, LEDGER, CENTRAL_TOOLS; tiga kunci keamanan tetap persis `1`. Risiko: kunci yang kini fail-open jadi fail-closed. Ukuran: S.
6. **Bangkitkan otomatis `TELEGRAM_WEBHOOK_SECRET`** ke `secrets/` (pola token L3), buang `_SECRET_FILE`. Risiko: pengguna yang menunjuk berkas sendiri; pertahankan sebagai override env. Ukuran: S.
7. **Ubah ember 6 menjadi konstanta** (modul `limits.constants.ts` tunggal), nol di UI. Kenapa: 17 kunci tak pernah diubah user; operator tetap bisa lewat env bila kebutuhan nyata muncul. Risiko: kebutuhan tuning produksi. Ukuran: S.
8. **Deteksi engine/biner/jendela konteks** (ember 3) dan tambahkan `codex` ke enum atau hapus enum. Risiko: PATH berbeda antar OS. Ukuran: S-M.

## PERTANYAAN UNTUK USER

1. Apakah 9 flag rilis CA2 (ember 1-b) sudah dianggap stabil sehingga boleh jadi perilaku tetap saat CENTRAL on? Default saran: ya, kecuali `SKILL_PROPOSE` dan `BOTS` tetap sebagai saklar sampai diuji.
2. `shadow` pada LEDGER: masih dipakai siapa pun? Default saran: tidak; pindahkan ke env developer.
3. Boleh menghapus `TELEGRAM_BOT_TOKEN` (alias) sekarang, bukan menunggu rilis sesudah 0.7.0? Default saran: tunggu jadwal L9, tanpa kerja tambahan.
