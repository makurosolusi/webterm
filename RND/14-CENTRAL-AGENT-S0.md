# 14 — Central Agent S0: implemented vertical slice

Tanggal: 2026-11-02 (+08:00). Status: **S0 implemented and tested; full central agent not done**.
Induk: `08-CENTRAL-AGENT.md`, `13-CENTRAL-AGENT-IMPLEMENTATION-PLAN.md` §1.

## 1. Status B2/B3/D/E (verified 2026-11-02)

Bagian ini memperbarui status setelah acceptance terbaru. Klaim dibatasi pada evidence yang
benar-benar dijalankan, bukan pada target desain.

### B2 — OpenCode adapter dan real-turn gate

- OpenCode adalah primary runtime. `opencode --version` menghasilkan `2.0.26`.
- `opencode run --format json --model opencode/deepseek-v4.1-flash-free "Reply with exactly OK"`
  menghasilkan `OK`.
- Real central HTTP turn pada port `8831` dengan `WEBTERM_CENTRAL_RUNTIME=opencode` juga
  menghasilkan assistant text `OK` dan state `complete`.
- Pada build ini `step_finish` final dapat tidak dikirim. Karena itu `sessionRef`/`session` dan
  usage dapat bernilai nol pada turn tersebut. Free model juga dapat mengembalikan `429`
  `provider.quota`; error ini tidak boleh di-retry.
- Adapter tidak memakai PTY atau `--auto`. Env allowlist membuang semua `WEBTERM_*` dan
  `WEBTERM_*`; `OPENCODE_PERMISSION` menolak `bash`/`edit`/`webfetch`/`task` secara default;
  cancel membunuh process; resume memakai `--session`. Model dan binary dikonfigurasi lewat
  `WEBTERM_CENTRAL_MODEL` dan `WEBTERM_OPENCODE_BIN`.

**Batas B2:** real turn dengan free model sudah terbukti. Sustained turns dengan credentialed
model dan 2-project soak belum menjadi evidence.

### B3 — typed proposal MVP

Protocol yang berjalan adalah typed proposal protocol MVP, bukan MCP. Assistant text dapat
memuat blok `<webterm-proposal>{"tool":"goal.propose"|"plan.propose"|"task.assign"|"approval.request","input":{...}}</webterm-proposal>`.
Server memvalidasi dengan `proposalPolicy`: `WEBTERM_CENTRAL_PLANNER=on` dan
`WEBTERM_CENTRAL_TOOLS=write` wajib aktif untuk proposal, sedangkan `task.assign` juga
memerlukan `WEBTERM_ORCHESTRATOR_RUN=on`; actor/status/path dan field terlarang ditolak;
proposal project-scoped. `goal.propose` membuat goal berstatus `proposed` tanpa efek aktif.
`plan.propose` membuat atau mengganti plan `draft` dengan `expectedVersion`. `task.assign`
menerima `{projectId,itemId,expectedVersion,assignee?}`, membuat real ledger task, dan mengunci
pending plan item ke worker. Assign tidak melakukan spawn, run, atau approval. Setiap proposal
`approval.request` menerima `{projectId,requestId,kind,request,taskId?}` dan hanya membuat pending
ledger approval. Tool ini tidak decide atau run, `taskId` harus berupa task yang sudah ada,
`requestId` idempotent dan conflict jika request berubah. Audit menyertakan `approvalId`, tidak
pernah nonce atau digest. Setiap proposal menulis satu audit `central.proposal`; proposal ditolak menjadi conversation event
`entity.updated` dengan payload `proposal.rejected`.

Acceptance HTTP memakai mock runtime pada port `8834`: bootstrap `p1`, proposal block,
`project.goal_json` menjadi version 1 berstatus `proposed`, plan tetap tidak berubah, dan audit
`central.proposal` tersedia. Unit turn test mencakup applied/rejected/cancelled.

Real OpenCode E2E juga terverifikasi pada 2026-11-02:

- Port `8837`: plain human request meminta satu concrete goal untuk project `p1` dengan exact
  schema. Free model OpenCode menghasilkan valid `goal.propose`; server membuat
  `project.goal_json` version 1 berstatus `proposed` dan audit dengan payload
  `{"tool":"goal.propose","ok":true,"projectId":"p1","goalVersion":1}`.
