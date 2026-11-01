# 13 — Rencana Implementasi Agen Pusat
Tanggal: 2026-11-02 (+08:00). Status: **rencana dengan B2, B3 partial, D, dan E terimplementasi sebagian; belum commit**.
Induk: `08-CENTRAL-AGENT.md`; detail `09`-`12`. Dokumen ini file-level, test, flag, gate.
Batasan: state di SQLite, flag default off, schema change wajib migrasi, tanpa root token di env
agent, central tidak approve/spawn/tulis fact, file budget tetap.
## 0. Prinsip dan urutan
1. **Mock-first + slice vertikal.** Port/mock dulu; S0 (§1) didemokan sebelum tool tulis. Aditif
   dan reversible: migrasi v4 hanya menambah kolom/tabel; rollback = flag off + revert.
2. **Otoritas tidak dari prompt.** Tiap phase punya test negatif: argumen LLM/client tidak bisa
   menaikkan otoritas. **Paralel** hanya setelah seam stabil; satu owner per file.
```
A1 migration/types -> A2 services -> B1 port+mock -> C1 API (mock) -> S0 demo
  -> B2 OpenCode adapter -> B3 tool tulis -> C2 UI penuh -> E memory/context -> D Telegram
```
D dan E bukan syarat S0; OpenCode nyata (B2) juga bukan syarat S0. Adapter Claude/Codex opsional
dan **tidak wajib** (pengguna tanpa langganan Claude; lihat `09` §1).
## 1. Slice vertikal terkecil (S0)
**Tujuan:** percakapan tersimpan + satu tool baca + stream web, tanpa LLM nyata/efek samping.
- Cakupan: migrasi v4, `goalStore`, `conversationStore`, `CentralRuntime` + `MockRuntime`
  (memanggil `portfolio.read`), route `POST /api/central/conversations/:id/messages` + SSE +
  panel minimal.
- Flag: `WEBTERM_CENTRAL=on`, `WEBTERM_CENTRAL_RUNTIME=mock`, `WEBTERM_CENTRAL_CHAT=on`.
- Pada scope S0 awal, tool tulis (`goal.propose`, `plan.propose`, `task.assign`, `task.run`)
  **belum** ada; status implementasi terbaru ada di Phase B3.
Acceptance S0:
1. Kirim pesan → satu `central_message`, satu `central_turn`, event `done`.
2. Replay `clientMessageId` tidak membuat pesan/turn kedua.
3. `portfolio.read` mengembalikan data project nyata + satu audit `central.tool`.
4. Putus SSE lalu reconnect `Last-Event-ID` tanpa event hilang.
5. Cancel menutup turn <2 s + simpan teks parsial; `RUNTIME=off` → chat `503 central_runtime_off`.
S0 **bukan** agen pusat selesai: belum ada runtime OpenCode nyata, aktivasi goal, assign/run, Telegram, memori,
atau approval tool. Demo S0 = "chat + baca portfolio", bukan otonomi.
## 2. Phase A — Foundation
**Tujuan:** model data + service yang dipakai semua phase; tanpa runtime LLM.
### A1. Migrasi v4
| Target | Isi | Budget |
|---|---|---|
| `src/server/ledger/ledgerSchemaV4.ts` (baru) | DDL aditif | ≤130 |
| `src/server/ledger/ledgerSchema.ts` (ubah) | daftarkan `{version:4}`; v1-v3 tak disentuh | ≤25 |
| `src/server/ledger/migration.bun.test.ts` (ubah) | v4 idempoten, backup, urutan | ≤400 |
```sql
ALTER TABLE project ADD COLUMN goal_json TEXT
  CHECK (goal_json IS NULL OR json_valid(goal_json));
CREATE TABLE IF NOT EXISTS central_conversation (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL UNIQUE, project_id TEXT,
  active_turn_id TEXT, last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_message_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS central_message (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('human','assistant','tool','system')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  client_message_id TEXT, turn_id TEXT, state TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, client_message_id));
CREATE TABLE IF NOT EXISTS central_turn (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  status TEXT NOT NULL, runtime TEXT, session_ref TEXT, partial_text TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)), error_code TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS central_event (
  conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  turn_id TEXT, message_id TEXT, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, seq));
```
Indeks: `central_message(conversation_id, seq)`, `central_turn(conversation_id, status)`,
`central_event(conversation_id, seq)`. Tanpa FK lintas tabel (ledger standalone); validasi di
service. `goal_json` di `project`, bukan tabel baru: satu goal aktif, audit lewat `event`.
### A2. Service dan tipe
| Target | Isi | Budget |
|---|---|---|
| `src/server/central/goalModel.ts` (baru) | `Goal`, `SuccessCriterion`, `GoalEnvelope`; validasi/transisi | ≤200 |
| `src/server/central/goalStore.ts` (baru) | get/propose/activate/abandon; optimistic `version`; event | ≤250 |
| `src/server/central/conversationModel.ts` (baru) | scope parser, status turn, parts schema, error code | ≤200 |
| `src/server/central/conversationStore.ts` (baru) | 4 tabel, seq allocator, idempotency | ≤300 |
| `src/server/central/centralTypes.ts` (baru) | tipe bersama route/runtime/UI | ≤300 |
| `goalModel.test.ts`, `conversationModel.test.ts` | unit murni | ≤400 |
| `goalStore.bun.test.ts`, `conversationStore.bun.test.ts` | SQLite nyata | ≤400 |
Aturan:
- `appendEvent` menaikkan `last_event_seq` + insert satu `BEGIN IMMEDIATE`; gagal = kosong.
  `central_message.seq` (riwayat) dan `central_event.seq` (replay SSE) adalah dua urutan berbeda.
