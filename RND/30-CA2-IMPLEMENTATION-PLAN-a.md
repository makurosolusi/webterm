# 30 — Rencana Implementasi Central Agent v2 (bagian a: peta workstream)
Tanggal: 2026-11-03. Penulis: wkr-rnd-synth-01. Induk: `29-CA2-ARSITEKTUR.md` + `-b`. Lanjutan: `30-CA2-IMPLEMENTATION-PLAN-b.md` (quick-win, spec siap-tempel, gerbang, eval, dependency, risiko).
Singkatan path: `S/` = `src/server/`, `C/` = `src/server/central/`, `T/` = `src/server/central/tools/`, `K/` = `src/client/`. Semua file baru kecuali ditulis **(edit)**. Ukuran = baris baru perkiraan `[opini]`; tiap file harus lolos Rule 8 (route 150, service 300, repo 250, test 400).
Kontrak bersama dibuat WS-04 di `C/contracts/*.types.ts`; W1 mengode terhadap tipe itu dengan mock, bukan terhadap implementasi WS lain.

## 1. Gelombang dan DAG
```
W0 fondasi (4 WS, file-disjoint, boleh paralel; merge berurutan 01→02→03→04)
  WS-01 migrasi+flag   WS-02 bug turn   WS-03 registry   WS-04 kontrak tipe
        │                   │                │                 │
W1 paralel besar (11 worker; semua butuh W0 merge) ──────────────────────
  WS-05 read-tools+loop  WS-06 context  WS-07 guard+level  WS-08 memori
  WS-09 agent.*          WS-10 worker+task.run   WS-11 mailbox   WS-12 channel-core
  WS-14 skill            WS-15 knowledge         WS-16a eval-harness
        │
W2 integrasi (5 worker)
  WS-13 bots(←12)  WS-17 reliabilitas(←07,09)  WS-18 UI(←07,09,14)  WS-16b golden  WS-19 integrator(←semua W1)
        │
W3  WS-20 dokumen (SATU worker, Rule 23)
```
Merge W0 sebelum W1 dimulai. Dalam gelombang, tak ada dua WS yang memiliki file yang sama. Orkestrator membuat branch dari `main` per WS; W1 dari `main` setelah W0 di-merge (atas persetujuan user, Rule 2).

## 2. File titik panas dan pemilik per gelombang
| File | W0 | W1 | W2 |
|---|---|---|---|
| `S/ledger/ledgerSchema.ts`, `ledger/ledgerSchemaV5..V9.ts`, `migration.bun.test.ts` | WS-01 | — (terkunci) | — |
| `S/envRegistry.ts`, `envRegistry.central.ts`, `envRegistry.ca2.ts` (baru), `envRegistry.test.ts` | WS-01 | — (flag dibaca via `envFlag.ts`) | WS-19 |
| `S/index.ts`, `S/api.ts` | — | — | WS-19 (satu-satunya) |
| `C/chat/turnService.ts` | WS-02 | WS-05 | — |
| `C/proposal/centralPrompt.ts` | WS-03 | WS-06 | — |
| `C/proposal/proposalPolicy.ts`, `applyProposal.ts`, `proposalParser.ts` | WS-03 | — | WS-19 (bila perlu) |
| `C/centralAutonomy.ts`, `S/centralAutonomyBoot.ts` | — | — | WS-17 |
| `S/channels/**` | — | WS-12 | WS-13 (hanya file baru bot + `channelsRuntime.ts` mount) |
| `K/Dock.tsx`, `K/App.tsx`, `K/central/**` | — | — | WS-18 |
| `T/registerAll.ts` (baru) | — | — | WS-19 |
Pola integrator: W1 hanya mengekspor fungsi/route handler murni + mendaftar ke registry lokal di test. Penyambungan ke `index.ts`/`api.ts`/`registerAll.ts`/flag dilakukan WS-19 sekali, mengurangi konflik.

## 3. Katalog workstream
Format: **ID — branch** · tujuan · **file** (baru/edit) · kontrak (konsumsi→ekspos) · test+flag · ukuran · deps.

