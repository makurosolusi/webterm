# 09: Runtime Agent Pusat (November 2026)

Tanggal: 2026-11-01 (+08:00). Status: **riset, tanpa perubahan kode, tanpa commit**.
Semua URL diakses **2026-11-01** (§11). Batasan tetap: state otoritatif di ledger server,
verifikasi server-owned, root token tidak masuk env agent, runtime bisa diganti tanpa membongkar ledger.

## 1. Ringkasan keputusan

| Posisi | Pilihan | Alasan |
|---|---|---|
| **Primary** | **Claude Agent SDK (TypeScript)**: `query()` in-process, streaming input, `createSdkMcpServer()` | Agent loop + tool + MCP + hooks + resume + cost estimate dalam satu library; CLI ikut dibundel |
| **Fallback** | **Codex SDK / `codex exec --json`** | JSONL event stabil, thread resume, sandbox eksplisit, memakai login CLI lokal |
| **Bukan central** | PTY node + prompt satu baris | Tanpa event terstruktur, tanpa cancellation primitive, output dipotong 64 KiB, `done` bergantung hook |
| **Tool transport** | MCP 2026-07-28 (stateless), **in-process SDK MCP server** | Tanpa port loopback, tanpa token/file konfigurasi di disk |
| **Batas keras** | Central tidak spawn worker, tidak tulis fact/CORE, tidak menyetujui approval | Sama dengan `03-RENCANA.md` §7 |

Rekomendasi: satu port sempit `CentralRuntime` (turn, stream, cancel, resume, cost, close) dengan
dua adapter. Jangan panggil SDK langsung dari route HTTP.

## 2. Kondisi webterm yang mengikat pilihan

| Area | Fakta | Konsekuensi |
|---|---|---|
| PTY | `Bun.spawn({ terminal })` POSIX; satu slot per sesi (`src/server/pty.ts`, `sessionsCore.ts`) | Central tidak boleh memakai slot PTY manusia |
| Launch | `launchLine` merakit `--session-id`/`--resume`, `--permission-mode`, `--settings` (`launchLine.ts`) | Grammar interaktif, bukan headless `-p` |
| Env anak | `ptyEnv` membuang `WEBTERM_*`, `NODETERM_*`, `PORT`, `HOST`, `BUN_*`; token node di-inject per sesi | Root token aman di PTY; jalur SDK harus allowlist serupa |
| Status `done` | Dari hook `Stop`/`StopFailure` (`hookStatus.ts`), bukan exit code | Tanpa `--settings`, `status:done` tak pernah datang |
| Worker | Prompt satu baris cap 8 KiB, output 64 KiB, poll 250 ms, timeout 300 s (`workerRuntime.ts`) | Cukup leaf worker, tidak cukup central multi-turn |
| Control plane | `/api/control/{spawn,prompt,wait,close}`; `wait` untuk `exit`/`status:done`/`idle` | Ada seam, belum ada stream event terstruktur |
| Central | Proyeksi + pause/resume/priority + scheduler 1 item/tick (`central/*`, `centralAutonomy.ts`) | Central belum punya "otak" |
| Build | `bun build --compile` → binary tunggal 77 MB (`package.json`) | Binary SDK native harus di-embed + diekstrak (§9) |
| Bukti | SDK 0.3.316 + MCP SDK 1.32.2 import lulus di Bun 1.4.2 (`BUKTI.md`) | Import bukan bukti satu turn nyata |

## 3. Kandidat runtime (fakta per 2026-11-01)

### 3.1 Claude Agent SDK / Claude Code headless (primary)

- `@anthropic-ai/claude-agent-sdk` membundel binary Claude Code native per platform; versi SDK
  mengikuti CLI (SDK v0.3.191 ↔ CLI v2.1.191). `pathToClaudeCodeExecutable` bisa menunjuk CLI lain.
- API: `query({ prompt, options })` → `AsyncGenerator<SDKMessage>`; `startup()`/`prewarm()`;
  `tool()` + `createSdkMcpServer()`; `listSessions()`/`getSessionMessages()`/`forkSession()`.
