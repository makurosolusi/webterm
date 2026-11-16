# 08 — Agen Pusat: Keputusan Arsitektur Tunggal
Tanggal: 2026-11-02 (+08:00). Status: **keputusan desain, belum ada kode, belum commit**.
Menyatukan `09` (runtime), `10` (planning), `11` (chat), `12` (memori) di atas ledger P2-P5.
Dokumen ini mengikat; `09`-`12` adalah bukti/detail. Eksekusi: `13-CENTRAL-AGENT-IMPLEMENTATION-PLAN.md`.
## 1. Ringkasan keputusan
| # | Keputusan | Alasan |
|---|---|---|
| D1 | Central = **steward**, bukan pemilik hasil | Manusia memegang goal, approval, definisi "done" |
| D2 | Runtime **OpenCode CLI** (`opencode run --format json`), subprocess tanpa PTY; Claude/Codex fallback opsional | Pengguna tanpa langganan Claude; JSONL terstruktur, `--session`, cancel via kill, model via env (`09`) |
| D3 | Central **tidak memakai PTY** / slot sesi manusia | PTY untuk worker; central butuh multi-turn + stream |
| D4 | Tool MVP = **MCP stdio lokal** + **typed proposal protocol** | Proses terpisah: SDK MCP in-process tidak ada; capability hanya di env server MCP |
| D5 | Goal = `project.goal_json` berversi (MVP), tabel `goal` nanti | Satu goal aktif/project; audit + diff |
| D6 | Plan tetap `plan`/`plan_item`; `seq` = dependency lane MVP | Tidak perlu DAG untuk slice pertama |
| D7 | Chat = **proyeksi**, bukan control plane kedua | Web & Telegram memanggil service yang sama |
| D8 | Satu conversation kanonik: `central:global`, `central:project:<id>` | Tidak ada transkrip kedua per kanal |
| D9 | Conversation/message/turn/event di **SQLite ledger** (migrasi v4) | Replay, idempotensi, audit, satu writer |
| D10 | Web = permukaan utama (SSE); Telegram private = kontrol + approval | Group hanya mirror read-only |
| D11 | Memori central = **retrieval read-only** + claim scope `central` | Fact/CORE tetap milik manusia/orchestrator |
| D12 | Semua flag default **off**; tanpa ledger hidup central menolak boot | Perilaku lama tidak berubah |
## 2. Invarian
- **I1 State otoritatif di server.** Task row, plan/goal version, approval row, event ledger =
  kebenaran; transcript/prompt/snapshot hanya konteks. **I14** Satu turn aktif per conversation,
  lock di server; kirim saat sibuk = 409.
