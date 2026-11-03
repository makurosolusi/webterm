# RND 51 (a) — Inventaris env var webterm (untuk target "tanpa .env")

Topik 1 dari 3. Saudara: `52-ENV-MINIMAL-ZERO-CONFIG-BOOT.md` (jalur boot, token auto, secret store) dan `53-ENV-MINIMAL-CONFIG-LAYERS.md` (lapisan konfigurasi, migrasi). Asumsi lintas-topik ditandai `[BT]`. Lanjutan dokumen ini: `51-ENV-MINIMAL-INVENTORY-b.md` (selisih `.env.example`, set minimal, implikasi). Rujukan lama (jangan diulang): `RND/39-ENV-REGISTRY-AUDIT.md`, `PLAN/ENV-SETTINGS-a/b/c.md`.

Metode: `grep -rnE "process\.env|Bun\.env|import\.meta\.env" src scripts vite.config.ts` (121 hit non-tes di ~70 berkas sumber; 48 berkas tes menyentuh `process.env`; `scripts/` dan `vite.config.ts` NOL pembaca env). Registri di-dump dengan skrip baca-saja (`envRegistry` + `resolveMeta`) pada worktree ini: 66 entri + 10 kunci `BOOTSTRAP_ONLY_KEYS` (`envRegistry.ts:19-30`). Bun terpasang 1.4.2. Tidak ada `.env*` yang dibaca, tidak ada nilai env yang dicetak.

## 1. Fakta mekanik yang menentukan vonis

| # | Fakta | Bukti |
|---|---|---|
| F1 | Urutan nyata non-secret: **override tersimpan > env proses > default kode**. Overlay MEMUTASI `process.env` (`target`); `base` = snapshot env sebelum overlay pertama. Secret datang dari berkas `<dataDir>/secrets/*` (0600, dir 0700), tidak pernah di DB. | `envSettings.service.ts` `apply()`: `value = overrides[key]` lalu `next = value ?? base[key]`; `index.ts:44` komentar "Pengaturan > env > default". (Spek mengira env > override: **salah**.) |
| F2 | Override baru terlihat bila pembaca membaca `process.env` SETELAH `initEnvSettings()` (`index.ts` ±45). Empat pembaca dievaluasi saat import, jadi override TIDAK pernah menjangkau nilai awalnya: `launchLine.ts:17` (PORT), `agentStatusAuth.ts:15` (STRICT_HOOK_AUTH), `logger.ts:34` dan `logBus.ts:117` (dibaca ulang oleh `configureLogging`, `logger.ts:104-108`, jadi aman). | grep per berkas |
| F3 | Kunci `dangerous` (14) butuh root token. `rootGate = WEBTERM_TOKEN` tak kosong (`envSettings.runtime.ts:37`). Loopback tanpa token => `AUTONOMY, OPENCODE_BIN, OPENCODE_ALLOW_TOOLS, CENTRAL_AGENTS, EMBED_URL, ORCHESTRATOR_RUN, MEMORY_DIR, CONTROL_CWD_ROOTS, TRUST_PROXY, BROWSER, BROWSER_BIN, BROWSER_AGENT, BROWSER_ALLOW_HOSTS, BROWSER_COOKIE_IMPORT` TIDAK bisa diubah dari UI. Jebakan utama desain "UI sebagai jalur utama". | `envSettings.runtime.ts:37`, registry `dangerous` |
| F4 | `flagOn` = hanya literal `on` (trim, case-insens). `1`/`true` TIDAK menyalakan flag registry. Sebaliknya tiga kunci bootstrap memakai `=== '1'` (`STRICT_HOOK_AUTH` `agentStatusAuth.ts:15`, `ALLOW_TOKEN_MINT` `control/mount.ts:65`, `ALLOW_LOOPBACK_APPROVAL` `approvalAuth.ts:12`). Dua dialek flag. | `envFlag.ts`, baris tsb |
| F5 | Bun memuat `.env` dari cwd otomatis (dev & binary) => semua nilai masuk `process.env` DAN diwarisi anak. `ptyShell.ts:74` `LEAKED_ENV = /^(NODE_ENV\|PORT\|HOST\|VITE_.*\|BUN_(?!INSTALL$).*\|WEBTERM_.*\|NODETERM_.*)$/` menyapu itu dari PTY, TAPI `TELEGRAM_BOT_TOKEN` (alias lama) dan kunci provider (`OPENAI_API_KEY`, dll.) TIDAK disapu. | `ptyShell.ts:74`, `pty.ts:187` |
| F6 | Biner: `build:binary` menanam `NODE_ENV='production'` (`package.json` script). `index.ts:49` `dev = NODE_ENV !== 'production'`. Jalur `bun src/server/index.ts` produksi tetap butuh `NODE_ENV=production` eksplisit. | `package.json`, `index.ts:49` |
| F7 | Urutan boot: `resolveHostPort` (`index.ts:38`) -> `resolveToken` (`:40`, melempar bila non-loopback tanpa token) -> `writeTokenToEnv` (`auth.ts:64-73`) -> `initEnvSettings` (buka DB; `WEBTERM_DATA_DIR` harus sudah final) -> logging -> ledger -> kanal -> central/CA2 -> browser -> PTY opts. | `index.ts`, `auth.ts` |