- Dua mode input: **streaming input** (persisten, antrean, image, interrupt) dan **single message**
  (one-shot + `resume`). Dokumentasi menganjurkan streaming input untuk interaksi.
- Opsi relevan: `resume`, `continue`, `forkSession`, `persistSession`, `sessionStore`,
  `permissionMode`, `allowedTools`/`disallowedTools`, `canUseTool`, `hooks`, `mcpServers`,
  `settingSources`, `includePartialMessages`, `maxTurns`, `maxBudgetUsd`, `env`.
- CLI `-p`: `--output-format json|stream-json`, `--input-format stream-json`, `--resume`,
  `--mcp-config`, `--permission-mode`, `--permission-prompts none`, `--max-turns`,
  `--max-budget-usd`, `--json-schema`, `--bare`.
- `--bare` dianjurkan untuk script/CI dan **tidak** membaca OAuth/keychain: hanya
  `ANTHROPIC_API_KEY` atau `apiKeyHelper`. Jadi `--bare` = API key, non-bare = login langganan.
- Retry terlihat: `system/api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`,
  kategori `rate_limit`/`overloaded`/dst.). SIGTERM → exit 143, turn tidak dicatat; SIGINT atau
  `interrupt()` menutup turn.
- Kebijakan: Anthropic tidak mengizinkan pihak ketiga menawarkan login claude.ai tanpa izin;
  untuk produk yang dibagikan, pakai API key.

### 3.2 OpenAI Agents SDK (TypeScript) / Responses API

`Agent`, `run`, function tools (Zod), hosted tools, MCP tool calling, handoffs, guardrails,
sessions, human-in-the-loop, tracing; sandbox agent memakai `UnixLocalSandboxClient`.
Auth hanya `OPENAI_API_KEY` — tidak ada jalur "pakai login CLI lokal". Cocok untuk BYO-key,
kurang cocok sebagai fallback lokal-first.

### 3.3 Codex SDK / `codex exec` (fallback)

- `codex exec "<task>"`: progres ke stderr, jawaban ke stdout; `--json` memberi JSONL
  `thread.started`, `turn.started`, `item.*`, `turn.completed` (dengan `usage`), `turn.failed`,
  `error`; `--output-schema` + `-o` untuk output terstruktur.
- Sandbox eksplisit: default read-only; `--sandbox workspace-write`; `--ephemeral`;
  `--ignore-user-config`. Auth memakai kredensial CLI tersimpan, atau API key eksplisit di CI.
- `@openai/codex-sdk` (TS, Node 18+): `startThread()`/`resumeThread()`/`run()` + config override.
- Kekurangan: event lebih coarse (tanpa `canUseTool`), delta token tidak dijanjikan `--json`.

### 3.4 Lain (dicatat, tidak dipilih)

`opencode serve`: HTTP + OpenAPI 3.1, session CRUD, `prompt_async`, `abort`, SSE `/event`, basic
auth — adapter bagus, bukan agent loop. `gemini -p --output-format json`: statistik token/tool,
tanpa resume setara — hanya worker satu-shot.

## 4. MCP sebagai transport tool

Spec terbaru **2026-07-28** bersifat **stateless**: `initialize` dan `Mcp-Session-Id` dihapus,
metadata ikut body (`_meta.io.modelcontextprotocol/*`), server tidak lagi memulai request, cancel
via tutup stream (HTTP) atau `notifications/cancelled` (stdio). Binding tetap **stdio** dan
**Streamable HTTP**.

1. **Primary: in-process MCP.** `createSdkMcpServer()` + `tool()` di proses Bun: tanpa port,
   tanpa `.mcp.json`, tanpa token di disk; agent hanya melihat `mcp__webterm__<tool>`.
2. **Fallback: stdio MCP** dengan token scoped hanya di env proses MCP, bukan env agent.
   Streamable HTTP hanya bila central kelak di host lain.
3. **Jangan** pakai MCP untuk komunikasi antar-level (central → orchestrator → worker); itu
   tetap HTTP+JSON (`AGENT_PUSAT.md` §2 butir 6).