- Scope valid hanya `global` dan `project:<id>`; `conversationId` dipetakan ke scope.
- `propose` menulis `status:'proposed'`, `version:1`, efek nol pada plan/task; `activate`/`abandon`
  human/root; `achieved` hanya server. Reject criteria kosong, command di luar allowlist, envelope
  melebihi batas global.
**Flag A:** tidak ada flag baru; migrasi jalan saat `WEBTERM_LEDGER=on|shadow`.
**Exit A:** v4 idempoten di salinan DB nyata + backup; test A hijau; `tsc` bersih; tabel kosong
saat boot tanpa central.
**Manual/human:** review DDL + backup sebelum dijalankan pada DB pengguna.
**Rollback A:** revert kode; tabel/kolom aditif boleh tertinggal; restore backup hanya bila
migrasi gagal total.
## 3. Phase B — Runtime
**Tujuan:** port runtime, adapter OpenCode (primary) + mock, registry tool MCP stdio, policy otoritas.
### B1. Port dan mock
| Target | Isi | Budget |
|---|---|---|
| `src/server/central/runtime/centralRuntime.ts` (baru) | `CentralRuntime`, `TurnInput`, `RuntimeEvent`, `RuntimeResult`, `CancelToken` | ≤200 |
| `src/server/central/runtime/runtimeEvents.ts` (baru) | normalisasi event + urutan | ≤200 |
| `src/server/central/runtime/mockRuntime.ts` (baru) | deterministik; sukses/gagal/cancel/tool | ≤200 |
| `src/server/central/runtime/runtimeFlag.ts` (baru) | parse flag; default off | ≤100 |
| `mockRuntime.test.ts`, `runtimeEvents.test.ts` | urutan, cancel, error | ≤400 |
### B2. OpenCode adapter (gate keras)
**Status 2026-11-02:** adapter dan real-turn gate dasar terverifikasi dengan OpenCode 2.0.26.
Primary runtime, env scrubbing, permission deny default, cancel, dan `--session` resume path
terpasang. Real HTTP turn pada port 8831 mengembalikan `OK`. Gate sustained credentialed model,
MCP call nyata, dan soak belum terpenuhi. Free-model `provider.quota` 429 tidak di-retry.
| Target | Isi | Budget |
|---|---|---|
| `src/server/central/runtime/opencodeRuntime.ts` (baru) | spawn `opencode run --format json`, exit/error, cancel, resume, budget | ≤300 |
| `src/server/central/runtime/opencodeOptions.ts` (baru) | argv, scrub env allowlist, policy tool (deny default) | ≤200 |
| `src/server/central/runtime/opencodeEvents.ts` (baru) | parser JSONL murni + usage delta | ≤250 |
| `src/server/central/proposal/proposalParser.ts` (baru) | blok JSON ber-delimiter → draft tervalidasi; tolak field terlarang | ≤200 |
| `opencodeRuntime.test.ts`, `opencodeOptions.test.ts`, `opencodeEvents.test.ts` | fixture JSONL (text/tool_use/step_finish/error), exit, cancel, budget, env | ≤400/file |
Gate B2 (gagal salah satu = **STOP** tool tulis):
1. Satu turn OpenCode nyata (model ber-kredensial) → teks + `sessionRef` + usage tercatat.
2. Satu tool MCP stdio dipanggil; tool di luar allowlist ditolak; nama tool nyata dicatat.
3. Cancel membunuh proses <2 s; event final tepat sekali; teks parsial tersimpan.
4. `agentEnv(process.env)` tanpa `WEBTERM_TOKEN`/`NODETERM_*` (assertion).
5. Resume `--session` memakai `sessionRef` yang sama (verifikasi lintas proses).
6. `bash`/`edit`/`write` gagal saat dipanggil (bukan hanya tidak disebut di docs); `--auto` tidak dipakai.
7. Kuota/auth error (`provider.quota` 429, 401) → `provider_quota`/`auth_failed`, bukan retry.

