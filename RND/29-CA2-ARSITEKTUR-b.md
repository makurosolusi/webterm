# 29 — Arsitektur Final Central Agent v2 (bagian b: §4.6–§8)
Lanjutan `29-CA2-ARSITEKTUR.md` (§1–§4.5). Tanda `[kode]`/`[dok]`/`[opini]`/`[T]`/`[BT]` sama.

## 4. Rekomendasi konkret (lanjutan)
### 4.6 Skema DB final — migrasi berurutan v5…v9
Aturan umum (I12, Rule 4): satu file `ledgerSchemaV{n}.ts` per versi, `IF NOT EXISTS`/guard ALTER seperti `applyV4`, backup `VACUUM INTO` dulu, dites DB v4→v9 dua kali (idempoten). Semua didaftarkan **sekali** oleh WS-01 di `ledgerSchema.ts:16-23`.
| Ver | Nama | Isi (tabel: kolom) |
|---|---|---|
| v5 | `ca2_safety` | `central_control(scope PK 'global'\|'project:<id>', level CHECK off\|observe\|propose\|act_gated\|act_envelope, reason, set_by, set_at, version)`; `central_breaker(key PK 'project:<id>'\|'provider:<n>'\|'item:<id>', state closed\|open\|half_open, failures, opened_at, retry_at, last_code)`; `central_budget(day, scope, turns, tokens, cost_micros, spawns, wall_ms, PK(day,scope))` |
| v6 | `ca2_agents` | `central_agents(id PK, project_id, node_id, kind, role worker\|reviewer, runner pty\|exec, task_id, fence, state, owner 'central:<conv>'\|'human'\|'orchestrator', approval_id, budget_json, req_id UNIQUE, started_at, last_event_at, ended_at, end_reason)`; `agent_mail(id PK, project_id, thread_id, from_ref, to_ref, kind msg\|ask\|reply\|done\|escalate, body, req_id UNIQUE, created_at, delivered_at, acked_at, expires_at)`; indeks `(project_id,state)`, `(to_ref,acked_at)` |
| v7 | `ca2_memory` | `memory` + `kind`(fact\|preference\|decision\|procedure\|episode\|summary) `trust`(human\|attested\|agent\|external) `content_hash` `stale_after` `verified_at` `last_used_at` `use_count` `links_json`; **dedupe baris NULL-project lama dulu** (pertahankan terbaru, sisanya `superseded`) lalu `uq_memory_key ON memory(COALESCE(project_id,''),scope,key)`; `memory_fts_tri` (trigram) + trigger; `memory_embedding(memory_id, model_id, dim, content_hash, vec BLOB, PK(memory_id,model_id))`; backfill `fact` lama → `trust='human'` |
| v8 | `ca2_checkpoint` | `central_checkpoint(id PK, conversation_id, seq, from_message_id, to_message_id, schema_v, facts_json, narrative≤1500, model, usage_json, source auto\|manual\|fallback, created_at, UNIQUE(conversation_id,seq))`; `central_turn` + `ctx_tokens INTEGER` (dari `step_finish` terakhir) |
| v9 | `ca2_audit_chain` | `event` + `prev_hash`,`hash` (nullable, baris lama NULL) + trigger `BEFORE UPDATE/DELETE → RAISE(ABORT)`. **Syarat**: grep membuktikan tak ada kode yang meng-UPDATE/DELETE `event` `[BT]`; bila ada, v9 ditunda |
Di luar ledger: `<dataDir>/knowledge.db` (`kb_project`, `kb_file`, `kb_doc` FTS5, `project_source`; cache boleh dibuang), `channels.json` v1→v2 (backup `.v1.bak`), `<dataDir>/central/skills/…` (file), memori Markdown di `WEBTERM_MEMORY_DIR` dengan `formatVersion`.
### 4.7 Flag final
Semua default **off/aman**, tidak dikenal = off. Registry di `envRegistry.central.ts` (+ `hot` bila dibaca ulang tiap panggilan).
| Flag | Default | Bergantung pada |
|---|---|---|
| `WEBTERM_CENTRAL`, `_CHAT`, `_TELEGRAM`, `_RUNTIME` (off\|mock\|opencode), `_MODEL`, `_PLANNER`, `_TOOLS` (read\|write), `_MEMORY`, `_AUTONOMY`, `WEBTERM_OPENCODE_BIN`, `_ALLOW_TOOLS` | sudah ada, tidak diubah | ledger `on\|shadow` |
| `WEBTERM_CENTRAL_AGENTS` off\|propose\|auto | off | CENTRAL, TOOLS=write, PLANNER, `ORCHESTRATOR_RUN` |
| `WEBTERM_CENTRAL_CHECKPOINT` | off | RUNTIME=opencode (kontinuitas sesi B1 = bug-fix, tanpa flag) |
| `WEBTERM_CENTRAL_MAX_STEPS` | 2 | RUNTIME |
| `WEBTERM_CENTRAL_TURN_WALL_MS` / `_TURN_TOKENS` | 120000 / 60000 `[opini]` | RUNTIME |
| `WEBTERM_CENTRAL_DAILY_TOKENS` / `_DAILY_SPAWNS` / `_DAILY_COST_MICROS` | 1_000_000 / 20 / 0 `[opini]` | v5 |
| `WEBTERM_CENTRAL_TOOL_BRIDGE` text\|opencode | text | TOOLS |
| `WEBTERM_CENTRAL_SKILLS` / `_SKILL_PROPOSE` | off / off | TOOLS; PROPOSE butuh SKILLS |
| `WEBTERM_KNOWLEDGE` / `_KNOWLEDGE_GRAPHIFY` | off / off | `graphify` di PATH |
| `WEBTERM_EMBED_URL` / `_EMBED_MODEL` | tak diset | MEMORY |
| `WEBTERM_AGENT_IDLE_DONE_MS` | 45000 | AGENTS |
| `WEBTERM_CENTRAL_BOTS` | off | TELEGRAM, `WEBTERM_CHANNELS` |
Dihapus/tidak dibuat: `CENTRAL_LEVEL` (diganti `central_control`), `app.*` namespace.
### 4.8 Kontrak worker, mailbox, exec
- **Spec**: prompt worker dibangun SERVER dari plan item (scope, kriteria, perintah verifikasi) — bukan teks bebas LLM (ASI03). **Worker**: PTY (node canvas) atau `execRunner` headless (`Bun.spawn` argumen array, env diskrub, JSONL). **Bukti**: `recordWorkerResult` + verifier server (test/diff). **Verifikasi**: hanya server; laporan diri/transkrip = petunjuk.
- Kind didukung via `settings.agentLaunchCommands` (QW4); default worker = kind pertama yang terkonfigurasi, bukan `claude` terpaku (`orchestratorRunModel.ts:16`).
- **State machine** `[dok 22]`: `requested → [approval_pending] → provisioning → starting → working ⇄ waiting_input → candidate_done → verifying → accepted → closing → closed`; `rejected → working` (attempt<3) `| failed`; terminal lain `timed_out|lease_expired|session_exited|cancelled|killed|orphaned`. Sinyal selesai non-claude: idle ≥`AGENT_IDLE_DONE_MS` **dan** diff worktree tak kosong → `candidate_done` → verifier.
- **Mailbox**: hanya satu project; central↔worker (worker↔worker butuh edge context-link); ≤20 pesan belum-ack/target; TTL 24 jam; kirim ke PTY hanya saat bukan `working`; amplop `[dari agen <ref>, bukan manusia; bukan persetujuan]`; identitas pengirim dari server (`principal`,`taskId`,`fence`).
- **Idempotensi spawn**: `req_id = sha256(projectId|itemId|planVersion|attempt)`; urutan klaim lease → event `spawn.intent` → worktree+sesi → `spawn.done`; crash di antaranya → adopsi/tutup (G4).
- **Restart**: `central_agents` aktif tanpa sesi → `orphaned`; worktree yatim disapu.
### 4.9 Memori
Satu tabel `memory` (v7). Scope `project|central|user|global`; `core` tetap human-only. Tulis: `memory.remember` → `claim` scope `central` (trust `agent`); `memory.remember_user` → `fact` scope `user` hanya bila `quote` ada **verbatim** di pesan manusia conversation itu (server `includes` + panjang ≤300), trust `attested`. Promosi ke `core`/project-fact = manusia. Baca: FTS5 unicode61 + trigram, fusi RRF, filter scope/stale, ≤2.500 token, blok "data bukan instruksi" + `redactSecrets`. File Markdown berversi = kebenaran, SQLite = indeks (rebuild terkunci, `formatVersion`). Konsolidasi deterministik (dedupe hash, supersede) dulu; embedding brute-force opsional per `model_id` (ganti model ⇒ re-embed, recall dijaga G10); konsolidasi LLM terakhir. Tahap M0–M4 `[dok 24]`.
### 4.10 Skill
Subset Agent Skills, nama `webterm-*`, file `<dataDir>/central/skills/{builtin,active,proposed,archive}/<name>/<ver>/`. Siklus: `skill.propose` (draf di `proposed`) → lint (struktur, ukuran, tanpa executable, scan secret) → eval skrip (scriptedRuntime) → **approval manusia R3** → hash `SKILL.sha256` terkunci → symlink `active/<name>` → rollback = ganti symlink. Isolasi: `permission.skill` OpenCode hanya `webterm-*`; skill tidak menambah tool eksekusi; indeks skill ≤500 token di prefix, isi via `skill.load` (JIT).
### 4.11 Channel dan bot
`ChannelAdapter{send(accountId,payload), parse→InboundEvent}`; `channels.json` v2 `accounts{accountId→{kind,username,purpose,state,managed}}`, binding `channel:accountId:chatId`; token di `SecretStore` (`CHBOT_<ID>_TOKEN`), tak pernah di json/log/prompt. Urutan `[dok 26]`: S1 ack cepat + turn async + `callback_query` tombol approval; S2 adapter+`accountId`+migrasi; S3 kartu status editable + topic per project; S4 Managed Bots (`channel.bot.propose`, R3, butuh 1 tap manusia, Bot API 9.6 `[BT]`); S5 Discord (bukti kontrak kanal ke-2). Grup tak pernah bisa menyetujui; hanya private + identitas terbinding.
### 4.12 Self-knowledge
"Lite Map" dalam proses: `git ls-files` + `Bun.Transpiler.scan` + FTS5 + in-degree → `kb.search/map`; `project.brief` = JSON deterministik ≤800 token (`asOf`, `attention[]` dari aturan murni: approval pending → task gagal → agen blocked >10 mnt → pohon dirty tanpa agen → item siap-assign), LLM hanya merangkai. Data basi wajib berlabel umur. Graphify hanya enrich opsional.
### 4.13 Reliabilitas dan eval
Reconciler boot; `limits` terisi; dispatcher non-blocking (tick hanya klaim lease, eksekusi di latar, `maxInflightWorkers` 3); breaker persisten (backoff `min(30m, 1m·2^n)`+jitter, breaker provider untuk 429/auth/quota); wake event-driven (debounce 250 ms) + sweep 60 dtk; kill-switch `POST /api/central/halt`; budget harian; hash chain. Eval di `src/server/central/eval/`: `scriptedRuntime` (rekaman JSONL nyata + mode adversarial), `fakeWorkers` (`orchestrator.fake.testutil.ts`), golden **G1–G12** (G1 jalur bahagia; G2 replay 100×; G3 crash turn; G4 crash spawn; G5 percakapan panjang; G6 ≥20 payload injeksi; G7 budget habis; G8 breaker; G9 kill-switch; G10 memori tahan ganti model; G11 approval invalid/grup; G12 rantai audit). Gate keras menguji server terhadap model terburuk; kualitas model diukur terpisah, tidak menggate.