4. Izin eksplisit: `allowedTools: ["mcp__webterm__*"]`; jangan `bypassPermissions` hanya untuk tool.
5. Batas output: hasil > 25.000 token atau > 50.000 karakter disimpan ke file dan diganti path.
   Tool webterm mengembalikan ringkasan + id, bukan dump besar.
6. Tool yang butuh manusia mengembalikan `needs_approval`, bukan menahan call sampai timeout.

## 5. Operasional

| Aspek | Aturan |
|---|---|
| **Session state** | Transcript di `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (atau bawah `CLAUDE_CONFIG_DIR`). Satu session per `(projectId, threadId)`, `session_id` disimpan di ledger; resume lintas direktori didukung, lintas mesin butuh `sessionStore`. Kebenaran state tetap task row + evidence, transcript hanya konteks. `forkSession` untuk eksperimen paralel, bukan retry task yang sama. Satu proses per project aktif, cap konkurensi ~2, idle unload. |
| **Streaming** | Iterate `SDKMessage`; `system/init` membawa `session_id`, model, tool, status MCP; `includePartialMessages` menambah `stream_event` (delta). Codex: baca JSONL (`item.completed`, `turn.completed.usage`). Petakan ke event bus → WS; **jangan** tulis delta ke `outputLog` PTY. Buffer bounded, drop-oldest hanya untuk delta. |
| **Cancellation** | SDK `interrupt()`; `AbortController` untuk query. CLI: SIGINT menutup turn, SIGTERM (143) meninggalkan turn tanpa hasil tapi tetap menjalankan `SessionEnd` hook. Timeout berlapis: runtime, lease ledger, deadline HTTP. `cancel(sessionId, turnId)` idempoten; event final terkirim tepat sekali. |
| **Retry** | Hanya untuk kegagalan sebelum tool non-idempoten, atau setelah `result` final. Sinyal `system/api_retry` dan `result.subtype`; `error_max_turns`/`error_max_budget_usd`/`error_during_execution` dieskalasi ke manusia, bukan retry. Idempotensi tetap `requestId` + ack store webterm. |
| **Biaya** | `total_cost_usd`/`modelUsage` = **estimasi client-side**, bukan tagihan. Dedupe usage dengan `message.id`; `output_tokens` per step placeholder, total dari `result`. `maxBudgetUsd` hanya menghitung call itu. Simpan `run_id`, provider, model, token (input/output/cache), `cost_usd`, `cost_basis`, `duration_ms`, outcome; kegagalan tetap menagih. |
| **Auth** | Urutan menang: cloud provider env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profil/federasi → OAuth `/login`. Penyimpanan Keychain macOS / `.credentials.json` `0600`. Opsi webterm: login CLI lokal (developer, jangan ditawarkan sebagai fitur produk pihak ketiga), OAuth token (server tanpa browser), API key + `--bare` (CI deterministik, tidak membaca OAuth), `apiKeyHelper` (rotasi dari vault). Kunci model hanya di env proses agent, tidak di prompt/event/log/tool result. |

## 6. Fit dengan webterm: PTY vs subprocess vs MCP

| Aspek | PTY | Subprocess SDK/CLI | MCP |
|---|---|---|---|
| Stream | ANSI + scrape | Message/event | JSON-RPC |
| Cancel | `\x03` + exit | `interrupt()`, SIGINT/TERM | Tutup stream / `cancelled` |
| Multi-turn | Ketik baris baru | `resume`/`continue`, antrean | Stateless per call |
| Prompt | 8 KiB satu baris | String/AsyncIterable penuh | Argumen tool |
| Approval | Hook `PermissionRequest` 540 s | `canUseTool` + `PreToolUse` | `needs_approval` |
| Visibilitas | Terminal xterm | Panel event + transcript | Tak terlihat |
| Root token | Dibuang `ptyEnv` | Allowlist manual | Tak terlihat agent |
| Biaya | Tak terukur | `total_cost_usd`/usage | Tidak relevan |
| Offline | Ya | Ya (model tetap network) | Ya |

**Rekomendasi:** central = subprocess SDK di dalam proses server, bukan node PTY. Worker tetap PTY.
Manusia melihat **stream event** di panel; cermin read-only ke xterm hanya opsional.

**6.1 Root token dan capability.** Jalur SDK tidak boleh `env: process.env`; bangun `agentEnv`
dari allowlist (`PATH`, `HOME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, kredensial
model). Token node tidak diberikan: central tidak butuh hook canvas, dan token itu membuka
`/api/control/*`. Central memakai capability sendiri (`wcap_*`, TTL pendek, resource-bound):
`central.read`, `project.read`, `task.assign`, `run.request`, `memory.claim`; **tidak**
`approval.decide`, `memory.promote`, `node.prompt` lintas node, `run.finish`. Approval manusia
tetap lewat `/api/approvals/*`; `canUseTool` hanya membuat request dan menunggu decision. Audit
tiap tool call sebagai `central.tool` (nama tool, digest argumen, hasil).