## 2. Inventaris A — BOOTSTRAP (sebelum DB / sebelum overlay)

Registri: "bootstrap" = ditolak API (`bootstrap_only`). Alasan di b §3.

| Nama | Dibaca di | Default kode | Jenis | Registri/restart | Vonis | Bukti / catatan |
|---|---|---|---|---|---|---|
| `HOST` | `serverConfig.ts` (via `index.ts:38`) | `127.0.0.1` | BOOTSTRAP | bootstrap | TETAP-ENV (opsional) | `host = HOST \|\| WEBTERM_HOST \|\| '127.0.0.1'` |
| `WEBTERM_HOST` | idem | fallback `HOST` | BOOTSTRAP / duplikat | bootstrap | TETAP-ENV (alias) | dua nama untuk satu hal; README menyebut keduanya |
| `PORT` | `serverConfig.ts`; `launchLine.ts:17` (import-time) | `8700` | BOOTSTRAP | bootstrap | TETAP-ENV (opsional) | `Number(PORT) \|\| 8700`; harus ada sebelum bind |
| `WEBTERM_DATA_DIR` | `config.ts:6` | `~/.webterm-server` (mkdir -p) | BOOTSTRAP | bootstrap | TETAP-ENV (opsional) | harus ada sebelum DB terbuka; telur-ayam, tak mungkin di Settings |
| `WEBTERM_TOKEN` | `index.ts:40`, `auth.ts:64-73`, `control/mount.ts:64`, `envSettings.runtime.ts:37` | tak ada | SECRET + BOOTSTRAP | bootstrap | **DEFAULT-OTOMATIS** (bangkitkan+persist `[BT 52]`), env tetap override | wajib hanya bila non-loopback (`auth.ts`); `writeTokenToEnv` memutasi env sehingga pembaca lain melihat token yang ditegakkan |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `approvalAuth.ts:12` | off (`=== '1'`) | BOOTSTRAP keamanan | bootstrap | TETAP-ENV | agen shell di mesin sama mencapai loopback; tak boleh diubah lewat API |
| `WEBTERM_ALLOW_TOKEN_MINT` | `control/mount.ts:65` | off | BOOTSTRAP keamanan | bootstrap | TETAP-ENV | idem |
| `WEBTERM_STRICT_HOOK_AUTH` | `agentStatusAuth.ts:15` (import-time) | off | BOOTSTRAP keamanan | bootstrap | TETAP-ENV | tak mungkin di-override (F2) |
| `WEBTERM_TELEGRAM_API_BASE` | `telegramPollApi.ts:56`, `telegramSend.ts:117` | `https://api.telegram.org` | DEV-TES (seam) | bootstrap | TETAP-ENV | dipakai tes/proksi; bukan konfigurasi operator |
| `WEBTERM_ENV_SETTINGS` | `envSettings.runtime.ts` (`locked`) | on | BOOTSTRAP kunci | bootstrap | TETAP-ENV | `off` = override diabaikan; harus tak bisa diubah dari UI |
| `NODE_ENV` | `index.ts:49` | dev | BOOTSTRAP | tak terdaftar | **DEFAULT-OTOMATIS** (biner sudah menanam; deteksi `dist/` `[BT 52]`) | F6; disapu dari PTY (`ptyShell.ts:74`) |

## 3. Inventaris B — 66 kunci registri (RUNTIME / FLAG / SECRET)

Kolom "R" = restart: `H` hot (dibaca per panggilan) / `B` boot. `D` = dangerous (F3). Default = default registri; semua selaras dengan kode kecuali yang dicatat di b §2. Vonis umum: **PINDAH-SETTINGS** (sudah di Settings; env hanya override) kecuali ditandai.

