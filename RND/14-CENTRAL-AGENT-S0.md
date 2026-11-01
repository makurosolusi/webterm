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

Belum ada di S0: Claude/Codex adapter, tool tulis goal/plan/assign/run, approval card,
Telegram bridge, memory retrieval, real LLM. Jangan menyebut ini "agen pusat selesai".

## 2. Flag

```sh
WEBTERM_LEDGER=on
WEBTERM_CENTRAL=on
WEBTERM_CENTRAL_CHAT=on
WEBTERM_CENTRAL_RUNTIME=mock
```

`WEBTERM_CENTRAL_RUNTIME=off` (default) membuat endpoint turn menjawab
`503 central_runtime_off`. `WEBTERM_CENTRAL_CHAT` default off; tanpa flag chat, route tidak
dipasang (404). `WEBTERM_CENTRAL` tetap menggerbangi surface `/api/central/*`.

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

1. B2: Claude Agent SDK adapter, env allowlist, in-process MCP, real one-turn gate.
   Blocked until Claude CLI/login/trust is available; do not fake it.
2. B3: tool tulis `goal.propose`, `plan.propose`, `task.assign`, `task.run`,
   `approval.request`, `memory.claim` with authority tests.
3. C: tool/approval cards, cancel/retry, reconnect polish.
4. D: Telegram private bridge to the same conversation service; group read-only.
5. E: central memory retrieval + context builder.

S0 can be demoed now; it is **not** a central autonomous agent yet.