**WS-01 — `feature/ca2-migrations-flags`** · Tutup v5–v9 dan daftar flag baru. File: `S/ledger/ledgerSchemaV5.ts`…`V9.ts`; **edit** `ledger/ledgerSchema.ts`, `ledger/migration.bun.test.ts`, `S/envRegistry.ts`, `S/envRegistry.central.ts`, `S/envRegistry.test.ts`; baru `S/envRegistry.ca2.ts`. Ekspos: tabel+kolom `29-b §4.6`, flag `29-b §4.7`. Test: `bun test src/server/*.bun.test.ts` (v4→v9 dua kali idempoten, backup, dedupe NULL-project, v9 trigger menolak UPDATE/DELETE `event`); vitest `envRegistry.test.ts` (default off). Flag: semua baru. ~130×5 DDL + 120 reg + 400 test. Deps: —. (v9 hanya bila bukti grep UPDATE/DELETE `event` nol; jika tidak, dibiarkan stub terdokumentasi.)

**WS-02 — `feature/ca2-turn-fixes`** · Tutup B1, B2, B3, B6 dan buat seam context. File **edit**: `C/chat/turnService.ts`, `C/chat/turnPersistence.ts`, `C/conversationStore.ts`, `C/runtime/opencodeRuntime.ts` (pecah dulu, 306 baris), `C/runtime/opencodeOptions.ts`; baru `C/chat/turnReconciler.ts`, `C/chat/turnLimits.ts`, `C/runtime/opencodeSession.ts`, `C/context/contextPort.ts` (`ContextAssembler{build(input)→{prompt,history}}`, default = perilaku lama). Ekspos: `reconcileTurns(db,now)`, `resolveLimits(env)`, `sessionRefFor(conv)`, `HOME/XDG` khusus `<dataDir>/central/home`. Test vitest + bun: sesi dilanjutkan antar turn (assert argv `--session`), reconcile turn `running`→`failed/interrupted` dan conversation bebas, `limits` terisi dari env, env child tanpa HOME pengguna. Tanpa flag baru (bug-fix). ~250 + 400 test. Deps: —.

**WS-03 — `feature/ca2-tool-registry`** · Registry `ToolDef` tunggal; pindahkan 4 tool lama. File baru: `T/toolTypes.ts`, `T/toolRegistry.ts`, `T/toolExec.ts`, `T/toolAudit.ts`, `T/defs/core.defs.ts` (goal/plan/assign/approval); **edit** `C/proposal/proposalPolicy.ts`, `proposalParser.ts`, `applyProposal.ts`, `centralPrompt.ts`. Ekspos: `ToolDef`, `createRegistry()`, `registry.register/list/get`, `execTool(ctx,name,args)`, `toolsHash()`, `renderCatalog(tier≤)`, `ALLOWED` diturunkan. Test: semua test `proposal.test.ts` tetap hijau; matriks allow/deny; kunci terlarang; `toolsHash` stabil. Flag: —. ~280 + 400. Deps: —.

**WS-04 — `feature/ca2-contracts`** · Tipe kontrak lintas-WS. File baru `C/contracts/{level,tool,agent,mail,memory,skill,channel,knowledge,context}.types.ts` (tiap ≤300): `ControlLevel`, `Tier`, `ControlGuard`, `ToolCtx`, `AgentRecord/AgentState`, `MailRecord`, `MemoryBlockProvider`, `SkillStore`, `ChannelAdapter/InboundEvent`, `KnowledgePort`. Test: `tsc --noEmit` + satu test tipe (`expectTypeOf`). ~250 total. Deps: — (selaras 29-a/b; WS-03 menyesuaikan `ToolCtx`).

**WS-05 — `feature/ca2-read-tools`** · Tool baca server-side + putaran lanjutan (QW2). File baru `T/defs/read.project.ts`, `read.node.ts`, `read.task.ts`, `C/chat/toolLoop.ts`; **edit** `C/chat/turnService.ts`. Ekspos: `project.read`, `node.list`, `task.status`, `run.result`; `runToolLoop(maxSteps)`. Test: hasil R0 disuntik ke putaran kedua, maks `MAX_STEPS`, output dipotong+redaksi. Flag: `WEBTERM_CENTRAL_MAX_STEPS`. ~300 + 400. Deps: 02, 03.

**WS-06 — `feature/ca2-context`** · Kontinuitas, checkpoint, prefix stabil (QW1). File baru `C/context/contextAssembler.ts`, `contextHeader.ts`, `checkpointStore.ts`, `checkpointSummarizer.ts`, `rotationPolicy.ts`, `contextUsage.ts`; **edit** `C/proposal/centralPrompt.ts`. Mengkonsumsi `MemoryBlockProvider` (mock). Test: urutan prefix statis→checkpoint→memori→header→teks; `facts_json` deterministik dari ledger; rotasi di ambang; fallback saat summarizer gagal; tak ada timestamp di atas teks user. Flag: `WEBTERM_CENTRAL_CHECKPOINT`. ~1.100 total. Deps: 01(v8), 02, 04.

