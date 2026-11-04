# 01 — Inventaris "permukaan kecerdasan" webterm (per 2026-11-04, branch `main` @ 6cf021b)

Ini peta read-only sebagai bahan desain satu control plane (satu registry → CLI + MCP + tool Central + HTTP). Semua path relatif ke `src/server/` kecuali disebut lain. Label **[inferensi]** berarti saya menyimpulkannya dari kode, tidak menjalankannya.

Prinsip yang dipegang (memory `feedback-perkaya-fitur`): kompatibilitas dengan kode lama bukan alasan menolak fitur. Yang dihitung hanya keamanan, kehilangan data, atau biaya.

---

## 1. Cara agent berinteraksi dengan app hari ini

### 1a. Hook Claude Code (hanya untuk agent `claude`)
| Aspek | Bukti |
|---|---|
| Event yang dilanggani (11): SessionStart, UserPromptSubmit, Stop, StopFailure, Notification, PermissionRequest (timeout 540 dtk), SessionEnd, PreToolUse, PostToolUse, SubagentStart, SubagentStop | `hooksSettings.ts:51-63` |
| Mekanisme: tiap event menjalankan satu `curl` catch-all → `POST /api/agent-status?node=<id>`. Header dibaca dari file 0600 (`-H @file`), jadi token tidak muncul di argv | `hooksSettings.ts:93-113`, `writeClaudeSettings` `:127-141` |
| Diaktifkan lewat flag `--settings <file>` pada baris peluncuran | `hooks.ts:62-80` |
| Hanya untuk `claude`: `CLAUDE_HOOK_SETTINGS_CAPABLE = ['claude']` | `../shared/workspace.capabilities.ts:120` |
| Payload hook → status: `hookStatus()` (Notification bercabang per `notification_type`, event subagent tidak menggerakkan induknya) | `hookStatus.ts:44-115` |
| Route menulis status + `transcript_path`, lalu **membalas `additionalContext`**. Ini satu-satunya kanal PUSH ke konteks agent | `agentStatusApi.ts:93-174` |
| Pemeriksaan token→node tanpa syarat. Mode strict (`WEBTERM_STRICT_HOOK_AUTH`) memverifikasi token dan root path transcript | `agentStatusApi.ts:104-136` |

**Kesadaran (awareness) yang didorong lewat hook**
- `hookContext.ts:125-176`: roster peer context-link (edge di canvas), di-dedup antar turn, dengan batas ukuran `additionalContext`.
- `linkAwareness.ts:23-91`: pemberitahuan saat kabel ke browser node berubah. Hanya maju pada SessionStart/UserPromptSubmit (`:77-82`).
- `linkNote*.ts`: **mengetik** catatan `[webterm]` yang terlihat ke PTY Claude yang sedang idle. Ada poll tiap 1 dtk atas semua workspace (`linkNoteDelivery.ts:131-143`, ada komentar `ponytail:` di `:13`). Pengirimannya dijaga pembacaan layar composer (`linkNoteComposer.ts:112`). Dedup dengan hook lewat `linkNoteTold` (`:146`).

### 1b. Env yang disuntikkan ke sesi agent
`sessions.ts:73-87`:
- `WEBTERM_TOKEN` = token **node** (bukan root).
- `NODETERM_NODE_ID` dan `NODETERM_PORT` untuk agent yang context-capable (`CONTEXT_LINK_CAPABLE`: claude/codex/gemini/opencode…, `workspace.capabilities.ts:76`).
- `hookEnv` (`NODETERM_NODE_TOKEN`, dan `NODETERM_PERM_WAIT_SECS` bila `hookReplyApprovals` aktif) (`hooks.ts:37-43`).

### 1c. Shim + skill yang dipasang untuk agent (ditulis ulang tiap boot)
| Skill | Shim (sh + curl) | Endpoint | Dipasang di |
|---|---|---|---|
| `webterm-linked-context` | `<dataDir>/context-links/…`: verb `list`, `transcript`, `summary`, `terminal`, opsi `--node`, `-n` | `GET /api/context-link` | `contextLinkSkill.ts:23-124` → `~/.claude/skills/webterm-linked-context/SKILL.md`; route `contextLinkRoute.ts:57-67` |
| `webterm-browser` | `<dataDir>/browser-agent/webterm-browser`: 11 verb (status/snapshot/screenshot/wait/navigate/click/type/press/scroll/handoff/release) | `/api/control/browser/[node/]verb` | `browserAgentShim.ts:22-135`; dipasang malas `index.ts:141` |