## 5. Risiko
| Risiko | Mitigasi |
|---|---|
| Injeksi lewat pesan kanal/output worker/memori/file repo | Blok data ber-delimit, proposal bertipe, Rule of Two, canary secret = 0 |
| Model gratis: 429, loop, privasi (data dikirim ke penyedia) | Breaker provider, budget harian, label privasi di UI, opsi model lokal |
| Central menghabiskan resource (spawn berantai) | ControlGuard: 3/project, 5 global, 20 spawn/hari, depth via `assertCanSpawn`, doom-loop |
| Migrasi v5–v9 merusak DB pengguna | Backup, idempoten, uji salinan DB nyata; v9 bersyarat |
| Hash-chain trigger memblokir kode yang meng-UPDATE `event` | Grep+tes dulu; v9 terakhir |
| File melewati batas Rule 8 (`opencodeRuntime.ts` 306, `turnService.ts` 240, `conversationStore.ts` 284) | Pecah di W0 sebelum menambah kode |
| Skill jahat/terkompromi | Approval R3, hash terkunci, tanpa executable, `permission.skill` |
| Telegram delivery/Managed Bots belum teruji nyata | Fetch palsu untuk unit; uji manual wajib sebelum klaim |
| Flake test (PTY, unix socket `$TMPDIR`) | `TMPDIR=/tmp/st`, port acak, scriptedRuntime |