### 3.1 Kanal & ledger
| Nama | Dibaca di | Default | Jenis | R | Vonis |
|---|---|---|---|---|---|
| `WEBTERM_LEDGER` | `ledger/ledgerRuntime.ts:74` (off/shadow/on) | off | FLAG | B | PINDAH-SETTINGS (prasyarat CA2) |
| `WEBTERM_CHANNELS` | `channels/channelsMasterGate.ts:17-22` | on (kosong=on; nilai asing => fail-closed) | FLAG kill-switch | B | PINDAH-SETTINGS |
| `WEBTERM_TELEGRAM` | `channelsRuntime.ts:94` | off | FLAG | B | PINDAH-SETTINGS |
| `WEBTERM_TELEGRAM_MODE` | `telegramMode.ts:14` | kosong => poll bila token ada, selain itu webhook | FLAG enum | B | DEFAULT-OTOMATIS sudah ada |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | `telegramSend.ts:23-30` (per kirim) | tak ada; fallback alias lama `TELEGRAM_BOT_TOKEN` | SECRET | H | PINDAH-SETTINGS (file 0600); alias lama => HAPUS bertahap (F5) |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | `channelSecret.ts:57-75` (32-256 char `[A-Za-z0-9_-]`; varian `_FILE` 0600 TIDAK terdaftar) | tak ada | SECRET | B | DEFAULT-OTOMATIS (bangkitkan+persist; mode poll tak butuh) `[BT 52]` |
| `WEBTERM_CENTRAL_TELEGRAM` | `telegramCentralBridge.ts:16` | off | FLAG | B | PINDAH-SETTINGS |
| `WEBTERM_CHANNEL_APPROVAL_BUTTONS` | `channelButtons.ts:60` | off | FLAG | B | PINDAH-SETTINGS |
| `WEBTERM_TRUST_PROXY` (D) | `webhookPeer.ts:21,45` | off | FLAG keamanan | H | TETAP-ENV `[opini]`: header proksi mempengaruhi keputusan peer; setara kunci keamanan bootstrap |

### 3.2 Central, CA2, orkestrator, memori
| Nama | Dibaca di | Default | R | Vonis |
|---|---|---|---|---|
| `WEBTERM_CENTRAL` | `central/centralModel.ts:67` | off | H | PINDAH-SETTINGS |
| `WEBTERM_CENTRAL_CHAT` | `centralChatApi.ts:49` | off | H | PINDAH-SETTINGS |
| `WEBTERM_CENTRAL_RUNTIME` | `runtime/runtimeFlag.ts:19,26`; `centralChatHandlers.ts:49-57` | off (claude/opencode/mock/off; `codex` masih di `SUPPORTED` tapi `buildService` => null) | H | PINDAH-SETTINGS |
| `WEBTERM_CENTRAL_MODEL` | `opencodeOptions.ts:56`, `claudeRuntime.ts:142` | kosong | H | PINDAH-SETTINGS |
| `WEBTERM_CENTRAL_PLANNER` / `_MEMORY` / `_TOOLS`(read\|write) | `chat/turnService.ts:117-123` | off / off / read | H | PINDAH-SETTINGS |
| `WEBTERM_CENTRAL_AUTONOMY` (D) | `centralAutonomy.ts:100`, `centralAutonomyBoot.ts:43` | off | B | PINDAH-SETTINGS (tapi F3) |
| `WEBTERM_OPENCODE_BIN` (D) / `_ALLOW_TOOLS` (D) | `opencodeOptions.ts:61,67` | `opencode` / off | H | PINDAH-SETTINGS (F3) |
| `WEBTERM_CENTRAL_AGENTS` (D) | `ca2Boot.ts:42-53`, `defs/agent.defs.ts:26` | off | B | PINDAH-SETTINGS (F3) |
| `_CHECKPOINT` `_SKILLS` `_SKILL_PROPOSE` `_BOTS` `_KNOWLEDGE` `WEBTERM_AGENT_MAIL` `_READ_TOOLS` `_RELIABILITY` | `ca2Boot.ts:42-53,122-132`, `contextAssembler.ts:87`, `skill.defs.ts:25`, `autonomyDispatch.ts:19` | semua off | B | PINDAH-SETTINGS (flag arming CA2; satu paket) |
| `_MAX_STEPS` 2 / `_TURN_STEPS` 12 / `_TURN_WALL_MS` 120000 / `_TURN_TOKENS` 60000 | `chat/toolLoop.ts:18`, `turnLimits.ts:25` | angka | B | DEFAULT-OTOMATIS (angka tuning; tak perlu di `.env.example`) |
| `_DAILY_TOKENS` 1000000 / `_DAILY_SPAWNS` 20 / `_DAILY_COST_MICROS` 0 | `guard/budgetStore.ts:29` (default dari registri) | angka | B | DEFAULT-OTOMATIS |
| `_CONTEXT_WINDOW` 128000 / `_MAX_INFLIGHT` 3 / `WEBTERM_AGENT_IDLE_DONE_MS` 45000 | `rotationPolicy.ts:15`, `autonomyDispatch.ts:24`, `orchestrator/workerSignal.ts:17` | angka | B | DEFAULT-OTOMATIS |
| `WEBTERM_ORCHESTRATOR_RUN` (D) / `WEBTERM_RUN_REQUIRE_APPROVAL` | `orchestratorRunModel.ts:11-44` | off / off | B / H | PINDAH-SETTINGS |
| `WEBTERM_MEMORY_FILES` / `WEBTERM_MEMORY_DIR` (D) | `memory/memoryFilePath.ts:23,19-112`, `memoryFileHttp.ts:27,126-137` | off / `[BT]` dir default | H | PINDAH-SETTINGS |
| `WEBTERM_CONTROL_CWD_ROOTS` (D) | `control/controlCwd.ts:15` | kosong | H | PINDAH-SETTINGS (F3) |