Catatan: skill hanya ditulis ke `~/.claude/skills`. OpenCode juga memuat folder itu (RND/25 §2b), tetapi Codex/Gemini tidak mendapat penemuan skill. Tidak ada MCP untuk agent terminal.

### 1d. Token, capability, auth
| Lapisan | Bukti |
|---|---|
| Token root `x-webterm-token` menggerbangi `/api/*` | `auth.ts:22`, `authorizeRequest :140` |
| Token node (UUID, **in-memory**, satu per node) hanya membuka `/api/agent-status`, `/api/context-link`, `/api/control/*` | `hooksTokens.ts:15-36`, `auth.ts:121-127` |
| Capability `x-webterm-capability` (`wcap_…`, in-memory `CapabilityStore`, TTL 15 mnt default / 60 mnt maks), dengan 12 verb: node.spawn/prompt/wait/close/read, plan.read, approval.request/decide/consume/read, browser.read/act | `control/capabilities.ts:12-38,80-82,169` |
| Mint lewat `POST /api/control/token` hanya untuk token root + `WEBTERM_ALLOW_TOKEN_MINT=1` (env saja) | `control/mount.ts:57-66`, `controlApiQuery.ts:55` |
| Route control: spawn/prompt/wait/close/nodes/plan/token, dengan sub-keluarga approval dan browser | `control/controlApi.ts:28-34`, `control/mount.ts:136-179`, `control/approvalApi.ts:291-297` |
| **Agent terminal praktis tidak bisa spawn/prompt node lain.** `authorize` mewajibkan header capability (`controlAuth.ts:15-34`), dan tidak ada jalur yang mencetak capability untuk sesi PTY. Satu-satunya jalur node-token yang bekerja adalah browser (target diambil dari kabel, `browserControl.handler.ts:1-3`) | **[inferensi]** dari kode |
| Approval dari UI menolak kredensial agent | `docs/decisions/approval-ui-origin.md`, `approvalAuth.ts` |

---

## 2. Central Agent v2

### 2a. Runtime
- Abstraksinya ada di `central/runtime/centralRuntime.ts`. Ada tiga implementasi: claude (`claudeRuntime.ts`, `claudeSession.ts`), opencode (`opencodeRuntime.ts`), dan mock. Deteksinya di `runtimeDetect.ts` (codex sengaja tidak ada).
- Claude dijalankan **tanpa tool dan tanpa MCP**: `-p --output-format stream-json --tools <none> --strict-mcp-config --permission-mode dontAsk --safe-mode` (`claudeOptions.ts:86-101`). Env anak disaring: tanpa `WEBTERM_`/`NODETERM_`/kunci provider/`wcap_` (`:60-75`).
- OpenCode: tool yang memutasi ditolak kecuali `WEBTERM_OPENCODE_ALLOW_TOOLS=on` (`opencodeOptions.ts:12,65-67`).
- Preflight `claude auth status` di-cache (`claudePreflight.ts`).

### 2b. Protokol tool = teks, bukan function-calling
- Model menulis `<webterm-proposal>{tool,input}</webterm-proposal>`, maksimal 4 blok × 16 KiB (`proposal/proposalParser.ts:1-8`).
- Tool R0 dieksekusi server dalam loop lanjutan. Default 2 ronde (`WEBTERM_CENTRAL_MAX_STEPS`, maksimal 10) (`chat/toolLoop.ts:1-20`).
- Tool tulis masuk pipeline proposal → kartu approval (`proposal/proposalPolicy.ts`, `applyProposal.ts`).
- Katalog tool dirender ke prompt dengan batas **1200 token**. Tool yang tidak muat **dibuang diam-diam** (`tools/toolRegistry.ts:4,34-45`).
- Ada jalur lama yang paralel: `DEFAULT_CENTRAL_TOOLS = ['portfolio.read']` (`chat/toolExecutors.ts:16`, dipakai `turnService.ts:214`).

### 2c. Registry tool (`tools/registerAll.ts:47-57`, `toolTypes.ts:40-59`)
`ToolDef` = {name, summary, tier, usage (teks skema), flag | enabled(), projectScoped, validate, handler, auditKeys}. Eksekusinya lewat `execTool` (`toolExec.ts:11`).