**WS-07 — `feature/ca2-guard-control`** · `ControlGuard`, `central_control`, breaker, budget, halt. File baru `C/guard/controlGuard.ts`, `levelStore.ts`, `breakerStore.ts`, `budgetStore.ts`, `haltApi.ts` (handler murni `POST /api/central/halt`, `GET/PUT /api/central/control`). Ekspos: `effectiveLevel(projectId)=min(env,global,project)`, `guard.check`, `recordUsage`, `breaker.allow/trip`. Test bun: turun level seketika, breaker bertahan lintas restart, `budget_exhausted`, halt root-only. Flag: `WEBTERM_CENTRAL_AGENTS`, `_DAILY_*`. ~950. Deps: 01(v5), 04.

**WS-08 — `feature/ca2-memory`** · Memori v7: scope/aktor, RRF, atestasi, B4. File **edit** `S/memory/memoryModel.ts`, `memorySearch.ts`, `memoryWrite.ts`, `C/memory/contextBuilder.ts`; baru `S/memory/memoryRrf.ts`, `memoryAttest.ts`, `memoryConsolidate.ts`, `T/defs/memory.defs.ts`. Ekspos: `MemoryBlockProvider` nyata, `memory.search/get/remember/remember_user`. Test: global conversation kini punya memori, UNIQUE tanpa duplikat, kutipan non-verbatim ditolak, canary secret 0, recall fixture. Flag: `WEBTERM_CENTRAL_MEMORY`, `WEBTERM_EMBED_*`. ~1.000. Deps: 01(v7), 03, 04.

**WS-09 — `feature/ca2-agent-tools`** · `agent.list/status/read/spawn/prompt/close`. File baru `C/agents/agentStore.ts`, `agentStateMachine.ts`, `execRunner.ts`, `agentExecutor.ts`, `T/defs/agent.defs.ts`. Konsumsi: `ControlGuard`, `spawnSession` (hanya lewat deps injeksi). Test: state machine transisi sah/tidak, `req_id` idempoten, owner R1/R2, crash antara intent/done → adopsi, argv exec array tanpa shell. Flag: `WEBTERM_CENTRAL_AGENTS`. ~1.200. Deps: 01(v6), 03, 04.

**WS-10 — `feature/ca2-worker-run`** · Worker configurable, sinyal selesai, `task.run` (QW4+QW5). File **edit** `S/orchestrator/orchestratorRunModel.ts`, `orchestratorRunProduction.ts` (pecah, 335 baris), `workerRuntimePrompt.ts`; baru `S/orchestrator/orchestratorRunApi.ts`, `workerSignal.ts`, `T/defs/task.run.def.ts`. Test: kind dari `agentLaunchCommands`; `candidate_done` hanya bila idle dan diff tak kosong; `task.run` menghormati `RUN_REQUIRE_APPROVAL`. Flag: `WEBTERM_AGENT_IDLE_DONE_MS`. ~600. Deps: 03, 04.

**WS-11 — `feature/ca2-mailbox`** · `agent.relay` + pengiriman. File baru `C/agents/mailStore.ts`, `mailDeliver.ts`, `T/defs/agent.relay.def.ts`. Test: ≤20 belum-ack, TTL, kirim hanya saat tak `working`, amplop, `req_id` idempoten. Deps: 01(v6), 03, 04. ~550.

**WS-12 — `feature/ca2-channel-core`** · Ack cepat (B7), `callback_query`, `ChannelAdapter`, `accountId`, `channels.json` v2. File **edit** `S/channels/telegramWebhookHandler.ts`, `telegramCentralBridge.ts`, `channelStoreSchema.ts`, `channelStore.ts`; baru `channels/channelAdapter.ts`, `channelStoreMigrate.ts`, `channelCallback.ts`. Test: webhook <1 dtk saat runtime lambat, `update_id` replay 100×, migrasi v1→v2 + backup, tombol approval → `decideApproval`, group ditolak. Flag: `WEBTERM_CENTRAL_TELEGRAM` (ada). ~800. Deps: 04.

**WS-13 — `feature/ca2-channel-bots`** · Managed Bots, kartu status, topic. File baru `S/channels/botManager.ts`, `botManaged.ts`, `statusCard.ts`, `T/defs/channel.bot.def.ts`; **edit** `channels/channelsRuntime.ts` (mount). Test fetch palsu: `getMe`, token ke `SecretStore` tak ke json/log, R3. Flag: `WEBTERM_CENTRAL_BOTS`. ~700. Deps: 12.

