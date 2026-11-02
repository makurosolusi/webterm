# 29 — Arsitektur Final Central Agent v2 (bagian a: §1–§4.5)
Tanggal: 2026-11-03. Status: R&D sintesis, tidak ada kode diubah. Penulis: wkr-rnd-synth-01.
Sumber: `RND/21`–`28`, `08`, `13`, `14`; kode di worktree `chore/rnd-central-v2`. Lanjutan: `29-CA2-ARSITEKTUR-b.md`
(§4.6–§8: skema DB, flag, subsistem, risiko, invarian, keputusan produk, tak terverifikasi). Rencana: `30-CA2-IMPLEMENTATION-PLAN-a.md`/`-b.md`.
Tanda: `[kode]` dibaca di kode sekarang; `[dok]` klaim dokumen RND; `[opini]` pilihan sintesis; `[T]`/`[BT]` terverifikasi/belum (bawaan dokumen asal).

## 1. Ringkasan keputusan
1. **Satu poros: central MENGUSULKAN, SERVER MENGEKSEKUSI.** LLM hanya mengeluarkan proposal bertipe; server memvalidasi, menjaga (jumlah, budget, audit, kill-switch, tier R0–R3), lalu bertindak. Central tidak pernah memegang `wcap_*`/token.
2. **Satu registry tool bertipe (`ToolDef`)** menjadi sumber tunggal untuk validasi, tier, prompt, bridge OpenCode, dan audit. Nama tool ke LLM: `agent.*`, `task.*`, `memory.*`, `skill.*`, `kb.*`, `channel.*`, `project.*`.
3. **Tutup 7 bug nyata dulu (W0)** sebelum fitur apa pun: sesi OpenCode baru tiap turn, turn yatim, `limits:{}`, memori kosong di `central:global`, UNIQUE-NULL, HOME/XDG diwarisi, webhook menunggu LLM.
4. **Otonomi = `central_control.level`** (off|observe|propose|act_gated|act_envelope) di DB sebagai kebenaran; env `WEBTERM_CENTRAL_AGENTS` hanya **batas atas**. Turun seketika, naik hanya lewat transport manusia.
5. **Ledger SQLite tetap satu-satunya kebenaran operasional.** Migrasi berurutan **v5…v9** (satu daftar, satu pemilik). `knowledge.db` terpisah (cache turunan). Skill = file. `channels.json` v2 aditif.
6. **Worker = pekerja terisolasi (worktree)** dengan siklus spec→worker→bukti→verifikasi server; hasil terpercaya hanya dari verifier server, laporan diri worker = petunjuk.
7. **Konteks kebal**: sesi OpenCode berlanjut (`--session`), rotasi di ambang token dengan `central_checkpoint` (fakta deterministik + narasi), prefix stabil, JIT tool.
8. **Memori**: perluas tabel `memory` (v7), file Markdown berversi sebagai kebenaran, FTS5 unicode61+trigram+RRF, embedding opsional. Central menulis `claim` scope `central`; `fact` scope `user` hanya dengan kutipan verbatim yang dicek server.
9. **Provider-agnostic**: OpenCode CLI default (model gratis), adapter lain opsional; tanpa dependency baru di fase 1.
10. **Rollout S0–S5 digerbang bukti** (golden G1–G12), bukan tanggal. Default tetap *off* sampai gerbangnya lulus.