| Grup (gerbang) | Tool : tier |
|---|---|
| read (`central`) | project.list/read R0, node.list R0, task.status R0, run.result R0 |
| memory (`central`) | memory.search/get R0, memory.remember R1, memory.remember_user R1 |
| agents (`WEBTERM_CENTRAL_AGENTS` = propose\|auto) | agent.list/status/read R0, agent.spawn R2, agent.prompt/close R1 (naik ke R2 untuk agent milik user, `agent.defs.ts:47-51`), agent.kinds; task.run R2 |
| mail (`WEBTERM_AGENT_MAIL`) | agent.relay R1 |
| knowledge (`WEBTERM_KNOWLEDGE`) | kb.search, kb.map, project.brief, project.discover: R0 |
| skills (`WEBTERM_CENTRAL_SKILLS`) | skill.list/load R0, skill.propose R1 (tidak ada tool approve: hanya manusia) |
| bots (`WEBTERM_CENTRAL_BOTS`) | channel.bot.propose R3 |
| browser (`WEBTERM_BROWSER`) | browser_status R0, browser_act R2 (navigate/click/type saja) |
| core | approval.request, goal.propose, plan.propose, task.assign: R1 (`core.defs.ts`) |

Penamaan tidak konsisten: `browser_status`/`browser_act` memakai underscore, tool lain memakai titik.

### 2d. Guard, level, budget
- Ada satu gerbang server untuk tiap efek: level → jeda project → cap → budget → doom-loop → breaker, semuanya diaudit (`guard/controlGuard.ts:1-26`).
- Tangga level: off / observe / propose / act_gated / act_envelope (`contracts/level.types.ts:6`), tersimpan per scope di `central_control` (`guard/levelStore.ts:9`, default `propose`).
- Tier minimum ke level: `R0:observe, R1:propose, R2:act_gated, R3:propose` (`controlGuard.ts:26`).
- Cap: 3 worker per project, 5 global. Doom-loop: digest sama 3× dalam 10 mnt (`:14-18`).
- Budget dan breaker di `central_budget`/`central_breaker` (`ledger/ledgerSchemaV5.ts`). Halt lewat `guard/haltApi.ts` (`/api/central/halt`).

### 2e. Ledger (`<dataDir>/ledger.db`, skema V1–V9)
- Inti: `project` (workspace_id UNIQUE, goal_json, budget_json, status, priority), `agent`, `task`, `run` (provider/model/prefix_hash/tools_hash), `event`, `decision`, `approval`, `usage` (input/output/cache_read/cache_write/cost), `prefix`, `budget`, `memory`, `memory_event`.
- Tambahan: `plan`/`plan_item` (V2), `request_ack` (V3), `central_conversation/message/turn/event` (V4), `central_control/breaker/budget` (V5), `central_agents`/`agent_mail` (V6), `memory_embedding` + FTS `memory_fts`/`memory_fts_tri` (V7), `central_checkpoint` (V8), `capability_audit` (V9).
- Pemicu append-only event **belum didaftarkan**: `TODO(ca2-audit)` di `ledgerSchemaV9.ts:5`.

DB lain: `webterm.db` (workspace + app/settings, `db.ts:22-27`), `knowledge.db` (`ca2Boot.ts:45`: kb_meta, kb_project, project_source, kb_file, FTS kb_doc), `channels.json` (`channels/channelStoreSchema.ts:8`), memori user berupa `.md` di `WEBTERM_MEMORY_DIR/user/` (`memory/memoryUserStore.ts`), dan skill di `central_skill` + folder builtin/proposed/versions (`skills/skillIndex.ts:36-54`). Ledger dan workspace **tidak bisa di-JOIN** karena berada di file yang berbeda (`central/workspaceLookup.ts:1-2`).

### 2f. Planner, worker, otonomi
- Planner: `WEBTERM_CENTRAL_PLANNER` (`chat/turnService.ts:118`). Plan dan assign ada di `orchestrator/plan.ts` dan `orchestratorAssign.ts`.
- Worker: `orchestrator/workerRuntime.ts` (worktree → spawn → prompt → tunggu → verifikasi → record). Worker headless memakai `agents/execRunner.ts` (argv, tanpa shell). Host agent Central ada di `agents/agentHost.ts`, `agentExecutor.ts`, `agentStateMachine.ts`, `agentReconciler.ts`. `task.run` masuk lewat `orchestrator/runTaskInProcess.ts`, yang memakai ulang route HTTP.
- Otonomi: tiap tick mengambil satu plan item yang sudah di-assign. Otonomi tidak pernah membuat plan atau meng-approve (`centralAutonomy.ts:1-5`). Bisa dinyala-matikan saat jalan (`centralAutonomyBoot.ts:1-6`). Dispatcher non-blocking dengan inflight 3 (`autonomyDispatch.ts:11-15`). Waker di-debounce 250 ms dengan sweep 60 dtk, dan **satu-satunya pemicunya `worker_settled`** (`wake.ts:7-8`, `centralAutonomy.ts:190`).