**WS-14 — `feature/ca2-skills`** · Skill store + lifecycle + tools. File baru `C/skills/skillStore.ts`, `skillLint.ts`, `skillLifecycle.ts`, `skillIndex.ts`, `T/defs/skill.defs.ts`, `C/skills/builtin/webterm-*/SKILL.md`. Test: lint menolak executable/secret, hash terkunci, rollback symlink, aktivasi butuh approval R3. Flag: `_SKILLS`, `_SKILL_PROPOSE`. ~900. Deps: 03, 04.

**WS-15 — `feature/ca2-knowledge`** · Lite Map + `project.brief`. File baru `S/knowledge/{knowledgeStore,knowledgeScan,knowledgeDocs,knowledgeMap,knowledgeFresh,knowledgeBrief}.ts`, `T/defs/kb.defs.ts`. Test: fixture repo, aturan perhatian murni, `asOf/stale`, `missing` tak crash. Flag: `WEBTERM_KNOWLEDGE`, `_GRAPHIFY`. ~1.100. Deps: 03, 04.

**WS-16 — `feature/ca2-eval`** (W1a harness, W2b golden) · `C/eval/scriptedRuntime.ts`, `adversarialPayloads.ts`, `fakeWorkerAdapter.ts`, `goldenHarness.ts`, `metrics.sql.ts`, `golden/g01…g12.bun.test.ts`. W1: harness + G2,G3,G7. W2: sisa golden setelah integrasi. Deps: 02, 04 (W1); 19 (W2b).

**WS-17 — `feature/ca2-reliability`** · Dispatcher non-blocking, breaker di otonomi, wake, simpan handle. File **edit** `C/centralAutonomy.ts`, `S/centralAutonomyBoot.ts`; baru `C/autonomyDispatch.ts`, `C/wake.ts`, `C/agents/agentReconciler.ts`. Test: tick tak menunggu worker, doom-loop membuka breaker, wake debounce 250 ms. ~700. Deps: 07, 09.

**WS-18 — `feature/ca2-ui`** · Panel level/budget/halt, daftar agen, kartu approval R2, review skill, lihat memori. File baru `K/central/{LevelPanel,AgentList,ApprovalCardR2,SkillReview,MemoryView,centralControlApi}.tsx|ts`; **edit** `K/Dock.tsx`, `K/App.tsx`. Test vitest jsdom. Flag: `WEBTERM_CENTRAL_CHAT`. ~1.200. Deps: 07, 09, 14.

**WS-19 — `feature/ca2-integrator`** · Wiring tunggal. **edit** `S/index.ts`, `S/api.ts`, `S/envRegistry*.ts`; baru `T/registerAll.ts`, `C/ca2Boot.ts`. Test: boot semua flag off = perilaku lama; flag on mount rute; `toolsHash` terdaftar. Deps: semua W1.

**WS-20 — `chore/ca2-docs`** (W3) · README (bagian kontrak yang berubah saja), `CHANGELOG.md`, `RND/README.md`, `RND/07-IMPLEMENTASI-P3-P5.md`, dokumen AGENT/skill. Satu worker, setelah semua bukti. Tidak mengubah `src/**`.

## 4. Verifikasi kepemilikan
Tidak ada path ganda dalam gelombang: W0 {01: ledger/**, envRegistry*; 02: turn*/conversationStore/opencode*/context/contextPort; 03: tools/{toolTypes,toolRegistry,toolExec,toolAudit,defs/core}, proposal/*; 04: contracts/*}. W1 {05: turnService + defs/read.* + toolLoop; 06: context/* + centralPrompt; 07: guard/*; 08: memory/* + contextBuilder + defs/memory; 09: agents/{agentStore,agentStateMachine,execRunner,agentExecutor} + defs/agent.defs; 10: orchestrator/* + defs/task.run; 11: agents/{mailStore,mailDeliver} + defs/agent.relay; 12: channels/*; 14: skills/* + defs/skill; 15: knowledge/* + defs/kb; 16a: eval/*}. Setiap `defs/*` memakai nama file unik per WS. W2 {13: channels baru + channelsRuntime; 17: centralAutonomy* + autonomyDispatch/wake/agentReconciler; 18: client; 16b: eval/golden; 19: index/api/env/registerAll}.
