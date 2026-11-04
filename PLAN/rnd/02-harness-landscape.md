# R&D 02 — Lanskap harness/IDE agen (per November 2026) dan pelajarannya untuk control plane webterm

Worker: wkr-rnd-harness-42 · 2026-11-04 · read-only. Riset web lewat `ego-browser` (berhasil, tanpa fallback). Sumber lokal: clone Orca `/tmp/st/orca-src` (commit `68ba160c`, 2026-11-03) dan app terpasang Orca 1.4.222 (`orca agent-context --json` → 242 perintah).

Prinsip yang dipakai: perkaya fitur (memory `feedback-perkaya-fitur.md`). Ide besar tidak saya buang hanya karena besar. Ide dibuang kalau tidak aman atau usang.

---

## 0. Ringkasan satu paragraf

Pemain yang matang sekarang mengikuti pola yang sama. **Satu runtime/daemon menjadi sumber kebenaran.** Runtime itu memegang **satu registry metode bertipe** (skema + izin wajib), lalu memproyeksikan registry itu ke beberapa permukaan: CLI tipis untuk agen, socket/WS RPC untuk UI dan perangkat lain, MCP untuk agen pihak ketiga, dan ACP untuk menyetir agen eksternal. Agen menyadari lingkungannya lewat tiga jalur: (a) env var identitas yang disuntik ke PTY, (b) *discovery* yang dibuat dari registry yang sama (`orca agent-context --json`, OpenAPI `/doc` OpenCode, `generate-json-schema` Codex), (c) skill stub kecil yang memuat panduan lengkap sesuai versi binary. Izin dibuat **berlapis dan deklaratif**: tier per metode, aturan pola "last match wins", mode (plan/auto/bypass), hook sebelum tool dijalankan, dan relay persetujuan ke manusia lewat kanal mana pun.

---

## 1. Orca (stablyai/orca, MIT) — referensi terdekat webterm

**Pola control plane.** Ada dua registry yang dijaga oleh test supaya tidak melenceng:
- **Runtime RPC** di proses main Electron. Tiap metode dibuat dengan `defineMethod({name, permission, params: zod, handler})`. `src/main/runtime/rpc/core.ts:181-187` memuat komentar "Every new method must explicitly choose caller permissions." Total 369 file metode di `src/main/runtime/rpc/methods/`. Transport: unix socket, WS, relay e2ee untuk mobile (`unix-socket-transport.ts`, `ws-transport.ts`, `e2ee-channel.ts`).
- **CLI `orca`** sebagai klien tipis. `CommandSpec` (`src/cli/command-spec.ts:1-21`) berisi path, summary, usage, flags, examples, notes, `destructive`, `hidden`, dan `identityFlagRoles` (caller vs target). Handler dimuat lazy per grup (`src/cli/dispatch.ts:16-30`, `handler-group-manifest.ts:15`), dan ada test drift antara key manifest dan export asli.
- **Discovery untuk agen**: `orca agent-context --json` (`src/cli/agent-context.ts:27-52`) membangkitkan skema mesin dari spec yang sama. Perintah `hidden` tetap bisa dipanggil tetapi tidak muncul di discovery. Ada juga `command-suggestion.ts` untuk koreksi typo yang **tidak pernah menyarankan perintah destruktif**.

**Izin.** `rpc-method-permission.ts:1-36` mendefinisikan 8 tier: `workspace`, `desktop-control`, `accounts-admin`, `settings-write`, `skills-admin`, `pairing-admin`, `host-admin`, `device-self`. Grant diberikan per caller (`rpc-caller-scope.ts`). Perangkat yang di-pair hanya mendapat `desktop-control` kalau diberikan saat pairing. Identitas caller dibuktikan (`rpc-caller-identity.ts`, `agent-session-owner-proof.ts`), jadi agen tidak bisa mengaku sebagai sesi lain.