### 2g. Telegram dan kanal
- Bridge Central↔Telegram aktif bila `central`+`telegram` aktif (`channels/telegramCentralBridge.ts`, timeout 120 dtk). Approve/deny lewat chat menerjemahkan perintah ke `ledger.approval` (`channelApprovals.ts`).
- Perintah: status, pause, resume, approve/reject, help. Pairing, binding, pending, webhook atau poll ditangani di `channels/*`. Belum ada Discord (P9).

### 2h. Skill Central (builtin)
Ada empat: `webterm-central-basics`, `webterm-approval-flow`, `webterm-project-status`, `webterm-skill-authoring` (`central/skills/builtin/*/SKILL.md`). Skill ini terpisah total dari skill yang dipasang untuk agent terminal (§1c).

---

## 3. Memori, konteks, cache yang sudah ada

| Mekanisme | Bukti | Status |
|---|---|---|
| Memori ledger: claim (agent) vs fact (human/attested), scope central/user/project | `memory/memoryRemember.ts`, `memoryCore.ts` | aktif |
| Pencarian hybrid: FTS unicode61 + trigram, RRF, rerank, visibilitas di SQL | `memory/memoryHybrid.ts:1-4` | aktif. **Leg embedding belum ada** (`:118` TODO(ca2-08), `WEBTERM_EMBED_URL` tak berklien) |
| Blok memori per turn, batas token, data ≠ instruksi | `memory/memoryBlock.ts`, `central/memory/contextBuilder.ts` (limit 6) | aktif |
| Konsolidasi deterministik (hash dedupe, arsip claim kedaluwarsa) | `memory/memoryConsolidate.ts` | ada, **tanpa scheduler [inferensi]** |
| Fact sebagai file + commit git | `memory/memoryFile.ts` (`WEBTERM_MEMORY_FILES`, default off) | opsional |
| Assembler konteks yang ramah prefix-cache (static → checkpoint → memori → header → user) | `central/context/contextAssembler.ts:1-23` (`WEBTERM_CENTRAL_CHECKPOINT`) | di balik flag |
| Checkpoint rolling **tanpa LLM** + rotasi sesi 70%/85% | `context/checkpointRolling.ts`, `rotationPolicy.ts` | heuristik |
| Header state deterministik ≤2000 char | `context/contextHeader.ts:1-8` | aktif |
| Indeks knowledge inkremental (git head + dirty hash, tanpa watcher) + `project.brief` ≤800 token | `knowledge/knowledgeFresh.ts`, `knowledgeBrief.ts`, `knowledgeScan.ts` | di balik `WEBTERM_KNOWLEDGE` |
| Kesinambungan sesi Claude Central (`--resume`) | `claudeOptions.ts:96-99` | aktif |
| Akuntansi prompt cache: kolom `usage.cache_read/write_tokens`, `run.prefix_hash`/`tools_hash` | `ledger/ledgerSchemaV1.ts:56,98-114` | dicatat. **Tabel `prefix` tidak pernah di-INSERT** [inferensi: grep tanpa writer] |
| Transcript agent terminal: hanya *path* dari hook, dibaca saat diminta | `agentStatusApi.ts:148-153`, `contextLinkTranscript.ts` | aktif (claude) |
| Tidak ada: memori lintas agent terminal, ringkasan otomatis sesi node, cache hasil tool, embedding | — | gap |

---

## 4. Event: apa yang ada dan dari mana

Tidak ada bus tunggal. Ada delapan sumber, masing-masing dengan transport sendiri:

| Sumber | Transport | Bukti |
|---|---|---|
| PTY output/exit/status, fsdirty | WS `ServerMsg` (`output`/`exit`/`status`/`fsdirty`) | `../shared/protocol.ts:18-27`, `subscribers.ts` |
| Hook Claude (11 event) | HTTP masuk, langsung dipetakan ke status (tidak disimpan sebagai event) | §1a |
| Ledger `event` (goal.*, project.paused/resumed/priority, orchestrator.*, worker.run, agent.spawn, autonomy.*, memory.claim, central.tool/agent/guard/control, git.push, channel.telegram.*) | baris SQLite, tarik lewat `listEvents` | `ledger/ledgerEvent.ts:82-125`, `goalStore.ts` |
| Chat Central | `central_event` + `StreamHub` SSE (replay per seq) | `central/chat/streamHub.ts:8-52`, `centralChatSse.ts` |
| System log (tag terstruktur, sudah diredaksi) | `logBus` + SSE `/api/logs/stream` | `logs/logBus.ts`, `logSse.ts` |
| Browser CDP | router internal | `browser/browserHost.events.ts:28` |
| Telegram update | poll/webhook | `channels/telegramPoll.ts`, `webhook.ts` |
| Perubahan workspace/kabel | **tidak ada event**: di-poll 1 dtk oleh linkNote | `linkNoteDelivery.ts:11-13` |

Banyak timer poll yang terpisah: linkNote 1 dtk, sweep waker 60 dtk, tick otonomi, `agentReconciler`, `turnReconciler`, poll telegram. Sebagian besar bisa menjadi subscriber satu bus.

---

## 5. Duplikasi dan hardcoding

| # | Kapabilitas | Implementasi ganda | Catatan |
|---|---|---|---|
| D1 | Registry "apa yang boleh dilakukan" | (a) `CAPABILITY_VERBS` control (12), (b) `ToolDef` Central (~35), (c) `BROWSER_VERB_CAP` (11, `shared/browser.contract.ts:177`), (d) case verb di shim sh, (e) verb context-link (list/transcript/summary/terminal), (f) route orchestrator root-only, (g) `DEFAULT_CENTRAL_TOOLS` lama | Tujuh daftar dan tiga model otorisasi (capability, tier+level, token root). |
| D2 | Spawn agent | `POST /api/control/spawn` (PTY, `controlApiSessions.ts:25`), `/api/orchestrator/spawn` + `workerRuntime`, `agent.spawn` (`agentHost`/`execRunner`), `task.run` → `runTaskInProcess` → route HTTP | Empat pintu dan dua runner (PTY vs headless). |
| D3 | Approval | `/api/control/approval/*` (capability), `/api/approvals*` (manusia), `ledger.approval`, Telegram `channelApprovals`, `orchestratorRunApproval`, kartu proposal Central, handoff browser, hook `PermissionRequest` | Ledger memang satu, tetapi ada lima atau lebih adapter. `PermissionRequest` hanya menjadi badge `blocked`; **tidak ada jalur balasan allow/deny** walaupun `NODETERM_PERM_WAIT_SECS` disuntikkan (`hooks.ts:37-43`). Knob itu praktis mati [inferensi: tidak ada pembaca `permissionDecision`]. |
| D4 | Browser | Shim (11 verb) dan `browser_act` (3 verb) sama-sama lewat `handleBrowserControl`. Bagian ini sudah relatif bersatu (`browser.act.ts:1-4`) | Central **tidak punya snapshot**, padahal click/type butuh `snapId` (`browser.act.ts:22`, `browser.status.ts:49`). |
| D5 | Membaca node | `agent.read` (agent Central), `node.list` (tanpa isi), context-link `terminal`/`transcript` (agent terminal saja), `/api/control/nodes` | Central tidak bisa membaca transcript atau scrollback node milik user. |
| D6 | Penemuan skill | `~/.claude/skills` ditulis tiap boot (2 skill) vs `central_skill` + builtin (4) | Dua sistem skill tanpa jembatan. |
| D7 | Awareness push | `additionalContext` hook (Claude), ketikan linkNote (Claude), tidak ada apa pun untuk codex/gemini/opencode | Hanya Claude yang sadar. |
| D8 | Status agent | Hook → status, `agentStale.ts` (sweep di shared), `agentStateMachine` Central, `NodeRegistry` (`nodeRegistry.ts:86`) | Empat model state. |