- Port `8838`: prompt meminta assign first pending item. Prompt context menyediakan `itemId` dan
  `planVersion`; OpenCode menghasilkan valid `task.assign`. DB menunjukkan task `worker:p1`
  berstatus `pending`, plan item berstatus `assigned` dengan `task_id`, plan version 2, dan audit
  dengan payload `{"tool":"task.assign","ok":true,"projectId":"p1","taskId":"...","planVersion":2}`.
- Port `8839`: plain request menghasilkan valid `plan.propose`; plan menjadi version 2 berstatus
  `draft` dengan satu pending item dan audit `{"tool":"plan.propose","ok":true,"projectId":"p1","planVersion":2}`.
- Port `8840`: attempt pertama gagal karena model memakai plan item id sebagai `taskId`, sehingga
  foreign-key validation menolak proposal. Fix-nya adalah validasi `taskId` terhadap task yang ada
  dan menghapus contoh `taskId` yang menyesatkan dari prompt.
- Port `8841`: valid `approval.request` menghasilkan approval `central-deploy-staging-2` berstatus
  `pending` dan audit `{"tool":"approval.request","ok":true,"projectId":"p1","approvalId":"central-deploy-staging-2"}`.
  Tidak ada decision atau run.
- Prompt sekarang mengekspos hingga 50 pending plan items dengan fields
  `{projectId,planVersion,itemId,title}`, exact schema untuk keempat proposal tools, dan cap sekitar
  8 KiB.

**B3 masih partial:** `task.assign`, `plan.propose`, dan `approval.request` sudah terverifikasi.
Yang masih tersisa hanya proposal `task.run`/`approval.decide` (central tidak boleh decide),
sustained credentialed-model/soak evidence.
Proposal blocks sekarang dirender sebagai compact cards. Card tidak mengklaim proposal sudah
applied atau approved.

### D — Telegram central chat bridge

Free text (`parseCommand` menghasilkan `not_a_command`) dari bound private chat dikirim ke
`central:project:<projectId>` melalui `TurnService`. `updateId` yang sama menghasilkan
`clientMessageId` yang sama (`telegram:<updateId>`), sehingga idempotent. Batas turn 120 detik
menghasilkan `central_timeout`; balasan normal adalah assistant text, sedangkan failure menjadi
`Central agent unavailable (<code>).`. Commands dan approvals tetap unchanged, group chat tetap
ditolak. Test mencakup dispatch, idempotency, busy, runtime off, dan timeout.

**Batas D:** delivery/webhook Telegram nyata belum diverifikasi. E2E delivery harus dilakukan
oleh user yang memiliki Telegram bot dan webhook.

### E — memory retrieval

Dengan `WEBTERM_CENTRAL_MEMORY=on`, prompt mendapat bounded project facts dari `searchMemory`.
Global conversation tidak mendapat memory. Hanya `status=fact` yang dipakai: default 6 item,
maksimum 10, total 2048 karakter, body tiap item 300 karakter, dan redaction diterapkan.
Error fail closed menjadi empty. Memory diperlakukan sebagai data, bukan instruksi.

**Batas E:** tidak ada write/promotion. Test memakai mocked search; production memory E2E belum
ada.

### Gates dan remaining work

- `npx tsc --noEmit`: bersih.
- Targeted tests: 73 lulus (proposal + chat + client); Bun assign tests: 2 lulus.
- Full Vitest: 2017 lulus / 2018 total, 1 failure environment-only pada `controlCwd` karena `TMPDIR` shell ini
  berada di bawah `HOME`; test lulus dengan `TMPDIR=/tmp`.
- Bun-only: 228/228 lulus.
- Remaining: B3 `task.run`/`approval.decide`, sustained credentialed-model/soak evidence, real
  Telegram delivery, production memory E2E, dan real E2E milik user.

## 2. Scope S0

S0 adalah slice vertikal terkecil dari rencana, bukan agen pusat penuh:

Daftar berikut adalah batas scope S0 saat slice pertama diimplementasikan. Status B2/B3/D/E
terbaru ada di §1, jadi kalimat "Belum ada di S0" tidak berarti fitur tersebut masih belum ada
di repository saat ini.

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
   proses. Jangan pakai `--auto`; jangan klaim MCP tool write yang belum terverifikasi.
2. B3: proposal `task.run`/`approval.decide` paths and `memory.claim` with authority tests; `task.assign`
   sudah tersedia. `goal.propose`/`plan.propose`/`task.assign` tetap lewat typed proposal MVP.
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