- **I2 Tidak ada root token di env agent.** Env anak dari allowlist; `WEBTERM_*,
  `PORT`, `HOST` tidak diwariskan. **I13** Tanpa secret/PII di log, prompt, event, outbox.
- **I3 Central tidak dapat menyetujui aksinya sendiri.** Tidak memegang `approval.decide`;
  approval hanya lewat transport manusia `/api/approvals/*`.
- **I4 Central tidak menulis `fact`/CORE**, maksimum `claim` scope `central`/`scratch`.
- **I5 Central tidak spawn worker.** Spawn milik orchestrator; central hanya `plan.assign` +
  `task.run` (request) pada item/worker yang ada.
- **I6 Prompt bukan otoritas.** Semua efek divalidasi server; argumen tool tidak membawa
  `actor`, `authority`, `status`, `projectId` turunan, path absolut, atau command bebas.
- **I7 Semua efek idempoten.** `requestId`/`clientMessageId` + ack store; approval single-use,
  replay tidak memperpanjang expiry. **I8** Expiry tidak pernah auto-approve.
- **I9 Verifikasi server-owned.** `verified` butuh evidence server + verifier; teks LLM bukan
  bukti; approval bukan exactly-once, state dicek sebelum efek. **I10** Konten tak tepercaya
  (worker/tool/memori/Telegram) tetap data, bukan instruksi.
- **I11 Batas keras tetap.** Depth ≤2, worker 3/project, attempt 3, WIP goal 1, item ≤50,
  revisi plan ≤2/10 menit. **I12** Schema change wajib migrasi v4 aditif + backup.
## 3. Model otoritas
| Principal | Boleh | Tidak boleh |
|---|---|---|
| **human/root** (transport token) | activate/abandon goal, approve/deny, pause/resume, naikkan envelope, promosi fact, `core` | dipegang agent |
| **central** (`wcap_*`, TTL pendek) | baca portfolio/plan/task/evidence, propose goal/plan, assign item, request run/approval, claim memori `central` | decide approval, pause/resume nyata, naikkan envelope, spawn, tulis fact/CORE |
| **orchestrator** | assign, run, request approval, promote claim project dengan evidence | approve, ubah goal |
| **worker** | claim memori, edit worktree | spawn, promote, run task lain, sentuh goal |
| **channel/Telegram** | meneruskan pesan/command; membuat approval **request** | approve, menulis settings/PTY, menjadi principal |
Capability central: `central.read`, `project.read`, `task.assign`, `run.request`, `memory.claim`.
Tidak ada `approval.decide`, `memory.promote`, `node.prompt`, `run.finish`.
| Kelas | Contoh | Gate |
|---|---|---|
| R0 baca | portfolio, plan, task, evidence, memori | capability baca |
| R1 tulis terbatas | goal/plan draft, memory claim, edit worktree | flag + validasi server |
| R2 mutasi bersama | assign, run, pause proposal | approval bila `WEBTERM_RUN_REQUIRE_APPROVAL=on` |
| R3 ireversibel | push/merge, hapus branch, migrasi, kirim eksternal, naikkan budget | **selalu** approval + typed confirm |
R3 tidak punya "flag off = bebas". Tanpa approver, aksi **parkir**.
## 4. Runtime
Satu port sempit, adapter OpenCode sebagai default, plus mock dan fallback opsional. Route HTTP
tidak pernah memanggil CLI langsung.
```
POST /api/central/conversations/:id/messages
  -> turnService (lock, idempotency, persistence)
     -> CentralRuntime.turn(input, emit, signal)
        -> OpenCodeRuntime (spawn `opencode run --format json`) | MockRuntime | ClaudeAgentRuntime (opsional)
     -> mapJsonlEvents -> central_event (seq) -> SSE + audit
```
`CentralRuntime` wajib punya `turn`, `cancel`, `resume`/`sessionRef`, `cost`, `close`; event
dinormalkan (`text.delta`, `tool.requested`, `tool.completed`, `turn.result`, `error`).
- Flag `WEBTERM_CENTRAL_RUNTIME=off|mock|opencode|claude|codex` (default `off`), terpisah dari
  `WEBTERM_CENTRAL` (HTTP) dan `WEBTERM_CENTRAL_AUTONOMY` (scheduler). Model dari
  `WEBTERM_CENTRAL_MODEL`; binary dari `WEBTERM_OPENCODE_BIN`.
- Satu proses per conversation aktif; idle unload; konkurensi global ≤2. Batas turn/budget
  ditegakkan webterm (CLI tidak punya `--max-turns`/`--max-budget`): hitung `step_finish`, kill saat
  lewat batas, tulis `budget_exhausted`.
- Cancel = kill process group (`SIGTERM` → `SIGKILL` <2 s); event final tepat sekali; teks parsial
  disimpan. Turn ditutup oleh **exit proses**, bukan `step_finish` (event itu tidak dikirim pada
  jawaban satu langkah). Resume memakai `sessionRef` di ledger; sesi OpenCode konteks, bukan state.
- `error` event (`provider.quota` 429, auth, config) dieskalasi ke manusia, bukan retry. `bash`,
  `edit`, `write` dimatikan di config runtime MVP; `subagent_depth: 0`; `--auto` dilarang.
- Config di-inject lewat `OPENCODE_CONFIG` (file `0600` di state dir), **bukan** `opencode.json`
  di worktree pengguna.

## 5. Tool: MCP stdio + proposal
Nama tool mengikuti nama server MCP di config runtime; **jangan asumsikan** `mcp__webterm__<tool>`
(pola itu milik SDK in-process). Catat nama nyata pada test integrasi pertama. Balasan
`{ok:true,...}` / `{ok:false, code}`; satu audit `central.tool` per call (nama, digest argumen,
hasil, durasi; tanpa prompt).
| Tool | Otoritas | Risiko | Perilaku |
|---|---|---|---|
| `portfolio.read` | central | R0 | ringkasan project/plan/task/usage |
| `plan.read` | central | R0 | plan + item + version |
| `task.read` | central | R0 | task, evidence ringkas, status |
| `goal.propose` | central | R1 | simpan draft; efek nol sampai human activate |
| `plan.propose` | central | R1 | create/replace dengan `expectedVersion`, WIP, envelope |
| `task.assign` | central | R1 | hanya item `pending` + worker existing |
| `task.run` | central | R2 | request ke jalur run; approval bila gate on |
| `project.pause_request` | central | R2 | **usul** pause; mutasi tetap human-only |
| `approval.request` | central | R1 | membuat request; tidak pernah decide |
| `memory.claim` | central | R1 | hanya scope `central`/`scratch` |
Rekonsiliasi: brief menyebut "pause project"; diimplementasikan `project.pause_request` karena
`10` §5 dan `central.ts` menetapkan pause human-only (lihat I3). Tool butuh manusia mengembalikan
`needs_approval` + id, tidak menahan call sampai timeout. Tool tak dikenal = error. Deskripsi
tool di-pin (`tools_hash`); hash berubah tanpa approval = tolak (rug pull). Output besar =
ringkasan + id, bukan dump.

**Status MVP:** hanya tool **baca** yang jalan lewat MCP stdio. `goal.propose`/`plan.propose`
belum jadi tool; MVP memakai **typed proposal protocol** (satu blok JSON ber-delimiter, divalidasi
Zod server, disimpan sebagai draft `proposed`, efek nol). `task.assign`/`task.run` belum ada dan
butuh capability + approval di fase B3. Jangan klaim tool tulis sudah diimplementasikan.

## 6. Goal dan plan
Goal MVP di `project.goal_json` (v4, aditif), dengan version terpisah:
```jsonc
{ "version": 1, "status": "proposed",   // proposed|active|achieved|abandoned|superseded
  "statement": "≤500 char, satu outcome",
  "successCriteria": [                  // ≥1; semua machine-checkable kecuali review
    { "kind": "command", "command": "npm test" },
    { "kind": "scope", "paths": ["src/server/orchestrator"] },
    { "kind": "review", "by": "human" } ],
  "owner": "human:root", "horizon": "2026-11-30",
  "envelope": { "maxCostMicros": 5000000, "maxWallMs": 1800000, "maxItems": 40 } }
```
Transisi: `proposed→active`, `active→abandoned/superseded` hanya manusia; `active→achieved`
hanya server setelah criteria mesin lulus **dan** review manusia. Central hanya membuat
`proposed`, tidak boleh menaikkan envelope.
Loop: `observe → propose → validate → commit → act → observe → verify → replan`; LLM hanya di
propose/replan, server menegakkan transisi/WIP/envelope/kuota. Task graph MVP: `seq` =
dependency satu lane; `depends_on` ditunda. Replan: verify gagal (attempt ≤3), scope drift
1×/item, budget habis (pause), approval ditolak (2×/item lalu `blocked`), plan stale (baca
ulang, jangan tulis). Maks 2 revisi plan/10 menit/project, lalu `autonomy.replan_exhausted`.
Budget dicek **sebelum** assign/run; habis = goal `paused` + event, bukan cap diturunkan.
## 7. Conversation
Kanonik: `central:global` (router/portfolio) dan `central:project:<id>`; tidak ada conversation
per task, tidak ada transkrip kedua per kanal.
| Objek | Isi | Aturan |
|---|---|---|
| `central_conversation` | scope unik, project_id nullable, `active_turn_id`, `last_seq`, timestamps | satu per scope |
| `central_message` | `seq`, role, `parts_json`, `client_message_id`, `turn_id`, `state` | `UNIQUE(conversation_id, client_message_id)` |
| `central_turn` | status, runtime, session_ref, `partial_text`, usage, error code | satu aktif per conversation |
| `central_event` | `seq` per conversation, tipe, payload ter-redaksi | append-only, sumber replay SSE |
`seq` monoton per conversation dan otoritatif di server. Multi-tab hanya membaca; kiriman kedua
saat turn aktif → `409 conversation_busy {activeTurnId}`; UI menawarkan Stop, bukan antre diam-diam.
Event: `message.created`, `part.delta`, `part.completed`, `tool.requested`, `tool.completed`,
`approval.requested`, `approval.updated`, `entity.updated`, `turn.status`, `error`, `done`.
SSE `Last-Event-ID`/`after=seq`, heartbeat 15 s, fallback polling; jangan campur WS PTY.
Kartu tool/approval adalah bagian pesan dengan state
`requested → running → awaiting_approval → succeeded|failed|denied|cancelled`. Card memuat
project/goal/plan/item, aksi, scope, command, digest pendek, risk class, expiry, biaya, Deny
beralasan; challenge selalu dari server. Cancel menyimpan teks parsial; tool yang sudah jalan
tidak di-rollback dan efeknya disebut. Retry hanya `failed`/`cancelled` tanpa side effect;
approval yang sudah di-consume tidak dihidupkan, tawarkan "turn baru".
## 8. Memori dan konteks
Memori central = retrieval read-only, bukan salinan ledger.
- **Baca:** `core` + fact project + ringkasan tervalidasi; tiap item membawa `memory_id`,
  `scope`, `source_kind`, `source_ref`, `updated_at`, `evidence_digest`, status.
- **Tulis:** hanya `claim` scope `central`/`scratch`; TTL scratch; tanpa self-promotion; fact
  tetap human/orchestrator; `core` human-only.
- **Bukan memori:** secret/PII, transkrip mentah, chain-of-thought, output tool penuh, diff/kode,
  state task/plan/approval, teks agen lain sebagai instruksi.
- **Anggaran:** pinned ≤2.000 token, retrieved ≤4.000, total ≤6.000; potong di batas paragraf +
  pointer `memory_id`.
- **Konteks per turn** deterministik: goal + plan version + task ringkas + evidence terakhir +
  memori terpilih + ringkasan conversation; state live dibaca, tidak dimemori.
- **Kompaksi** merangkum turn lama sebagai `claim` berprovenance, turn terakhir verbatim; tidak
  dipromosikan tanpa verifikasi ulang. Fact basi ditandai, skornya turun.
- **Keamanan:** body memori selalu data, di-delimit; canary secret dan cross-project leak = 0.
  Embedding/`sqlite-vec` tidak dipakai sampai recall@10 parafrase < 0.8.
## 9. Permukaan web dan Telegram
| Aspek | Web | Telegram |
|---|---|---|
| Peran | permukaan utama | proyeksi + intent + approval private |
| Scope | global + per project | private → global; topic → project |
| Streaming | SSE `part.delta`, flush per frame | status card, edit 2-3 s; draft hanya private |
| Approval | kartu penuh + typed confirm | tombol di private; group **tidak pernah** approve |
| Cancel/retry | penuh | `/cancel`, Stop bila didukung |
| Identitas | token transport manusia | binding sekali pakai → `principal_id` |
| Dedupe | `clientMessageId` | `UNIQUE(account_id, update_id)` sebelum 200 |
Web menempatkan chat sebagai panel (sibling Inbox), bukan node React Flow. Telegram grammar
deterministik (`/status`, `/projects`, `/task`, `/plan`, `/approve`, `/deny`, `/pause`, `/resume`,
`/cancel`, `/help`); tanpa `/exec`, shell, SQL, file write. Teks bebas = `ask` berbiaya, bukan
aksi; `/approve` membuka kartu decision, tidak mengeksekusi.
Kanal adalah adapter: keduanya memanggil `turnService` dan `approvalDecisionService` yang sama.
Outbox transaksional, satu dispatcher lease, backoff + jitter, dead-letter; tanpa network di
dalam transaksi ledger. Satu keputusan authoritative; kanal lain menampilkan "Approved in web".
## 10. Yang tidak boleh
1. Central sebagai node PTY atau menulis ke `outputLog` PTY.
2. Root token / `WEBTERM_TOKEN` / token node masuk env, prompt, event, atau tool result.
3. Central approve/consume aksinya sendiri, termasuk lewat loopback.
4. Central spawn worker, membuat agent, atau membuat task di luar `assign` item plan.
5. Central menulis `fact`/`core` atau mempromosikan claim sendiri.
6. Central pause/resume project atau menaikkan envelope tanpa manusia.
7. Approval dari group Telegram, auto-enroll pengirim asing, "yes" bebas sebagai consent.
8. Auto-approve saat expiry, sticky "always approve", approval dianggap exactly-once.
9. Replan tanpa batas, rewrite plan tiap tick, retry akar sama >3×.
10. Client menghitung digest/nonce atau mengirim `actor`/`authority`/`status`.
11. Transkrip mentah/secret/PII di log, memori, outbox, atau prompt.
12. LLM/LLM judge sebagai verifier atau sumber `achieved`.
13. Schema change tanpa migrasi; edit migrasi lama; dual-write memori.
14. Dependency runtime agent ditambah sebelum gate satu turn OpenCode nyata lulus (Claude/Codex
    tidak wajib, jadi jangan menambahkannya sebagai prasyarat).
## 11. MVP vs later
| Area | MVP (harus terbukti) | Later |
|---|---|---|
| Goal | `goal_json` + criteria + transisi + envelope | tabel `goal`, multi-goal/milestone |
| Plan | draft/replace 1 lane, WIP 1, replan ≤2 | `depends_on`, readiness DAG, paralel nyata |
| Runtime | OpenCode CLI satu turn + satu tool baca + cancel + resume | Adapter Claude/Codex opsional, routing biaya |
| Tool | baca portfolio/plan/task, propose goal/plan, assign, run request | katalog deferred, output spill, MCP eksternal |
| Chat | panel web, SSE, history, stop, retry aman, approval card | chat-as-node, queue, edit-and-resend, voice |
| Telegram | private bind + grammar + status + approval | group mirror, topic otomatis, rich draft |
| Memori | retrieval read-only + context builder + claim central | hybrid retrieval, konsolidasi, defrag |
| Otonomi | scheduler 1 item/tick yang ada | pemilihan goal/prioritas oleh LLM |
| Multi-user | satu owner + allowlist | RBAC per principal, audit per user |
**MVP bukan** "seluruh fitur selesai". Slice terkecil ada di `13` §1: migrasi v4 + goal service +
conversation store + mock runtime + satu tool baca + panel SSE, dengan runtime nyata masih off.
## 12. Keputusan terbuka
1. `core` menjadi `CORE.md` human-only atau tetap SQLite-only?
2. Scope `user`/`central`: `project_id NULL`, tabel terpisah, atau sentinel? (Unique index SQLite
   memperlakukan NULL sebagai berbeda.)
3. Siapa menerbitkan evidence ter-atesti, masa berlaku, dan binding ke commit?
4. Ekspor memori otomatis saat promote atau manual `pending durable`?
5. Allowlist command verifier: siapa yang boleh mengubah dan dengan review apa?
6. Budget habis: pause goal, atau turunkan WIP/model lebih dulu?
7. Satu workspace dipakai dua manusia: siapa owner goal dan approver?
8. Kapan `WEBTERM_CHANNELS=readonly|control` diimplementasikan?
## 13. Rujukan
- `09-CENTRAL-AGENT-RUNTIME.md` (bukti live OpenCode CLI 2.0.26, 2026-11-02),
  `10-CENTRAL-AGENT-PLANNING.md`, `11-CENTRAL-AGENT-CHAT.md`, `12-CENTRAL-AGENT-MEMORY.md`;
  `03-RENCANA.md` §7, `07-IMPLEMENTASI-P3-P5.md` §2-§4c, `14-CENTRAL-AGENT-S0.md` §6.
- Kode: `src/server/central/*`, `src/server/orchestrator/{plan,orchestratorAssign,approvalGate}.ts`,
  `src/server/ledger/*`, `src/server/channels/*`, `src/server/memory/*`.