**Knob yang hanya ada di env (tanpa UI)**: dari 98 nama `WEBTERM_*` yang dirujuk, flag rilis berikut hanya dihormati sebagai "anak legacy" bila induknya aktif dan tidak punya sakelar sendiri: `WEBTERM_KNOWLEDGE`, `CENTRAL_SKILLS`, `CENTRAL_SKILL_PROPOSE`, `AGENT_MAIL`, `CENTRAL_RELIABILITY`, `OPENCODE_ALLOW_TOOLS`, `CENTRAL_BOTS`, `CHANNEL_APPROVAL_BUTTONS` (`featureCapabilities.legacy.ts:9-13`). Knob lain yang env-only: `CENTRAL_CHECKPOINT`, `CENTRAL_MAX_STEPS`, `CENTRAL_TURN_*`, `CENTRAL_DAILY_*`, `ALLOW_TOKEN_MINT` (persis `1`), `STRICT_HOOK_AUTH`, `MEMORY_FILES`, `EMBED_URL`. Ini bertentangan dengan memory `feedback-zero-config`.

**Konstanta keras**: tier per tool di kode, cap worker 3/5, doom 3/10 mnt, katalog 1200 token, blok memori 2500 token, header 2000 char, brief 800 token, poll 1 dtk, TTL capability 15/60 mnt, port fallback `8700` di dua shim.

---

## 6. Gap terhadap "asisten god-mode yang punya tempat"

1. **Tidak ada satu control plane.** Tool Central hanya bisa dipakai Central lewat teks proposal. Agent terminal (Claude/Codex/…) tidak bisa memanggil `project.brief`, `memory.search`, `kb.search`, atau `plan.*`, dan tidak ada MCP server maupun CLI `webterm` umum. Registry ToolDef sudah hampir siap dijadikan sumber tunggal (sudah punya name/tier/usage/validate/handler/audit), tetapi skemanya berupa teks `usage`, bukan JSON Schema, sehingga belum bisa dipakai MCP dan CLI.
2. **Central tidak punya function-calling native.** Claude Central berjalan `--tools none --strict-mcp-config`. Kalau webterm sendiri menyediakan MCP stdio/HTTP yang di-gate guard, `--mcp-config` bisa menggantikan parser teks tanpa melepas batas kepercayaan.
3. **Agent terminal tidak bisa mengorkestrasi.** Belum ada capability yang dicetak per node (misalnya `node.spawn` dibatasi ke workspace sendiri), belum bisa membuka browser node dari agent (CHANGELOG "Not yet available"), dan belum bisa membuat node di canvas dari control API (spawn hanya membuat PTY) [inferensi].
4. **Tidak ada event bus.** Kabel di-poll, hook tidak disimpan, ledger cuma bisa ditarik. Akibatnya otonomi hanya bangun pada `worker_settled` dan tidak bereaksi pada "agent X blocked", "test gagal", "file berubah", "pesan Telegram", atau trigger `event` V9 (ditunda).
5. **Awareness hanya untuk Claude.** Codex/Gemini/OpenCode di node tidak mendapat roster, catatan kabel, status, atau skill. Belum ada adapter hook per CLI.
6. **Approval izin tool agent terminal tidak tertutup.** `PermissionRequest` → badge saja. Belum ada approve dari Inbox/Telegram yang menjawab hook.
7. **Memori belum lintas permukaan.** Memori ledger hanya untuk Central. Agent terminal tidak bisa menulis atau membaca, dan sesi node tidak diringkas otomatis ke memori. Embedding, konsolidasi terjadwal, dan checkpoint LLM juga belum ada.
8. **Cache:** prefix cache hanya dicatat (tabel `prefix` mati), belum ada cache hasil tool R0 (misalnya `project.brief` per git head), dan katalog >1200 token membuang tool secara diam-diam.
9. **Identitas dan sesi rapuh:** token node dan capability in-memory, dan reconcile sesudah restart hanya untuk turn atau agent Central.
10. **Tiga DB tanpa JOIN** (webterm.db / ledger.db / knowledge.db) ditambah channels.json, jadi tidak ada satu "world model" yang bisa di-query.
11. **Flag sprawl:** sekitar 8 flag rilis CA2 tanpa sakelar UI, dan level, tier, serta budget diatur dari env atau konstanta, bukan dari satu panel Control.

**Kandidat pertama yang jelas untuk desain:** angkat `ToolDef` menjadi registry tunggal dengan JSON Schema dan pemetaan verb capability. Dari situ: (a) katalog Central, (b) MCP server webterm untuk agent node dan Central, (c) shim/CLI `webterm <tool>` yang di-generate, (d) route `/api/tools/:name`. Semuanya lewat satu `execTool` + `controlGuard` + audit. Shim browser, context-link, dan `CAPABILITY_VERBS` kemudian menjadi turunan registry itu.