**Kesadaran lingkungan.** Env PTY seperti `ORCA_TERMINAL_HANDLE`, `ORCA_WORKTREE_PATH`, dan `ORCA_ROOT_PATH`. Skill disebar sebagai **stub** (`skill-stubs/orca-cli.md`) yang hanya berkata "jalankan `ORCA skills get orca-cli`", sehingga panduan selalu cocok dengan versi binary. Panduan lengkap ada di `skill-guides/*.md`. Hook agen ditangani di `src/main/agent-hooks/` (status, deteksi transisi, rename branch otomatis saat kerja pertama: `first-work-branch-rename.ts`).

**Orkestrasi/mailbox.** Ada 31 subperintah `orchestration` (worker-start, send, ask/reply, check, task DAG, decision gates). Database ada di `src/main/runtime/orchestration/db.ts`. Aturannya ditulis di skill (`skill-guides/orchestration.md:20-60`): worker menjalankan `ask` lalu **mengakhiri giliran**, dan Orca yang membangunkannya. Dilarang polling dan dilarang menyetir worker lewat terminal. Pesan dikirim lewat `send --to dispatch:<id>`. Kalau worker sedang sibuk, pesan diantar saat gilirannya selesai. Kalau worker sudah selesai, pesan menjadi Task lanjutan. Peluncuran memakai `operationId` + `--retry-launch` sehingga replay idempoten (`skill-guides/orca-cli.md` bagian *Starting agents*).

**Lainnya.** ACP client lengkap (`src/main/acp/`) menyetir Claude/Codex/OpenCode sebagai "native chat" dengan fallback ke terminal, dan receipt menjelaskan alasannya. Fitur lain: browser tertanam yang bisa disetir CLI (snapshot/click/fill/intercept/cookie/console), `computer` (UI OS), `emulator`, `automations` (prompt terjadwal per worktree), `artifacts share`, `skills` share, dan `worktree set --comment/--workspace-status`.

**Layak ditiru:** registry + izin wajib per metode, discovery yang dibangkitkan, skill stub berversi, wake-not-poll, receipt dengan `next`/`detail`, retry idempoten, dan perintah destruktif yang tidak bisa terpicu oleh saran typo.

## 2. Claude Code (Anthropic) — permukaan ekstensi terlengkap