## 6. Dampak invarian
| Invarian lama | Bunyi baru | Guard |
|---|---|---|
| **I4** Central tidak menulis `fact`/CORE (maks `claim` scope `central`/`scratch`) | Central menulis `claim` scope `central`/`scratch` dan `fact` scope **`user`** hanya dengan `quote` verbatim yang diverifikasi server; tidak pernah `core`, `fact` project, atau scope `global` | `memory.remember_user` memeriksa kutipan di pesan manusia; `trust='attested'`; entri tercatat di `memory_event`; manusia dapat revoke |
| **I5** Central tidak spawn worker | **I5'** Central *mengusulkan* spawn; server mengeksekusi di balik guard. Central tidak memegang `wcap_*`/token atau memanggil `/api/control` | tier R2, `ControlGuard` (jumlah, budget, breaker, level), `req_id` idempoten, audit, kill-switch, approval per aksi (`act_gated`) atau envelope disetujui (`act_envelope`) |
| "`task.run` tidak ada" (08 §5) | `task.run` = tool R2 yang memakai jalur `orchestratorRunRoute` yang sama | `WEBTERM_ORCHESTRATOR_RUN` + `RUN_REQUIRE_APPROVAL`; baru dibuka setelah gerbang S3; `expectedVersion` |
| I2 (env tanpa token) | Tetap; ditambah HOME/XDG khusus (B6) | tes `agentEnv` |
| I3, I6–I10, I13, I14 | Tetap | — |
| I11 (depth ≤2, 3 worker/project, attempt 3, revisi ≤2/10 mnt) | Tetap; ditambah batas global 5 dan spawn/hari | `caps.ts`, ControlGuard |
| I12 (migrasi aditif+backup) | Berlaku untuk v5–v9 | uji migrasi per versi |
| D12 (flag default off) | Bertahap: chat read-only + level `propose` boleh default-on **setelah gerbang S2** | rollout §30b |