## 2. Temuan dan bukti (kode sekarang)
Bug nyata (verifikasi ulang 2026-11-03; nomor baris bisa bergeser dari klaim dokumen RND):
| # | Gejala | Akar penyebab `[kode]` | Fix (WS) |
|---|---|---|---|
| B1 | Tiap turn memulai sesi OpenCode baru; riwayat hanya dari `history` | `turnService.ts:104-106` `createTurn` tanpa mewarisi `sessionRef` turn sebelumnya; `:185` hanya meneruskan `turn.sessionRef` milik turn baru (selalu null); `opencodeRuntime.ts:139` `input.sessionRef ?? null` | WS-02: ambil `session_ref` turn sukses terakhir per conversation |
| B2 | Conversation terkunci `conversation_busy` selamanya setelah crash | `conversationStore.ts:193-197` menolak bila turn berstatus aktif; `turnService.ts:89` cek `activeTurnId`; tidak ada sweep/reconciler di `central/` (grep `interrupted\|sweep\|recover` nol) | WS-02: reconciler boot → `failed/interrupted` |
| B3 | Tanpa batas langkah/waktu/token per turn | `turnService.ts:184` `limits: {}` | WS-02: isi dari `central_budget` + env |
| B4 | Central global tak punya memori | `memory/contextBuilder.ts:26` `if (scope.kind==='global') return ''` (dok menyebut `:22`) | WS-08 |
| B5 | Fact `central`/`user` (project NULL) bisa duplikat | `ledgerSchemaV1.ts:135` `UNIQUE(project_id, scope, key)`; SQLite memperlakukan NULL berbeda | v7 `uq_memory_key` COALESCE + dedupe dulu |
| B6 | Child OpenCode memakai HOME/XDG pengguna (konfigurasi/sesi/kredensial bocor lintas) | `opencodeOptions.ts:29-32` allowlist memuat `HOME`, `XDG_*` | WS-02: HOME/XDG khusus `<dataDir>/central/home` |
| B7 | Webhook Telegram menunggu LLM sampai 120 dtk (retry Telegram → duplikat/penumpukan) | `telegramWebhookHandler.ts:75` `await runtime.dispatch`; `telegramCentralBridge.ts:10` `TIMEOUT_MS=120_000`, `:33` menunggu `submitted.done` | WS-12: ack cepat + turn async |
Celah kemampuan (fakta kode):
- Hanya 4 tool: `proposalPolicy.ts:9`; kunci terlarang `:10` (`cwd`,`cmd`,`token`,`capability`…). Tidak ada `agent.*`, `task.run`.
- Control plane ada tetapi tak terhubung ke central: `/api/control/{spawn,prompt,wait,close,nodes,token}` `controlApi.ts:28-35`; `plan` → 501 `controlApiQuery.ts:26`; capability TTL 15 mnt (maks 60) `capabilities.ts:76-78`; ack hanya memori (`controlApiStore.ts`).
- Worker hardcoded `claude`: `orchestratorRunModel.ts:16` `DEFAULT_AGENT_ID='claude'`, `orchestratorRunProduction.ts:126` (settings `agentLaunchCommands` sudah ada → QW4).
- Caps: 3 worker/3 attempt/200k token/40 turn `caps.ts:6-12`; timeout worker 300 dtk `workerRuntime.ts:41`; timer otonomi 30 dtk `centralAutonomy.ts:72`; handle timer dibuang `index.ts:65`.
- Migrasi terakhir v4 `ledgerSchema.ts:16-23`; `opencodeRuntime.ts` 306 baris (>300 Rule 8) — pecah sebelum disentuh.
- Tanpa `zod`/validator (hand-written seperti `proposalPolicy.ts`): registry harus tanpa dependency.
Bukti runtime (`14`, `13`): OpenCode 2.0.26 satu turn nyata OK, 4 proposal teruji E2E model gratis; tool MCP nyata, soak, dan Telegram delivery **belum** terbukti.

## 3. Opsi ditolak
| Opsi | Alasan ditolak |
|---|---|
| Framework agen (LangGraph/OpenAI SDK/OpenHands) `[dok 22]` | Runtime berat/Python, daemon tambahan, melanggar provider-agnostic |
| Central memegang `wcap_*` / memanggil `/api/control` langsung | Melanggar I2/I3; token bisa bocor lewat prompt injection |
| `opencode serve` sebagai kontrol utama | Daemon + password tambahan; exec headless cukup (tunda fase 4) |
| Relay antar-agen dengan mengetik ke PTY | Tanpa ack/idempoten, mengganggu agen `working` |
| Protokol A2A penuh | Semua satu proses; pakai kosakata status saja |
| Skill/memori hanya di DB | Tak bisa di-diff, loader CLI baca file; pakai file + indeks SQLite |
| Satu sistem memori kedua / vector DB eksternal | Memori ada (`memory`); embedding opsional brute-force dulu |
| Namespace `app.*` (RND/27) | Satu nama saja: `agent.*` dst. |
| MCP stdio di fase 1 `[dok 09/13]` | `centralMcpServer.ts` tak ada di kode `[dok 25]`; tambah proses+surface; fase 2 |
| Graphify sebagai inti self-knowledge | Eksternal berubah cepat; "Lite Map" di dalam proses, Graphify opsional |
| Tool mutasi bawaan OpenCode (`bash/edit`) untuk central | Default OpenCode `allow` `[T]`; deny eksplisit tetap wajib |