- **Hooks**: sekitar 35 event (https://code.claude.com/docs/en/hooks), termasuk `SessionStart`, `UserPromptSubmit`, `PreToolUse` (allow/deny/ask/**defer**, `updatedInput`), `PermissionRequest`, `PostToolBatch`, `Stop`, `SubagentStart/Stop`, `TaskCreated/Completed`, `TeammateIdle`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `Pre/PostCompact`, `Elicitation`, dan `SessionEnd`. Tipe handler: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Output bisa berupa `additionalContext`, `systemMessage`, dan `terminalSequence` (OSC 9/777 untuk notifikasi, race-free di tmux).
- **Channels** (research preview, https://code.claude.com/docs/en/channels-reference): server MCP stdio dengan capability `claude/channel` yang **mendorong event ke sesi yang sedang terbuka**. Bisa dua arah lewat reply tool, punya *sender gating*, dan bisa me-*relay* prompt izin ke chat. Ini persis kebutuhan webterm. Saat ini webterm mengetik note `[webterm]` ke sesi idle (`src/server/linkNote*.ts`), dan channel adalah jalur resminya.
- **Cross-session messaging** (https://code.claude.com/docs/en/cross-session-messaging): `ListAgents` + `SendMessage` antar sesi lokal maupun remote, plus "kabari saya sekali saat sesi X idle/exit". **Agent teams** menambahkan task list bersama, teammate yang saling berkirim pesan, dan panel agen. Ada juga *agent view*, worktree isolation, goals, scheduled prompts, artifacts, dan launch dari link.
- **Izin** (https://code.claude.com/docs/en/permissions): rules `allow/ask/deny` dengan pola tool (`Bash(git *)`). Rule deny/ask juga berlaku pada subshell dan loop. Mode: Manual, `acceptEdits`, plan, **auto** (classifier), `dontAsk`, `bypassPermissions` (bisa dikunci lewat `disableBypassPermissionsMode`). Settings bertingkat: managed > project > user.
- **Konteks**: CLAUDE.md + `.claude/rules/*.md` lazy (memicu `InstructionsLoaded`), auto-memory, skills (progressive disclosure), plugins (bundel skills/hooks/MCP/agents/output styles), dan output styles.
- **SDK**: Agent SDK (TS/Py) memakai loop yang sama, permission callback, dan sesi resume/fork. `claude -p --output-format json` tersedia untuk bahasa lain.

**Layak ditiru:** katalog event hook sebagai bus event webterm, channel/push-into-session sebagai pengganti mengetik ke PTY, `defer`, dan relay izin ke chat.

## 3. OpenCode (sst/opencode)

**Pola:** TUI hanyalah klien dari server HTTP. `opencode serve` mengekspos **OpenAPI 3.1 di `/doc`**, dan SDK dibangkitkan dari spec itu (https://opencode.ai/docs/server/). Endpoint penting: `/session/:id/message`, `/fork`, `/revert`, `/diff`, `/todo`, `/permissions/:pid` (jawab izin + `remember`), `/tui/*` (menyetir TUI dari luar, dipakai plugin IDE), `/global/event` (SSE), dan mDNS.
**Plugin** (https://opencode.ai/docs/plugins/): modul TS menerima `{project, client, $, directory, worktree}`, berlangganan event (`session.idle`, `tool.execute.before`), dan bisa memutasi argumen tool.
**Izin** (https://opencode.ai/docs/permissions/): kunci per tool, pola wildcard, **last match wins**, `external_directory`, dan **`doom_loop`**, yaitu meminta konfirmasi bila tool yang sama dengan input identik terulang 3 kali. Ada juga `--auto`. **Agents** adalah primary/subagent dengan izin dan model sendiri.

**Layak ditiru:** OpenAPI sebagai artefak registry, `/tui` remote-drive, guard doom_loop, dan izin dengan `remember`.

## 4. Codex CLI (OpenAI)

**Pola:** **app-server** JSON-RPC (stdio/unix/WS) yang menjadi dasar ekstensi VS Code dan aplikasi desktop (https://learn.chatgpt.com/docs/app-server). Primitifnya Thread → Turn → Item. Metodenya antara lain `thread/start|resume|fork|revert|compact`, `turn/start|steer|interrupt`, `thread/goal/set`, `thread/backgroundTerminals/*`, `process/spawn`, `fs/watch`, `skills/list`, `config/batchWrite`, `review/start`, dan `model/list`. Skema TS/JSON dibangkitkan per versi (`codex app-server generate-json-schema`). Backpressure: error `-32001 Server overloaded` → klien retry dengan jitter.
**Approval** adalah request server→klien: `item/commandExecution/requestApproval` (dengan `proposedExecpolicyAmendment` dan `availableDecisions`) dan `item/fileChange/requestApproval` (dengan `grantRoot`). `approvals_reviewer: user|auto_review` mengatur siapa yang menyetujui, per app/tool. Ada sandbox policy per turn, auth WS dengan capability token atau signed bearer, dan AGENTS.md bertingkat.

**Layak ditiru:** `turn/steer` (menyisipkan input ke giliran yang berjalan), persetujuan yang **mengusulkan amandemen policy** ("izinkan selamanya pola ini?"), reviewer otomatis vs manusia, dan skema yang dibangkitkan per versi.

## 5. Cursor

- **Rules** `.cursor/rules/*.mdc` dengan frontmatter `alwaysApply/globs/description`, sehingga ada 4 mode: always, auto-attach per glob, *agent-requested* via description, dan manual @-mention (https://cursor.com/docs/rules). AGENTS.md didukung.
- **Hooks** (https://cursor.com/docs/hooks): `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentResponse/Thought`, `subagentStart/Stop`, dan hook Tab terpisah. `workspaceOpen` bisa mengembalikan path plugin. Cursor juga **memuat hook Claude Code**.
- **Cloud agents**: VM terisolasi dengan environment (snapshot/Dockerfile `.cursor/environment.json`) yang dibangun di latar. Bisa dipicu dari web, iOS, Slack, atau komentar `@cursor` di PR. CLI `agent -p` punya awalan `&` untuk "lempar ke cloud, ambil lagi nanti". Mode Agent/Plan/Ask, sandbox toggle, dan prompt sudo yang tidak pernah dilihat model.

**Layak ditiru:** rule yang dimuat sesuai relevansi, hook baca-file (cegah `.env`), handoff lokal↔latar dengan satu karakter, dan environment yang disiapkan di latar.

## 6. Windsurf → Devin Desktop / Devin

Windsurf sekarang menjadi **Devin Desktop**. Cascade sudah legacy, dan agen barunya **Devin Local**, yang memakai harness yang sama dengan Devin CLI (https://docs.devin.ai/desktop/devin-local/customizations). Ada halaman **Customize** dengan tab Plugins/Skills/MCPs/Hooks/Rules/Subagents yang menampilkan **apa yang benar-benar dimuat sesi ini** dan dari mana asalnya. Rules punya trigger (`model_decision`, dll.). `AGENTS.local.md` dipakai untuk aturan pribadi. Workspace Restricted Mode mematikan agen ACP. Cascade dulu punya planner latar, todo list, antrean pesan, dan batas invocation + auto-continue. API v3 memakai service user + RBAC + `create_as_user_id`.

**Layak ditiru:** panel "apa yang dimuat sesi ini" (provenance konteks) dan antrean pesan saat agen sibuk.

## 7. Zed — ACP

Zed host thread, dan **External Agents** (Claude, Codex, Gemini, OpenCode, Cursor, Copilot, dll.) dipasang dari **ACP Registry** (https://zed.dev/docs/ai/external-agents). Ada Terminal Threads untuk CLI/TUI mentah. Agent Profiles mengatur tool yang tersedia, dan tool permissions mengatur allow/deny/confirm. Ada sandbox OS untuk terminal dan tool `diagnostics` setelah edit (https://zed.dev/docs/ai/tools).

**ACP** (https://agentclientprotocol.com): JSON-RPC dua arah, agen sebagai subprocess (remote masih WIP). Memakai ulang tipe MCP dan menambah diff, plan, terminal, session modes, config options, slash commands, dan elicitation. v2 sedang draft: `session/update` dengan `state_update` idle dan stop reason, `$/cancel_request`, `auth/login`, dan path absolut.

**Layak ditiru:** webterm bisa menjadi **ACP client** sehingga node agen menjadi "chat terstruktur" dengan fallback ke PTY (pola Orca), dan memakai registry ACP untuk memasang agen.

## 8. VS Code (Copilot) dan JetBrains

**VS Code** (https://code.visualstudio.com/docs/agent-customization/custom-agents): *Agents window*, pemilih **harness** per sesi (Copilot, Claude, Codex…), custom agents (instruksi + tools + model + **handoffs** antar agen), prompt files, skills, plugin agen yang membundel MCP, `!cmd` untuk menjalankan shell langsung tanpa approval, antrean/steer pesan saat agen sibuk, dan tool browser bawaan.
**JetBrains**: **MCP server bawaan IDE** sejak 2025.2 dengan **auto-configure klien** (Claude Code, Codex, VS Code…) yang menulis config global atau per proyek (https://www.jetbrains.com/help/idea/mcp-server.html). AI Assistant menjadi ACP client dengan opsi "Pass IntelliJ MCP server to agents" (https://www.jetbrains.com/help/ai-assistant/acp.html).

**Layak ditiru:** auto-configure MCP webterm ke tiap agen yang di-spawn (zero-config) dan handoff antar agen sebagai tombol.

## 9. Warp

Satu agen di tiga permukaan: app, CLI `warp` (bisa lewat SSH), dan cloud. Rules/Skills/MCP/Codebase Context mengikuti ke semua permukaan. Fitur lain: full terminal use (REPL/TUI), Agent Management Panel, orkestrasi parent→children, dan Automation Platform (trigger, jadwal, integrasi, observability) + **Factories** (tim agen triage→spec→implement→review→verify). CLI agen pihak ketiga mendapat notifikasi, code review inline, dan remote session control (https://docs.warp.dev/agents/).

**Layak ditiru:** "factory" sebagai template pipeline multi-agen dan konteks yang sama di semua permukaan.

## 10. Protokol (status November 2026)

- **MCP 2026-07-28** (https://modelcontextprotocol.io/specification/2026-07-28/changelog). Protokol menjadi **stateless**: handshake initialize dan `Mcp-Session-Id` dihapus, versi dan capability dikirim di `_meta` tiap request, dan ada `server/discover` yang wajib. `subscriptions/listen` menggantikan GET/SSE dan resources/subscribe. **Multi Round-Trip Requests** (`resultType: "input_required"`) menggantikan request server→klien (elicitation/sampling/roots). **Roots, Sampling, Logging deprecated.** `ttlMs`/`cacheScope` wajib di hasil list dan tools diurutkan deterministik (prompt cache). Extensions resmi: **MCP Apps (Stable, UI iframe sandbox)**, **Tasks (Beta→Core, polling `tasks/get`, `tasks/update`)**, **Skills over MCP (`skills/list|get`, SEP-2640 Final)**, Server Cards. Implikasinya: jangan bangun di atas sampling/roots. Elicitation harus dibuat model MRTR.
- **ACP**: lihat §7. Ini standar de-facto editor↔agen (Zed, JetBrains, Devin Desktop, Orca).
- **A2A** (Linux Foundation; https://a2a-protocol.org/latest/topics/key-concepts/): Agent Card, Task berlifecycle, Message/Part/Artifact, SSE, dan push webhook. A2A untuk agen↔agen lintas organisasi, bukan subagen. Untuk webterm pribadi, A2A relevan sebatas format *agent card* dan *task/artifact*.
- **AGENTS.md** (https://agents.md): file instruksi lintas agen (Codex, Cursor, VS Code, Devin, OpenCode, Warp, Jules…). Bertingkat per direktori, varian `AGENTS.local.md`.

---

## 11. Diagnosis singkat webterm hari ini (dari kode)

Permukaan kontrol webterm masih tersebar. Ada `ToolRegistry` Central bertier R0-R3 (`src/server/central/tools/toolTypes.ts:40-60`, `defs/*`), verb capability terpisah (`src/server/control/capabilities.ts:12-38`: `node.spawn/prompt/wait/close/read`, `approval.*`, `browser.*`), route HTTP per fitur (`*Api.ts`), dan skill (`webterm-browser`, `webterm-linked-context`). Belum ada MCP server, belum ada CLI, dan tidak ada discovery yang dibangkitkan. Akibatnya, menambah satu kemampuan berarti menyentuh 3-4 tempat, dan agen tidak punya cara tunggal untuk bertanya "apa yang bisa saya lakukan di sini?". Ini persis masalah yang Orca selesaikan dengan `defineMethod` + `agent-context`.

---

## 12. Ide yang layak ditiru (diperingkat)

1. **Satu registry kemampuan bertipe sebagai sumber tunggal** (Orca `defineMethod`, Codex/OpenCode schema-gen). Bentuknya `defineCapability({ name, summary, params: schema, result, tier, destructive, scope, streaming, handler })`. Dari registry ini **dibangkitkan**: route HTTP, tool Central, tool MCP, subperintah CLI `webterm`, OpenAPI `/doc`, dan katalog prompt. Test drift memastikan setiap kemampuan muncul di semua proyeksi. Ini fondasi "god mode".
2. **Izin wajib per kemampuan + grant per caller** (Orca 8 tier, Claude/OpenCode rules). Satukan R0-R3 dan verb capability menjadi satu model: tier + pola `allow/ask/deny` last-match-wins + mode (plan/auto/bypass) + grant per identitas (node token, Central, browser, perangkat). Caller harus membuktikan identitasnya (owner-proof), bukan sekadar mengaku.
3. **Discovery mandiri untuk agen**: `webterm agent-context --json` / MCP `tools/list` deterministik + skill stub yang memanggil `webterm skills get <x>` supaya panduan selalu sesuai versi server (pola stub Orca). Agen di node mana pun langsung tahu kemampuannya (zero-config).
4. **Push ke sesi, bukan mengetik ke PTY**: jalankan webterm sebagai **Claude Code channel** (MCP `claude/channel`) dan sebagai server MCP yang di-auto-configure ke tiap agen yang di-spawn (pola JetBrains auto-configure). Note kabel, pesan antar node, dan event CI masuk sebagai event terstruktur. Jalur ketik `[webterm]` yang sekarang tetap dipakai untuk agen yang belum mendukung channel.
5. **Mailbox + wake-not-poll** (Orca orchestration, Claude cross-session/teams): `send --to node:<id>`, `ask`/`reply` yang memblokir, dan "kabari saat node X idle/exit". Pesan diantar saat giliran selesai. Larang polling di skill.
6. **Relay persetujuan universal** (Codex requestApproval, OpenCode `/permissions` + `remember`, Claude channel permission relay). Setiap `ask` dari agen mana pun menjadi satu kartu persetujuan di webterm (canvas, inbox, Telegram) dengan tombol **"izinkan pola ini selamanya"** yang menulis amandemen policy. Reviewer bisa manusia atau Central (`auto_review`).
7. **ACP client untuk node agen** (Orca native chat, Zed, JetBrains): node agen menjadi chat terstruktur (plan, diff, tool call, mode) dengan fallback ke PTY, dan agen dipasang dari ACP Registry. Receipt menjelaskan kenapa jadinya terminal atau chat.
8. **Bus event hook terpadu**: tiru katalog event Claude Code (SessionStart…PostToolBatch, CwdChanged, FileChanged, PreCompact) sebagai event internal webterm. Event dinormalisasi dari hook Claude/Codex/Cursor/OpenCode, dan Central serta automasi berlangganan ke sini.
9. **Provenance konteks per node** (Devin Customize, Claude `InstructionsLoaded`): panel "yang dimuat sesi ini" berisi AGENTS.md/CLAUDE.md/rules/skills/MCP/hooks beserta sumbernya. Tambah dukungan rule ber-glob/ber-deskripsi gaya `.mdc`.
10. **Receipt + idempotensi** (Orca `operationId`/`--retry-launch`, `next`): setiap aksi mutasi mengembalikan receipt `{outcome, detail, next}`, dan retry dengan id yang sama di-replay, bukan dijalankan dua kali.
11. **Steer & antrean** (Codex `turn/steer`, VS Code/Cascade queue): kirim input ke giliran yang sedang berjalan atau masukkan ke antrean, dari canvas maupun API.
12. **Guard doom-loop dan saran tanpa destruktif** (OpenCode `doom_loop`, Orca command-suggestion): ask otomatis saat tool + input identik terulang 3 kali, dan typo tidak pernah disarankan menjadi perintah destruktif.
13. **Automations + factories** (Orca automations, Warp Factories, Claude scheduled prompts): template pipeline multi-node (triage→spec→implement→review→verify) yang bisa dijadwalkan dan dipicu webhook, dibangun di atas registry yang sama.
14. **MCP Apps untuk UI dari agen** (MCP ext Stable): hasil tool bisa berupa `ui://` yang dirender di node canvas dalam iframe sandbox. Ini cocok dengan model node webterm.
15. **Skills over MCP + AGENTS.md** sebagai format konteks lintas agen. Bangun di atas MCP 2026-07-28 (stateless, `server/discover`, MRTR, `ttlMs`). **Jangan** memakai sampling/roots karena sudah deprecated.

Catatan risiko: channels Claude Code masih research preview (allowlist, `--dangerously-load-development-channels` untuk channel kustom). Siapkan fallback ketik-ke-PTY. Transport WS Codex app-server diberi label "experimental and unsupported".