Catatan bukti: CLI 2.0.26 sudah diverifikasi hidup (`09` §3). `step_finish` penutup **tidak**
dikirim untuk jawaban satu langkah, jadi turn ditutup oleh exit proses. Tidak ada flag
`--max-turns`/`--max-budget`; budget dihitung dari event dan ditegakkan dengan kill.
### B3. Tool registry dan policy
**Status 2026-11-02:** partial. Typed proposal MVP untuk `goal.propose`, `plan.propose`, dan
`task.assign` sudah divalidasi policy, diaudit sebagai `central.proposal`, dan diuji. `task.assign`
menerima `{projectId,itemId,expectedVersion,assignee?}`, membutuhkan `WEBTERM_CENTRAL_PLANNER=on`,
`WEBTERM_CENTRAL_TOOLS=write`, dan `WEBTERM_ORCHESTRATOR_RUN=on`, lalu membuat real ledger task
dan mengunci pending plan item ke worker. Assign tidak spawn, run, atau approval. Yang masih
Real OpenCode free-model E2E pada port 8837 membuktikan human request → `goal.propose` → policy
→ `project.goal_json` proposed + audit. Port 8838 membuktikan `task.assign` memakai pending item
context → real task `worker:p1` pending + plan item assigned + audit. Prompt menyediakan hingga
50 pending items `{projectId,planVersion,itemId,title}`, exact schema ketiga tools, dan cap sekitar
8 KiB. B3 tetap partial untuk `task.run`/approval-request proposals, sustained credentialed-model
dan soak evidence, serta real `plan.propose` E2E yang belum dijalankan.
| Target | Isi | Budget |
|---|---|---|
| `central/mcp/centralMcpServer.ts` (baru) | server MCP **stdio**; validasi capability per call | ≤250 |
| `central/tools/toolPolicy.ts` (baru) | risk class, capability, tolak field terlarang | ≤200 |
| `central/tools/toolAudit.ts` (baru) | event `central.tool`, digest argumen | ≤150 |
| `central/tools/readPortfolio.ts` (+plan/task) | baca via proyeksi/plan store | ≤200 each |
| `central/tools/proposeGoal.ts` (+proposePlan) | validasi + draft; tanpa efek aktif | ≤200 each |
| `central/tools/assignTask.ts` (+runTask) | panggil assign/jalur run; `needs_approval` | ≤200 each |
| `central/tools/pauseRequest.ts` (+approvalRequest) | buat request; tidak pernah decide | ≤150 each |
| `central/tools/*.test.ts` | allow/deny matrix, idempotensi | ≤400/file |
Default `WEBTERM_CENTRAL_TOOLS=read` (hanya baca lewat MCP stdio); `write` membuka
proposal goal/plan/assign. `task.assign` memerlukan `WEBTERM_CENTRAL_PLANNER=on` dan
`WEBTERM_ORCHESTRATOR_RUN=on`; `task.run` tetap melewati `WEBTERM_ORCHESTRATOR_RUN` +
`WEBTERM_RUN_REQUIRE_APPROVAL`; central tidak memegang kunci approval. **Flag B:**
`WEBTERM_CENTRAL_RUNTIME=off|mock|opencode|claude|codex`; `TOOLS=read|write`;
`WEBTERM_CENTRAL_MODEL`; `WEBTERM_OPENCODE_BIN`; `WEBTERM_OPENCODE_ALLOW_TOOLS` (default off).
**Exit B:** event mock/OpenCode sama bentuk; policy menolak `approval.decide`, `memory.promote`,
`spawn`, `run.finish`, `actor`/`authority` dari argumen; audit tertulis.
**Manual/human:** set model/provider OpenCode yang ber-kredensial (free model hanya dev), set
envelope, approve aksi nyata pertama. Webterm tidak menyimpan API key.
**Rollback B:** `WEBTERM_CENTRAL_RUNTIME=off`; adapter di-revert; tool tulis kembali `read`.
## 4. Phase C — Chat API dan UI
**Tujuan:** pengalaman web penuh di atas `turnService` yang sama.
| Target | Isi | Budget |
|---|---|---|
| `src/server/centralChatApi.ts` (baru) | route, body 64 KiB, auth transport, error stabil | ≤150 |
| `central/chat/turnService.ts` (baru) | lock, idempotency, persist, runtime, cancel/retry | ≤300 |
| `central/chat/streamHub.ts` (baru) | SSE, `Last-Event-ID`, heartbeat 15 s, replay gap | ≤200 |
| `central/chat/approvalBridge.ts` (baru) | request/decide lewat service manusia | ≤200 |
| `src/server/api.ts` (ubah) | mount chat sebelum fallback; body cap | ≤180 |
| `src/client/chatApi.ts` (baru) | fetch + SSE client, `clientMessageId` | ≤200 |
| `src/client/ChatPanel.tsx` (baru) | panel, list scope, composer, status | ≤300 |
| `src/client/chat/chatMessages.tsx` (baru) | pesan, Markdown, auto-scroll | ≤200 |
| `src/client/chat/toolCard.tsx` (baru) | state tool, detail, hasil ringkas | ≤200 |
| `src/client/chat/approvalCard.tsx` (baru) | reuse challenge dialog Inbox | ≤200 |
| `src/client/chat/chatStore.ts` (baru) | event reducer, dedupe seq, optimistic | ≤250 |
| `src/client/Dock.tsx`, `App.tsx` (ubah) | tombol Chat, panel sibling Inbox | ≤+50 |
| test | API idempotensi/lock/SSE; UI render/cancel/approval | ≤400/file |
Route: `POST /conversations/:id/messages`, `GET /conversations`, `GET /conversations/:id/messages`,
`GET /conversations/:id/stream`, `POST /turns/:id/cancel|retry`, `GET/POST /approvals/:id`.
Client tidak menghitung digest/nonce dan tidak mengirim `actor`.
**Flag C:** `WEBTERM_CENTRAL_CHAT=on` (default off); route/panel 503 saat off.
**Exit C:** acceptance §9 nomor 1-4, 8, 9 lulus; dua tab konvergen; retry aman; approval
expired/digest salah ditolak; reconnect tanpa event hilang.
**Manual/human:** review UX keyboard/a11y; setujui aksi irreversible; putuskan queue saat sibuk.
**Rollback C:** `WEBTERM_CENTRAL_CHAT=off` menyembunyikan route/panel; data tetap.
## 5. Phase D — Telegram
**Status 2026-11-02:** bridge logic partial dan unit-tested. Private bound free text dispatch,
idempotency, busy/runtime-off/timeout sudah dicakup. Real Telegram delivery/webhook belum
diverifikasi, jadi D belum complete.
**Tujuan:** bridge private chat ke conversation service yang sama; group read-only.
| Target | Isi | Budget |
|---|---|---|
| `src/server/channels/telegramCentralBridge.ts` (baru) | update → turn/command; identitas + binding | ≤250 |
| `src/server/channels/centralCommandGrammar.ts` (baru) | grammar deterministik + parser | ≤200 |
| `src/server/channels/centralOutbound.ts` (baru) | status card/chunk; enqueue outbox | ≤200 |
| `src/server/channels/channelStoreSchema.ts` (ubah) | mapping `(chat_id, thread_id) → conversation_id` | ≤+40 |
| `src/server/channels/channelsRuntime.ts` (ubah) | mount bridge di belakang flag | ≤+50 |
| test | replay 100×, group deny, chunk 4096, mapping stale | ≤400/file |
Private → `central:global`; topic → project; group hanya mirror status dan **tidak pernah**
approval. `/approve` membuka kartu; bare "yes" hanya private + satu pending + identity linked.
**Flag D:** `WEBTERM_CENTRAL_TELEGRAM=on` (default off), terpisah dari `WEBTERM_TELEGRAM`.
**Exit D:** `update_id` replay 100× = satu aksi; group callback ditolak; 10.000 char ter-chunk;
429 `retry_after` dihormati; outbox tidak hilang saat restart.
**Manual/human:** daftarkan webhook HTTPS + secret, bind akun private, uji satu pesan nyata.
Tanpa webhook publik, phase ini tetap "belum teruji delivery".
**Rollback D:** flag off + `deleteWebhook`; mapping tetap, ledger tidak dihapus.
## 6. Phase E — Memory dan context
**Status 2026-11-02:** bounded read-only retrieval terimplementasi dan unit-tested dengan mocked
search. `WEBTERM_CENTRAL_MEMORY=on` hanya memasukkan project facts yang redacted ke prompt;
global conversation kosong, fail closed, tanpa write/promotion. Production memory E2E belum ada.
**Tujuan:** retrieval read-only + context builder; bukan penulisan fact.
| Target | Isi | Budget |
|---|---|---|
| `central/memory/centralMemoryRead.ts` (baru) | `core` + fact project + ringkasan; provenance | ≤250 |
| `central/memory/contextBuilder.ts` (baru) | pinned/retrieved, dedupe, truncation, token budget | ≤300 |
| `central/memory/contextPolicy.ts` (baru) | scope, stale, redaksi, "data bukan instruksi" | ≤200 |
| `central/memory/centralMemoryClaim.ts` (baru) | claim `central`/`scratch`; tanpa promote | ≤200 |
| `src/server/memory/memoryModel.ts` (ubah) | actor `central`, scope `central`/`user` | ≤+40 |
| test | boundary, canary, token budget, stale, provenance | ≤400/file |
Tidak perlu migrasi: `project_id` nullable dan scope tanpa CHECK SQL. Unique index
`(project_id, scope, key)` memperlakukan NULL berbeda; de-dupe di service + test.
**Flag E:** `WEBTERM_CENTRAL_MEMORY=on` (default off). **Exit E:** hanya `fact`/`core`/ringkasan
berprovenance; total ≤6.000 token; secret canary dan cross-project leak = 0; memori = data.
**Manual/human:** putuskan `core` file-backed vs SQLite-only; isi preferensi user; review fact
lintas-project.
**Rollback E:** `WEBTERM_CENTRAL_MEMORY=off`; konteks kembali ke goal/plan/task.
## 7. Dependensi dan urutan
| Phase | Bergantung pada | Belum boleh mulai sebelum |
|---|---|---|
| A | — | — |
| B1 port+mock | A2 | service goal/conversation ada |
| C1 API mock | B1 | mock lulus test |
| **S0 demo** | A+B1+C1 | acceptance S0 lulus |
| B2 OpenCode | B1 | env allowlist + cancel test lulus |
| B2b Claude/Codex (opsional) | B2 | tidak wajib; hanya bila fallback dibutuhkan |
| B3 tool tulis | B2 + A2 + assign/run existing | gate B2 1-7 lulus |
| C2 UI penuh | C1 + B3 | route stabil |
| E | A2 + B1 | context builder tidak butuh UI |
| D | C2 + E (opsional) | turnService + approval bridge stabil |
E aman paralel dengan B2/B3; D setelah C2; jangan B3 + C2 pada file yang sama tanpa satu owner.
## 8. Flag matrix
| Flag | Default | Phase | Efek |
|---|---|---|---|
| `WEBTERM_CENTRAL` | off | A | permukaan `/api/central/*` |
| `WEBTERM_CENTRAL_RUNTIME` | off | B | `off|mock|opencode|claude|codex` |
| `WEBTERM_CENTRAL_MODEL` | `opencode/deepseek-v4.1-flash-free` | B | model `provider/model`; gratis hanya dev |
| `WEBTERM_OPENCODE_BIN` | `opencode` | B | path binary CLI |
| `WEBTERM_OPENCODE_ALLOW_TOOLS` | off | B | `on` membuka tool mutasi bawaan; default deny |
| `WEBTERM_CENTRAL_TOOLS` | read | B | `read|write`; write buka propose/assign/run |
| `WEBTERM_CENTRAL_CHAT` | off | C | route + panel chat |
| `WEBTERM_CENTRAL_TELEGRAM` | off | D | bridge Telegram private |
| `WEBTERM_CENTRAL_MEMORY` | off | E | retrieval + context builder |
| `WEBTERM_CENTRAL_PLANNER` | off | B3 | enable typed proposal handling |
| `WEBTERM_ORCHESTRATOR_RUN` | off | existing | jalur run |
| `WEBTERM_RUN_REQUIRE_APPROVAL` | off | existing | gate approval R2 |
Nilai lain = off (fail-closed). Tanpa ledger hidup, runtime/chat/memory `503` dan tidak boot.
## 9. Acceptance lintas phase
1. Replay `POST` 100× `clientMessageId` sama → satu pesan, satu turn, body sama.
2. Dua `POST` bersamaan → satu `202`, satu `409 conversation_busy`; lock lepas saat cancel.
3. SSE reconnect `Last-Event-ID` → tanpa event hilang/duplikat.
4. Cancel mid-stream → `cancelled`, teks parsial tersimpan; retry membuat turn baru.
5. Approval expired/digest salah/replay/group → ditolak tanpa efek.
6. Telegram `update_id` 100× → satu `channel_message`, satu aksi, ack identik.
7. `agentEnv` tanpa root/node token; log/event/outbox bebas secret.
8. Policy menolak `approval.decide`, `spawn`, `fact`, `run.finish`, `actor` dari argumen.
9. `goal.propose` tidak mengubah plan/task; `activate` hanya human.
10. Budget habis sebelum assign → `budget_exhausted`, tanpa worktree/PTY.
11. `tsc --noEmit`, `vitest run`, `bun test` hijau; file baru di bawah budget.
## 10. Rollback dan rekonsiliasi
- **Kode/data:** flag off rollback pertama; v4 aditif tak perlu di-drop; restore `VACUUM INTO`
  hanya bila migrasi gagal total.