**6.2 Offline/local-first.** Ledger, session map, memory, worktree lokal; hanya inference (dan
MCP remote opsional) butuh jaringan. Jangan taruh central di cloud queue, jangan tambah broker,
jangan jadikan MCP HTTP wajib.

## 7. Arsitektur yang diusulkan (belum diimplementasikan)

```
POST /api/central/turn
   └─► centralTurnRoute ─► CentralRuntime (port)
                            ├─ ClaudeAgentRuntime: query(streaming) + createSdkMcpServer
                            ├─ CodexRuntime: codex exec --json / codex-sdk thread.run
                            └─ mapEvents ─► event bus ─► WS (panel) + ledger event
```

| File | Isi |
|---|---|
| `central/runtime/centralRuntimeTypes.ts` | `CentralRuntime`, `TurnInput`, `RuntimeEvent`, `RuntimeResult`, `CancelToken` |
| `central/runtime/claudeAgentRuntime.ts` | wrapper `query()`, `interrupt()`, mapping `SDKMessage` |
| `central/runtime/claudeAgentOptions.ts` | allowlist env, `settingSources`, `allowedTools`, `maxTurns`, `maxBudgetUsd` |
| `central/runtime/codexRuntime.ts` | spawn `codex exec --json`, parser JSONL, resume `thread_id` |
| `central/runtime/centralEvents.ts` | murni: `SDKMessage`/JSONL → `RuntimeEvent`, tanpa I/O |
| `central/runtime/centralSession.ts` | peta `(projectId, threadId) → sessionId`, persist di ledger |
| `central/mcp/webtermTools.ts` | `tool()` + `createSdkMcpServer()`, validasi capability per call |
| `central/runtime/centralBudget.ts` | akumulasi usage/cost, dedupe `message.id`, tulis ledger |

Flag `WEBTERM_CENTRAL_RUNTIME=off|claude|codex` (default `off`), terpisah dari `WEBTERM_CENTRAL`
(proyeksi) dan `WEBTERM_CENTRAL_AUTONOMY` (scheduler). Tanpa ledger hidup, runtime menolak boot.

## 8. Tabel keputusan

| Kriteria | Claude Agent SDK | Codex SDK / `exec` | OpenAI Agents SDK | opencode `serve` |
|---|---|---|---|---|
| Auth | Login CLI, OAuth, API key, helper | Login CLI, API key | API key | Provider OAuth/API key |
| Streaming | Message + `stream_event` | JSONL per item | Responses events | SSE `/event` |
| Tool | Built-in + MCP | Built-in + MCP | Function/hosted/MCP | Internal + MCP |
| Approval | `canUseTool`, hooks, deny rules | Sandbox + approval policy | Guardrails/HITL | `permission` endpoint |
| Cost | `total_cost_usd`, `modelUsage` | `turn.completed.usage` | Usage API | Tidak seragam |
| Resume | `resume`/`continue`/`fork`, store | `thread_id` | Sessions | Session id |
| Ops | Proses anak, prewarm | Proses anak, ringan | Key + egress | Server + port |
| Windows | Binary `win32-x64`; PTY webterm tidak | CLI tersedia | Node lintas platform | Tergantung provider |
| Bun | Import lulus; compile butuh `extractFromBunfs` | Proses anak + parser murni | Node API | HTTP client |
| Verdict | **Primary** | **Fallback** | Opsi BYO-key | Adapter |