### 3.3 Browser, berkas, log
| Nama | Dibaca di | Default | R | Vonis |
|---|---|---|---|---|
| `WEBTERM_BROWSER` (D) + `_BIN`(D) `_AGENT`(D) `_ALLOW_HOSTS`(D) `_COOKIE_IMPORT`(D) | `browser/browser.runtime.ts:53-75`, `chromium.launch.ts:35-41`, `ca2Boot.browser.ts:24`; nama di `shared/browser.contract.ts:40-50` | off / kosong | B | PINDAH-SETTINGS (F3: 5 kunci dangerous) |
| `_BROWSER_MAX_LIVE` 3 / `_DISCARD_MS` 300000 / `_COOKIE_TTL_DAYS` 7 | `browserLifecycle.service.ts:20-21`, `browser.runtime.ts` | angka | B | DEFAULT-OTOMATIS |
| `WEBTERM_FILES_MUTATE` `_VIEWERS` `_WATCH` `_GIT_STATUS` `_QUICK_OPEN` `_UPLOAD` | `envRegistry.files.ts:23` (`filesFlagOn`, akses dinamis `FILES_FLAG[name]`); `fsApi.ts:97-98,130`, `fsBoot.ts:11`, `index.ts:143,228` | **semua off** | H | PINDAH-SETTINGS; default off => fitur berkas "gelap" pada zero-config (keputusan produk, b §4.3 D4) |
| `_FILES_LIST_MAX` 5000 / `_FILES_UPLOAD_MAX_MB` 100 | `envRegistry.files.ts:33,38` | angka | H | DEFAULT-OTOMATIS |
| `WEBTERM_LOG_LEVEL` | `logger.ts:34,104-108` | info | B | PINDAH-SETTINGS |
| `WEBTERM_LOG_BUFFER` | `logBus.ts:117` (re-read `configureLogging`) | 5000 | B | DEFAULT-OTOMATIS |
| `WEBTERM_LOG_FILE` | `logger.ts:108`, `logFileSink.ts` | on; pembaca: hanya literal `off` mematikan | B | PINDAH-SETTINGS (dialek beda dari `flagOn`: F4) |

### 3.4 Registri tanpa pembaca (MATI) — grep semua pembaca selain registri/tes, NOL
| Nama | Bukti | Vonis |
|---|---|---|
| `WEBTERM_CENTRAL_TOOL_BRIDGE` | deskripsi registri "Belum dipakai server"; `.env.example:111` mendokumentasikannya | HAPUS dari registri+contoh (atau tandai experimental) |
| `WEBTERM_KNOWLEDGE_GRAPHIFY` | idem | HAPUS |
| `WEBTERM_EMBED_MODEL` | idem | HAPUS |
| `WEBTERM_EMBED_URL` (D) | hanya TODO di `memory/memoryHybrid.ts:118` | HAPUS atau biarkan hingga fitur ada; ini `dangerous` tanpa efek |
