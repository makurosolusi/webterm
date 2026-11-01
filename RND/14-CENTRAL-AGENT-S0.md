# 14 — Central Agent S0: implemented vertical slice

Tanggal: 2026-11-02 (+08:00). Status: **S0 implemented and tested; full central agent not done**.
Induk: `08-CENTRAL-AGENT.md`, `13-CENTRAL-AGENT-IMPLEMENTATION-PLAN.md` §1.

## 1. Scope S0

S0 adalah slice vertikal terkecil dari rencana, bukan agen pusat penuh:

- migrasi ledger v4: `project.goal_json` + `central_conversation`, `central_message`,
  `central_turn`, `central_event`;
- goal model/store (proposed/active/abandoned, optimistic version, audit);
- conversation model/store (scope global/project, message seq, turn lock, event seq, idempotency);
- `CentralRuntime` port + `MockRuntime` (text stream, tool call, cancel, usage);
- chat HTTP API + SSE (message submit, history, stream replay, cancel, health);
- web `ChatPanel` sibling Inbox/Sessions di Dock;
- tool baca `portfolio.read` (R0) dengan audit `central.tool`.

Belum ada di S0: adapter OpenCode/Claude/Codex, tool tulis goal/plan/assign/run, approval card,
Telegram bridge, memory retrieval, real LLM. Jangan menyebut ini "agen pusat selesai".

## 2. Flag

```sh
WEBTERM_LEDGER=on
WEBTERM_CENTRAL=on
WEBTERM_CENTRAL_CHAT=on
WEBTERM_CENTRAL_RUNTIME=mock
# opsional saat adapter B2 dipakai:
# WEBTERM_CENTRAL_MODEL=opencode/deepseek-v4.1-flash-free
# WEBTERM_OPENCODE_BIN=opencode
```

`WEBTERM_CENTRAL_RUNTIME=off` (default) membuat endpoint turn menjawab
`503 central_runtime_off`. `WEBTERM_CENTRAL_CHAT` default off; tanpa flag chat, route tidak
dipasang (404). `WEBTERM_CENTRAL` tetap menggerbangi surface `/api/central/*`. Nilai runtime yang
dikenal: `off|mock|opencode|claude|codex`; nilai lain = off (fail-closed).

## 3. Real HTTP acceptance

Server nyata, port 8831, data dir baru, `WEBTERM_ORCHESTRATOR_RUN=on`, runtime mock:

| Cek | Hasil |
|---|---|
| `GET /api/central/health` | `{runtime:"mock",chat:true,ledger:true}` |
| `POST /api/orchestrator/bootstrap` | 200, project `p-chat`, plan v1 |
| First `POST /api/central/conversations/central:global/messages` tanpa GET list | **202**, message seq 1, turn running |
| `GET .../messages` setelah turn | human + assistant; assistant punya tool `portfolio.read` |
| `portfolio.read` | `total:1`, project `p-chat`, plan v1, task counts 0 |
| Replay `clientMessageId` sama | message/turn id sama, tidak ada pesan kedua |
| SSE `GET .../stream?after=0` | frame `message.created`, `turn.status`, `message.created`, id/seq replay |
| Bootstrap tanpa flag orchestrator di run pertama | 409 `orchestrator_off` (bukan bug chat) |

Temuan saat acceptance: POST pertama ke conversation kanonik 404 karena conversation hanya
dibuat oleh GET list. Fixed `866b781`: canonical conversation auto-create pada POST; project
scope menolak project yang tidak ada dengan 404 `project_not_found`. Regression test ditambahkan.

## 4. Gates

- `tsc --noEmit` + strict unused: bersih.
- Vitest: **149 file / 1954 test**.
- Bun: **226 test**.
- File budget: `turnService` 205, `turnPersistence` 174, `centralChatApi` 101,
  `centralChatHandlers` 191, `ChatPanel` 188.

## 5. Langkah berikut

1. B2: **OpenCode adapter** (`opencode run --format json`), env allowlist, MCP stdio,
   typed proposal parser, real one-turn gate. CLI 2.0.26 sudah terbukti hidup (§6); yang belum:
   satu turn dengan model ber-kredensial, satu tool MCP dipanggil, satu cancel, resume lintas
   proses. Jangan pakai `--auto`; jangan klaim tool tulis.
2. B3: tool tulis `task.assign`, `task.run`, `approval.request`, `memory.claim` with authority tests.
   `goal.propose`/`plan.propose` tetap lewat typed proposal sampai B3.
3. C: tool/approval cards, cancel/retry, reconnect polish.
4. D: Telegram private bridge to the same conversation service; group read-only.
5. E: central memory retrieval + context builder.

S0 can be demoed now; it is **not** a central autonomous agent yet.

## 6. Bukti runtime OpenCode (2026-11-02)

Probe manual sebelum menulis adapter B2. Tanpa secret/kunci di output.

| Cek | Hasil |
|---|---|
| `opencode --version` | `2.0.26` (binary `/opt/homebrew/bin/opencode`) |
| `opencode run --format json --model opencode/deepseek-v4.1-flash-free "Reply with exactly: OK"` | exit 0; `step_start`, `text` = `OK`; **tidak ada** `step_finish` |
| Turn dengan tool (`--auto`, prompt `echo webterm-open-code-ok`) | `tool_use` (`tool:"shell"`, `state.status:"completed"`, `exit:0`), `step_finish` (`reason:"tool-calls"`, `cost:0`, `tokens:{input:46,output:44,cache.read:16512}`) |
| `--session ses_webtermprobe01` | event memakai `sessionID` yang sama (create-if-missing terbukti); recall lintas proses **belum** terbukti |
| Turn ke-5 dan seterusnya | `error` `{"type":"provider.quota","status":429}` (`FreeUsageLimitError`), exit code **1** |
| `opencode mcp list` / `mcp add --help` | server **local (stdio)** didukung (`command`, `environment`, `cwd`, `timeout`) |

Bentuk event yang dipakai adapter (dipangkas):

```jsonl
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start","messageID":"msg_..."}}
{"type":"tool_use","sessionID":"ses_...","part":{"tool":"shell","state":{"status":"completed","input":{"command":"echo ..."},"output":"...","metadata":{"exit":0}}}}
{"type":"step_finish","sessionID":"ses_...","part":{"reason":"tool-calls","cost":0,"tokens":{"input":46,"output":44,"cache":{"read":16512}}}}
{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"OK"}}
{"type":"error","sessionID":"ses_...","error":{"type":"provider.quota","status":429}}
```

Implikasi untuk S0/B2: tutup turn dari **exit proses**; `error` event menang atas exit code;
model gratis hanya untuk dev (kuota cepat habis); `--auto` hanya dipakai saat probe, bukan di
runtime; tool mutasi (`bash`/`edit`/`write`) dan subagent harus ditolak lewat kebijakan yang
**dibuktikan** bekerja (config `permission`/`tools`, atau env yang diverifikasi), bukan hanya
diasumsikan. Detail desain: `09-CENTRAL-AGENT-RUNTIME.md` §3-§8.