## 9. Risiko dan mitigasi

| Risiko | Bukti | Mitigasi |
|---|---|---|
| Claude nyata belum satu turn | `07` §2b: `Not logged in · Run /login` | Gate: satu turn + satu tool + satu cancel sebelum route |
| Workspace trust | `-p` tanpa trust dialog, interaktif meminta | Selalu `-p`/SDK, jangan launch interaktif |
| Binary di `bun build --compile` | `require.resolve` gagal di `$bunfs`; perlu `pathToClaudeCodeExecutable` + `extractFromBunfs()` (v0.3.144+) | Embed per platform; uji binary hasil compile |
| API cepat berubah | SDK 0.3.x, CLI 2.1.x, MCP 2026-07-28 | Pin versi; feature-detect via `capabilities` di `system/init` |
| Token bocor lewat env | SDK mewarisi env bila `env` kosong | Allowlist eksplisit + test assert `WEBTERM_TOKEN`/`NODETERM_*` absen |
| Biaya tak terduga | Estimasi client-side, subagent ikut | Amplop ledger + `maxTurns` + `maxBudgetUsd` |
| MCP breaking / Tasks Beta | 2026-07-28 hapus `initialize` | In-process dulu; stdio/HTTP hanya bila perlu |

## 10. Gate sebelum implementasi dianggap selesai

1. Satu turn Claude nyata menghasilkan `result` + biaya tercatat di ledger.
2. Tool MCP in-process dipanggil; capability salah ditolak; tidak ada token di env anak.
3. Cancel menutup turn < 5 s dan event final terkirim tepat sekali.
4. Resume setelah restart memakai `session_id` sama, konteks masih ada.
5. Timeout/lease tidak menulis `verified`; verifikasi tetap server-owned.
6. `error_max_budget_usd` → eskalasi manusia, bukan retry.
7. Adapter fallback menghasilkan bentuk event sama untuk sukses dan gagal.
8. Binary `bun build --compile` menjalankan satu turn (uji `extractFromBunfs`).

## 11. Sumber (diakses 2026-11-01)

- Claude Agent SDK overview — https://docs.claude.com/en/docs/agent-sdk/overview
- Agent SDK TypeScript reference — https://docs.claude.com/en/api/agent-sdk/typescript
- Agent SDK sessions — https://docs.claude.com/en/docs/agent-sdk/sessions
- Agent SDK streaming input vs single message — https://docs.claude.com/en/docs/agent-sdk/streaming-vs-single-mode
- Agent SDK permissions — https://docs.claude.com/en/docs/agent-sdk/permissions
- Agent SDK hooks — https://docs.claude.com/en/docs/agent-sdk/hooks
- Agent SDK MCP — https://docs.claude.com/en/docs/agent-sdk/mcp
- Agent SDK cost tracking — https://docs.claude.com/en/api/agent-sdk/cost-tracking
- Claude Code headless — https://docs.claude.com/en/docs/claude-code/headless
- Claude Code CLI reference — https://docs.claude.com/en/docs/claude-code/cli-reference
- Claude Code authentication — https://docs.claude.com/en/docs/claude-code/authentication
- MCP specification 2026-07-28 transports — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- MCP specification latest — https://modelcontextprotocol.io/specification/latest
- OpenAI Agents SDK TypeScript — https://openai.github.io/openai-agents-js/
- Codex non-interactive mode — https://developers.openai.com/codex/non-interactive-mode
- Codex SDK (TypeScript) — https://developers.openai.com/codex/codex-sdk
- opencode server API — https://opencode.ai/docs/server/
- Gemini CLI headless — https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- Claude Agent SDK README — https://github.com/anthropics/claude-agent-sdk-typescript

Bukti lokal: `RND/90-REFERENSI/BUKTI.md` (Bun 1.4.2, import SDK/MCP),
`RND/07-IMPLEMENTASI-P3-P5.md` §2b (Claude nyata BLOCKED), `RND/03-RENCANA.md` §7 (batas central).