- **Approval:** yang sudah di-consume tidak dihidupkan; tampilkan approved-unconsumed.
- **Tool:** hentikan turn aktif, `WEBTERM_CENTRAL_TOOLS=read`, revoke capability central.
- **Telegram:** flag off + hapus webhook; jangan `drop_pending_updates` tanpa alasan.
- **Rekonsiliasi:** turn `running` tanpa heartbeat >60 s → `failed` `code:'interrupted'`, bukan
  retry otomatis.
## 11. Yang tetap manual/human
1. Goal/envelope/approval + typed confirm; kredensial/webhook/fact/allowlist/budget; `08` §12.
2. Soak 2 project × 2 minggu; bukan S0/MVP chat.
## 12. Risiko dan stop/go
| Risiko | Deteksi | Tindakan |
|---|---|---|
| OpenCode belum satu turn nyata | gate B2 gagal | **STOP** tool tulis |
| Kuota model gratis habis (429) | `provider.quota` | pakai model ber-kredensial; **jangan** retry |
| `step_finish` penutup hilang | turn menggantung | tutup dari exit proses; test fixture |
| Binary/versi OpenCode tak cocok | `opencode --version` ≠ dipin | **STOP** rilis, pin versi |
| Tool bawaan aktif | config efektif menunjukkan `bash`/`write` | **STOP**, perbaiki config runtime |
| Token bocor lewat env | test `agentEnv` gagal | **STOP**, perbaiki allowlist |
| Self-approval | test policy/approval gagal | **STOP**, audit capability |
| Migrasi v4 gagal separuh | `user_version` tidak naik | restore backup |
| Stream event hilang | reconnect test gagal | **STOP** UI, perbaiki seq/replay |
| Replan loop | revisi >2 | pause project, `replan_exhausted` |
| Telegram delivery belum nyata | tak ada pesan terkirim | jangan sebut D selesai |
Jangan tambah dependency runtime sebelum gate B2; jangan `TOOLS=write` sebelum acceptance §9 lulus.
## 13. Definition of done dan dokumentasi
- Phase selesai hanya bila test baru + `tsc` + suite terkait hijau dan acceptance phase lulus.
- Update `07-IMPLEMENTASI-P3-P5.md` (`[V]/[W]/[P]`) dan `RND/README.md` bila flag baru; `08` bila
  keputusan berubah.
- Jangan menulis "selesai" untuk OpenCode nyata, tool tulis, Telegram delivery, atau soak tanpa bukti.
- Tidak ada commit/push dalam pekerjaan dokumen ini; implementasi menunggu perintah.