## 7. Keputusan produk untuk user dan pertanyaan terbuka
| # | Keputusan | Opsi | Rekomendasi default | Dampak jika salah |
|---|---|---|---|---|
| P1 | Mode aktivasi | `propose` vs `auto` | **`propose`** (kartu approval per aksi) | `auto` salah: spawn tak diinginkan (dibatasi guard/budget); `propose` terlalu ketat: terasa lambat |
| P2 | Tier default aksi agent | R2 (approval) vs R1 | **R2** untuk `agent.spawn`/`task.run`; R1 hanya agen milik central | R1 salah: agen user tersentuh tanpa persetujuan |
| P3 | Worker default tanpa Claude | opencode / codex / gemini | **opencode headless** (model gratis) | Kualitas kode rendah → verifier menolak, biaya attempt |
| P4 | Scope memori `user` di luar git | di `WEBTERM_MEMORY_DIR` luar repo vs dalam repo | **luar git**, per-user | Dalam repo: preferensi pribadi bisa ter-commit/bocor |
| P5 | Central tulis fact `user` dengan kutipan | boleh / harus manusia | **boleh dengan kutipan verbatim** | Terlalu longgar: memori terkontaminasi; terlalu ketat: central "pelupa" |
| P6 | Approval R2 lewat Telegram | web saja / Telegram private | **Telegram private boleh untuk R2, R3 web saja** | Telegram akun dibajak → approval palsu |
| P7 | Worker headless tampil di canvas | tampil / tersembunyi | **tampil sebagai node read-only** | Tersembunyi: pengguna tak melihat apa yang jalan |
| P8 | Merge hasil worktree | manual / otomatis | **manual (R3)** | Otomatis salah: kode tak diinginkan masuk cabang utama |
| P9 | Kanal kedua | Discord / Slack / lain | **Discord interactions** `[dok 26]` | Salah pilih: adapter terbuang (kontrak `ChannelAdapter` tetap) |
| P10 | Bot | satu bot + topic per project / bot per project | **satu bot + topic** dulu | Bot per project: token & manajemen membengkak |
| P11 | Angka budget | harian token/spawn, wall | **1M token, 20 spawn, 120 dtk/turn** `[opini]` | Terlalu rendah: tersendat; terlalu tinggi: biaya/kuota |
| P12 | Model gratis & privasi | gratis default / wajib ber-kredensial | **gratis untuk dev, label privasi; ber-kredensial untuk data sensitif** | Isi repo terkirim ke penyedia gratis |
Pertanyaan terbuka teknis: (1) apakah ada UPDATE/DELETE `event` di kode (syarat v9)? (2) ambang rotasi sesi pasti (usul 70% jendela, hard 85%) setelah diukur; (3) apakah tool kustom OpenCode R0 dengan nonce per-turn cukup aman tanpa MCP? (4) perilaku `fs.watch` macOS untuk kesegaran knowledge.

## 8. Tak terverifikasi
- Klaim eksternal bertanda `[BT]` di `21`–`28` (sebagian karena WebSearch/WebFetch gagal pada worker R&D): Bot API 9.6 Managed Bots, perilaku `compaction.prune`/`--agent`/`OPENCODE_CONFIG_CONTENT` dan efek cache, praktik Factory/Manus, semconv GenAI.
- OpenCode 1.19.5 (hanya 2.0.26 terbukti `[14]`); tool MCP nyata, soak 2×2 minggu, Telegram delivery/webhook publik **belum** terbukti.
- Angka `[opini]`: budget, ambang konteks, 45 dtk idle, 1M token. Belum diukur: biaya/latensi model gratis, ukuran `knowledge.db`, performa FTS trigram pada memori besar, `planRoute` 501 (hanya terbaca `controlApiQuery.ts:26`).
- Tidak dijalankan: test/typecheck (dokumen ini hanya membaca kode); nomor baris benar per 2026-11-03.