## 4. Rekomendasi konkret
### 4.1 Diagram komponen
```
 Web chat ─┐                                             ┌─ Worker PTY (node canvas)
 Telegram ─┼─> ChannelAdapter ─> TurnService ─> Runtime ─┤   claude|opencode|codex|gemini
 (Discord) ┘   (accountId)       │  lock+idem   (OpenCode│
                                 │  session_ref  CLI,    └─ Worker exec headless (execRunner)
        ContextAssembler <───────┤  scripted/mock)            ▲ worktree + verifier server
   (statis→checkpoint→memori→    │       │ teks/tool                │
    header state→teks user)      │       ▼                          │
   MemoryStore(v7)  KnowledgeDB  │  ProposalParser ─> ToolRegistry(ToolDef) ─> ControlGuard
   SkillStore(files)             │                     validasi, tier R0–R3,   │ level, budget,
                                 │                     tools_hash              │ breaker, kill-switch
                                 ▼                                             ▼
                      central_* tabel (ledger) <── Executor (server) ── approval (/api/approvals)
                      event(+hash chain) <─ audit ── agent_mail ── central_agents ── orchestrator/caps
```
### 4.2 Alur satu turn
1. **Pesan** masuk (web `POST …/messages` atau webhook): adapter menormalisasi `InboundEvent{accountId,externalEventId,…}`; `clientMessageId`/`update_id` idempoten; webhook langsung `200` (WS-12), turn jalan async.
2. **Lock & turn**: `createTurn` (satu aktif per conversation); `session_ref` diwarisi dari turn sukses terakhir (fix B1).
3. **Context assembly**: statis (agent-prompt+skill index+katalog tool ringkas) → checkpoint → memori (≤2.500 token) → header state deterministik (`project.brief`, ≤2.000 char) → teks user di akhir, tak ada timestamp di atasnya. Total dinamis ≤6.000, kira-kira ≤9.500 dengan statis `[opini]`.
4. **Runtime**: `opencode run --format json --session <ref>` dengan `limits` terisi, env diskrub, HOME/XDG khusus, `permission` deny default; cancel <2 dtk; turn ditutup oleh exit proses.
5. **Tool/proposal**: R0 dibaca server dan hasilnya disuntik ke putaran lanjutan (maks `WEBTERM_CENTRAL_MAX_STEPS`, default 2); R1+ berupa blok `<webterm-proposal>` bertipe.
6. **Server guard** (`ControlGuard`): level efektif `min(env, global, project)`, project tak di-pause, hitungan (3 worker/project, 5 global, spawn/hari), budget harian, breaker, doom-loop (digest proposal sama ≥3), kunci terlarang, ukuran.
7. **Efek**: R0 langsung; R1 tulis baris terbatas; R2 → kartu approval (`propose/act_gated`) atau dieksekusi dalam envelope (`act_envelope`); R3 selalu approval + ketik konfirmasi. Idempoten via `req_id`.
8. **Bukti**: audit `central.tool`/`central.proposal` + hash chain; hasil worker lewat verifier server; hasil tool kembali sebagai *digest* di turn berikutnya.
9. **Balasan**: stream SSE/edit kartu Telegram; teks lewat `redactSecrets`; usage → `central_budget`; wake event (approval diputuskan, task selesai) memicu turn proaktif.
### 4.3 Model otoritas final dan tier
Aktor: manusia (root/human token) > server (executor, guard) > central (proposer) > worker (pelaksana tak tepercaya). Central tak pernah `approval.decide`, `memory.promote` (core), mengubah level, atau menerbitkan token. Capability internal dibuat server per aksi (`project:<id>`, `cwdPrefix`, TTL ≤15 mnt), dicabut saat agen ditutup.
| Tier | Arti | Tool (nama resmi) | Min. level |
|---|---|---|---|
| R0 baca | tanpa efek | `portfolio.read`, `project.read/brief/discover`, `kb.search/map`, `node.list`, `task.status`, `run.result`, `agent.list/status/read`, `memory.search/get`, `skill.list/load`, `tool.search` | observe |
| R1 tulis terbatas | baris milik central, reversibel | `goal.propose`, `plan.propose`, `approval.request`, `task.assign`, `memory.remember` (claim), `memory.remember_user`, `skill.propose`, `agent.relay`, `agent.prompt/close` pada agen **milik central** | propose |
| R2 mutasi bersama | menyentuh sumber daya nyata | `agent.spawn`, `task.run`, `agent.prompt/close` pada agen milik user | act_gated (kartu per aksi); act_envelope (otomatis dalam envelope) |
| R3 ireversibel | selalu approval + ketik konfirmasi, tak pernah auto | `project.bootstrap`, `channel.bot.propose`, merge hasil worktree, izin lebih longgar/cwd luar worktree, naikkan budget, kirim ke tujuan tak terdaftar, aktivasi skill | semua level |
Rule of Two: sesi yang memproses teks kanal tidak memegang tool R2/R3 langsung; hanya lewat antrean proposal.
### 4.4 Registry tool bertipe tunggal
`ToolDef{name, summary≤120, tier, caps[], input: validator tulisan tangan, risk, idem(key fn), exec(ctx,input)→digest, audit}` di `src/server/central/tools/toolRegistry.ts` (tipe di `toolTypes.ts`). Satu `execTool(ctx,name,args)`: validasi → `ControlGuard` → tier → efek → audit. Turunan dari registry: (a) `proposalPolicy` (`ALLOWED` dibangkitkan), (b) teks prompt `bridge.text` (default fase 1), (c) tool kustom OpenCode R0-only dengan nonce per-turn (`bridge.opencode`, setelah W1), (d) MCP stdio (fase 2), (e) `tools_hash` dipin per sesi (deteksi rug-pull). `tool.search` = BM25-lite atas `summary`; model lemah mendapat 6 tool inti native. Tool tambahan dari skill hanya R0/R1 via registry yang sama, bukan eksekusi bebas.
### 4.5 Tabel rekonsiliasi
| # | Konflik | Keputusan | Alasan |
|---|---|---|---|
| 1 | Migrasi v5 diklaim 3 dokumen (24, 27, 28) | Satu daftar v5…v9 (§4.6 di b), satu pemilik (WS-01) | Versi tak boleh renumber; satu file `ledgerSchema.ts` |
| 2 | Tangga L0–L4 (28) vs `off\|propose\|auto` (22) | Kebenaran `central_control.level` 5 nilai; `WEBTERM_CENTRAL_AGENTS` = batas atas (off→≤propose, propose→≤act_gated, auto→≤act_envelope) | Persisten, turun seketika; env tetap pagar |
| 3 | `ToolDef`/`app.*` (25) vs `ToolSpec` (27) | `ToolDef`; nama LLM `agent.*` dst.; `ToolSpec` dilebur | Satu tipe, satu nama |
| 4 | Tier `agent.prompt/close`: R1 (22) vs R2 (21 QW3) | R1 pada agen milik central, R2 pada agen milik user | Selaras kepemilikan `central_agents.owner` |
| 5 | Versi OpenCode 1.19.5 vs 2.0.26 | Hanya 2.0.26 terverifikasi `[14]`; pin lewat `opencode --version` saat boot, 1.19.5 `[BT]` | Jangan klaim tanpa bukti |
| 6 | Wall/budget: 30 mnt (caps) / 300 dtk (worker) / 120 dtk (turn) | Tiga lapis berbeda: turn central 120 dtk; satu attempt worker 300 dtk (env); wall task 30 mnt (caps) | Bukan konflik, lapisan beda; angka dapat diubah env |
| 7 | Pagu konteks 6k (13) vs ≈9,5k (23) | Dinamis ≤6.000, total ≈9.500; memori ≤2.500 | 6k = bagian dinamis |
| 8 | Kill-switch `/api/central/agents/halt` (22) vs `central_control` (28) | `POST /api/central/halt` (root) set `level=off` global + tutup agen + cabut capability | Satu mekanisme |
| 9 | Bridge: OpenCode-custom vs MCP vs teks | Fase 1 teks (+R0 bridge OpenCode berflag); MCP fase 2 | Tanpa dependency/proses baru |
| 10 | Memori `knowledge.db` vs ledger | `knowledge.db` terpisah, bukan otoritatif (I12 aman) | Cache turunan, boleh dibuang |
| 11 | `WEBTERM_CENTRAL_AUTONOMY` (ada) vs `AGENTS` (baru) vs `CENTRAL_LEVEL` | AUTONOMY = timer master tetap; AGENTS = batas atas alat agent; level di DB. Tidak ada flag ketiga | Hindari tiga sumber kebenaran |
| 12 | Kill-switch kanal vs `WEBTERM_TELEGRAM` | Kanal tunduk pada `central_control`; `level=off` memblokir turn tool, chat read-only tetap | Satu pagar |
| 13 | Mailbox `agent_mail` vs memori vs skill | Tiga domain terpisah: `agent_mail` = pesan efemer (TTL 24 jam), `memory` = pengetahuan awet, skill = prosedur file | Cegah campur |
| 14 | Checkpoint (23) vs ringkasan memori (24) | `central_checkpoint` untuk kontinuitas sesi; memori `kind='summary'` hanya hasil konsolidasi | Umur berbeda |
| 15 | `task.run` "tidak ada" (08) vs tool R2 (21/22/28) | Dicabut jadi R2 setelah gerbang S3 (§6 di b) | Selaras 28 |
