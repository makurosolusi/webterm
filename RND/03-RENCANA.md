# RENCANA: Implementasi Agent Terpusat di webterm

Tanggal: 2026-10-31
Status: rencana eksekusi. Belum ada kode yang diubah.
Bahan: `01-TEMUAN.md`, `02-KEBUTUHAN.md`, `90-REFERENSI/AGENT_PUSAT.md`, 13 audit wave 5.
Tujuan: langkah perencanaan, mitigasi langsung, deteksi dini bug, dan keselarasan presisi
dengan kode webterm yang sudah ada.

---

## 1. Prinsip eksekusi

1. **Satu fase = satu capability yang bisa didemokan.** Jangan membangun lapisan atas
   sebelum seam di bawahnya stabil.
2. **Branch per concern, commit kecil, tanpa push/merge tanpa perintah.**
3. **Test nyata sebelum klaim selesai.** Gate: typecheck, vitest, bun test, dan test baru.
4. **Feature flag default off**, kecuali perbaikan yang tidak mengubah perilaku lama.
5. **Tidak menambah kode ke file over-limit.** `sessions.ts` 300 baris, `api.ts` 154,
   `App.tsx` 436/22k, `SessionsPanel.tsx` 456/20k, `workspace.ts` 444.
6. **Jangan mengubah nama protokol `nodeterm`.** Header/env baru berawalan `webterm`.
7. **State otoritatif di server, bukan di prompt.** Event log adalah audit; task row adalah
   state sekarang.
8. **Verifikasi independen.** "Turn selesai" bukan "task selesai".

---

## 2. Baseline dan kendala nyata

| Area | Fakta | Dampak ke rencana |
|---|---|---|
| PTY | `Session.send` satu slot; `open` menimpa; `close` menghapus map sebelum `kill` | P0 wajib sebelum API/orkestrator |
| File health | `sessions.ts` tepat 300 | Ekstrak `subscribers.ts`, `outputLog.ts`, `launchLine.ts` dulu |
| API | `api.ts` 154, batas route 150 | Ekstrak `agentStatusApi.ts` sebelum P1 |
| DB | Hanya `workspace` + `app`; tanpa `user_version`, WAL, busy_timeout. Default Bun: FK off, busy_timeout 0, `db.transaction()` DEFERRED | P2 wajib migration runner + pragma + `BEGIN IMMEDIATE` |
| Auth | Satu token proses; loopback tanpa token; `tokensMatch(undefined,x)=true` | Scope test bisa lolos diam-diam; perlu principal |
| Env | `ptyShell` mempertahankan `WEBTERM_*` | Setiap child membawa token root |
| Hooks | `stateVerified` tidak dipanggil; `nodeId` disisipkan tanpa escape | Fail-open dan shell injection |
| Autosave | PUT whole workspace, debounce 400 ms, tanpa ETag | Ada bug lintas-workspace; P2 perbaiki |
| Test | 1.104 `test(`/`it(`, 12 file bun test | Seam palsu dan clock belum ada |
| Bun/SQLite | Bun 1.4.2, SQLite 3.43.2 di rentang bug WAL-reset | Satu writer, backup, waspada |

---

## 3. Critical path

```
P0 Observation seam
  -> P1 Headless control + scoped auth
  -> P2 Ledger + migration + usage + scheduler
  -> P3 Project orchestrator + verification + approval
  -> P4 Inbox + memory (claim/FTS5) + central thin
  -> P5 Omnichannel (Telegram + webhook)
```

P1 dan P2 boleh paralel setelah P0, tetapi merge P1 lebih dulu (`index.ts` satu penulis per wave).
P3 tidak boleh mulai tanpa P1 (spawn) dan P2 (evidence/fence). Central paling akhir dan opsional.

---

## 4. Ringkasan fase

| Fase | Hasil | Gate utama | Rollback |
|---|---|---|---|
| P0 | Multi-subscriber, seq log, exit benar, fake harness | Dua subscriber menerima output/exit sama; replay tidak duplikat | Revert branch, tanpa data |
| P1 | API spawn/prompt/wait/close, scoped token, env scrub | Matriks token negatif lulus; hook Claude tetap 200 | Flag off, token in-memory |
| P2 | Migration runner, ledger, lease/fence, usage/run | Migrasi idempoten; crash tidak setengah state | Restore backup |
| P3 | Orkestrator project, caps, verifikasi, gate | 3 worker, evidence lengkap, gate memblokir | Worktree dibuang, kill switch |
| P4 | Inbox, memory claim/FTS5, central tipis | Worker tidak bisa tulis fact/CORE; inbox actionable | Flag off, FTS rebuildable |
| P5 | Adapter Telegram/webhook, identity, approval chat, outbox | Replay 1 aksi, cross-project ditolak, approval blocking | Flag off, revoke binding |

---

## 5. P0: Observation seam

**Tujuan:** manusia dan orkestrator bisa mengamati PTY yang sama tanpa saling mencuri output.

**Deliverable:**
1. `src/server/subscribers.ts`: `SubscriberSet` add/remove/send, snapshot iteration,
   per-subscriber try/catch.
2. `src/server/outputLog.ts`: append dengan `seq`, `since(seq)`, `floorSeq`, eviction byte
   UTF-8, tidak pernah membuang chunk terbaru.
3. `src/server/nodeRegistry.ts`: status, transcript, exit tombstone (maks 256), TTL.
4. `src/server/launchLine.ts`: pindahkan dari `sessions.ts` + re-export.
5. `sessions.ts` menjadi wiring <=200 baris: `Session {id, pty, log, subs, exited}`.
6. `subscribe(id, send)`, `list()`, `statusOf`, `isLive`, `getExit`, `pidOf`.
7. Replay hanya ke subscriber baru; status snapshot hanya ke joiner.
8. Fix `close`: cleanup -> status revocation -> tombstone -> broadcast exit -> clear -> delete ->
   `pty.kill()`. `onExit` identity-gate; tombstone `self`.
9. `spawn`/`now` injectable di `SessionsOptions`.
10. Client: `seq`/`reason` additive; `exitNotice(code, reason)`; `closed` tidak menulis notice.

**Acceptance:**
- Dua `open` id sama: keduanya menerima output baru; joiner menerima scrollback sekali.
- `detach(a)` tidak memutus b.
- `close` mengirim tepat satu `exit{reason:'closed'}` ke semua; exit code self tetap.
- `list()` tidak memuat sesi mati; tombstone bounded.
- Test lama hanya berubah di helper, bukan assertion perilaku lama.

**Risiko:** replay gap vs duplikat. `open` sinkron, tanpa `await` antara add dan replay. Dokumentasikan.
**Rollback:** P0 tanpa schema; revert branch mengembalikan single-slot.

---

## 6. P1: Headless control + auth

**Prasyarat:** P0; ekstrak `agentStatusApi.ts` dari `api.ts`.

**Endpoint `/api/control/*`:** spawn, prompt, wait, close, nodes, plan (501 sampai P2).
Semua mutasi membawa `requestId`; duplikat 10 menit me-replay ack tanpa efek kedua.
`wait` adalah long-poll 25 detik, bukan durable object.

**Token:**
- `wcap_*` opaque, hash-at-rest, `{verb,resource,qualifier,expiresAt}`.
- Verb: `node.spawn|prompt|wait|close|read|plan.read`.
- Resource: `node:<id>`, `workspace:<id>`, `project:<id>`.
- TTL 15 menit, maks 60. Tanpa inheritance; child env tidak membawa capability.
- `tokensMatch(undefined,x)` tetap true untuk transport; `capabilityMatches(undefined,x)` false.
- Mint hanya CLI loopback atau flag root eksplisit.

**Auth:**
- Per-node transport token menggantikan `$WEBTERM_TOKEN` global di PTY.
- `authorize` memetakan process token, node token, dan capability.
- `stateVerified` fail-closed di balik `WEBTERM_STRICT_HOOK_AUTH=1`; default off dulu, lalu warn,
   lalu enforce.
- `transcript_path` dibatasi ke `~/.claude/projects` atau data dir.
- `PUT /api/settings` hanya human/root; itu penulisan kode.

**Satu jalur exec:** WS `open` dan control `spawn` sama-sama memanggil `sessions.open`.
`spawn` tidak menerima `cmd` mentah; command dari `agentLaunchCommands[agentId]`.
`cwd` di-realpath dan harus di bawah workspace root.

**Env scrub:** buang `WEBTERM_*`, `NODETERM_*`, `NODE_ENV`, `PORT`, `HOST`, `VITE_*`,
`BUN_*`, lalu inject hanya variabel per-PTY yang dibutuhkan. `*_API_KEY` belum di-scrub;
catat sebagai follow-up.

**Acceptance:** matriks negatif (scope/resource/expired/node A ke node B) 401/403;
duplikat requestId satu PTY; spawn cmd mentah 400; path escape 403; child env tanpa root token;
hook Claude tetap 200; kill switch menghentikan semua PTY.

**Rollback:** flag `WEBTERM_AGENT_API` dan `WEBTERM_TOKEN_SCOPE=off|warn|enforce`.

---

## 7. P2: Ledger, migration, usage

**Migration runner:**
- `PRAGMA foreign_keys=ON`, `busy_timeout=5000`, `journal_mode=WAL` (file saja),
  `synchronous=NORMAL`, `user_version`. `db.transaction()` DEFERRED, jadi pakai `BEGIN IMMEDIATE` manual.
- Versi lebih baru dari kode -> throw.
- Backup `VACUUM INTO` + `integrity_check` sebelum migrasi destruktif.
- Satu transaksi `BEGIN IMMEDIATE` per migrasi; error rollback + throw.

**Tabel:** project, agent, task, event, decision, approval, run, usage, prefix, budget,
memory, memory_event, memory_fts. Semua `*_json` memakai `json_valid`.
Index hanya yang punya query nyata.

**Task:** status `pending, leased, suspect, claimed_done, verified, blocked, failed, cancelled,
reopened`; `fence` monotonik; `lease_owner`, `lease_expires`, `heartbeat_at`, `attempt`,
`max_attempts`, `idem_key`, `evidence_json`.

**Scheduler:** tick 30 detik, wake maks 60 detik; reaper mengubah lease kedaluwarsa menjadi
`suspect`, revoke sesi, requeue dengan fence baru. Jangan langsung `pending`.
`project.lock_epoch` mencegah sesi basi.

**Transaksi:** task + event satu transaksi. Aksi berisiko: intent -> aksi -> outcome.
`idem_key` di level aksi. External side effect at-least-once + idempotent.

**Usage/run:** pindahkan ke P2, bukan P3. Bucket terpisah input/output/cache-read/cache-write;
`provider_response_id` unik; unknown != 0; hard budget cap lokal.

**Acceptance:** migrasi idempoten pada salinan DB nyata; crash injection tidak meninggalkan
task/event setengah; stale fence ditolak; depth 3 ditolak; task+event rollback bersama;
workspace delete cascade project/agent/task/run, memory tetap.

**Rollback:** `WEBTERM_LEDGER=off|shadow|on`; shadow satu minggu sebelum enforce; backup 3 terakhir.

---

## 8. P3: Project orchestrator

**Deliverable:**
- Role agent/orchestrator/worker; `depth` CHECK 0..2; worker tidak spawn.
- Worktree per worker; satu owner per branch.
- Caps: 3 worker paralel, 3 attempt, lease 10 menit, token/USD/turn/waktu. Cap memblokir.
- Plan versioned per project; assign task sebelum spawn; update hanya participant.
- Verifikasi independen: git diff, test, typecheck, file-scope; `evidence_json`.
- Approval blocking untuk merge, push, migration, credential, mass delete.
- Audit append-only dengan actor, action digest, decision, result.
- Split `App.tsx`/`SessionsPanel.tsx` hanya saat disentuh.

**Acceptance:** plan dengan 3 worker; worker ke-4 ditolak; worker spawn ditolak; evidence
tanpa test bukan `verified`; gate menolak aksi tanpa decision; manusia mengetik tidak mencuri
stream agent; kill switch dan rollback drill lulus.

**Rollback:** worktree disposable; `WEBTERM_ORCHESTRATOR=off`; kill switch.

---

## 9. P4: Inbox, memory, central

**P4a (wajib):** inbox state-first (needs you/review/broken), decision rows, memory claim +
FTS5 index (unicode61 sudah diuji) + `memory_event`. Worker hanya claim; orkestrator mempromosikan
dengan bukti mesin; supersede/conflicting; quarantine. File+git promotion ditunda ke P4b.

**P4b (gated >=2 project x 2 minggu):** fact files di git, CORE human-only, reindex files-win,
defrag lewat PR. Jangan dual-write; SQLite tetap indeks.

**Central (opsional):** router + portfolio projection, prioritas/budget dalam amplop manusia,
pause/resume, status lintas project. Tidak spawn worker, tidak tulis fact/CORE.

**Acceptance:** worker tidak bisa tulis central/CORE; claim tanpa source ditolak; supersede
menjaga history; FTS `MATCH`/bm25; path traversal ditolak; approve/reject mengubah task+decision;
inbox tidak memuat aksi otomatis; central menjawab dari proyeksi, bukan scan event.

**Rollback:** `WEBTERM_MEMORY=off` menyembunyikan search tetapi menyimpan baris; FTS rebuildable.

---

### 9.1 P5: Omnichannel control (Telegram + webhook)

**Prasyarat:** P3 control API/ledger/approval, P4 inbox. Flag `WEBTERM_CHANNELS=off|shadow|on`,
`WEBTERM_TELEGRAM=off|readonly|control`.

**Deliverable:** adapter contract, ingress/dedupe, identity binding, conversation ke project,
command grammar, approval bridge, outbound outbox, notification policy. v1 hanya Telegram dan
generic webhook. Detail: `04-OMNICHANNEL.md`; requirement: `02-KEBUTUHAN.md` O1-O22.

**Acceptance:** replay 100x satu aksi; cross-project ditolak; approval blocking + digest;
channel down tidak memblokir ledger; secret tidak di env/log; group tidak bisa approve.

**Rollback:** flag off, stop worker, revoke binding, delete webhook.

---

## 10. Traceability dan gap

Ringkasan lengkap ada di `05-TRACEABILITY.md`. Status: 167 requirement ID (145 + 22 O),
88 punya deliverable/file/test, 13 implisit, 64 belum punya fase, 2 deferred, owner 0.
Gap terbesar: cache, context, tool, routing, reliability tail, data lifecycle, UX, eval.

---

## 11. Bug yang harus dicegah lebih dulu

Daftar lengkap B1-B12, trigger, mitigasi, dan test ada di `06-BUG-RISK.md`.
B1 (save lintas-workspace) dan B3 (nodeId injection) diperbaiki di P0/P1; B2/B4 blocker orkestrasi.

---

## 12. Test strategy

| Tier | Isi | Runner |
|---|---|---|
| T0 | Invariant: depth, cap, fence, redaction, false-success R1-R7 | vitest <1 menit |
| T1 | Golden task 20-40, deterministic grader, 5 trap false-success | `bun scripts/eval/t1.ts` |
| T2 | Paired same-model single vs orchestrator, k=3 | opt-in, <1 jam |
| T3 | Fault matrix: kill, duplicate, stale, 429, truncation | nightly |
| T4 | Replay penuh, cost reconciliation, label failure baru | weekly |

Fake yang wajib: `FakePty`, fake clock, fake Sessions, fake MCP transport, fixture JSONL Codex,
fixture SSE opencode. Test unit tidak boleh `setTimeout`/`Date.now` langsung. Test PTY nyata
tetap budgeted-polling dan `TMPDIR=/tmp/st`.

Gate per PR: `npm run typecheck`, `npm test`, `bun test src/server/*.bun.test.ts`.
Jika test adapter di subfolder, ubah glob ke `src/server/**/*.bun.test.ts` dan update CLAUDE.md/README.

---

## 13. Observability dan deteksi dini

Metrics per fase (counter lokal, tanpa PII):
- P0: subscribers/session, replay dup, dropped chunk, exit delivery miss, log truncation.
- P1: 4xx per reason, hook 403 (harus 0), spawn failure, time-to-first-output, kill switch.
- P2: migration ms, SQLITE_BUSY, lease expiry, suspect count, stale-fence reject, wake latency,
  orphan session.
- P3: cap rejection, claimed->verified rate, verify failure reason, attempt/task, gate denial,
  orphan worktree.
- P4: actionable inbox count, decision latency, unapproved irreversible attempt, claim reject,
  stale fact read.

Run record: `run_id, project, task, agent, depth, provider, model, route, prefix_hash, tools_hash,
tokens bucket, cost, outcome, failure_label, evidence_json, versions_json`.
Trace: OTel GenAI `invoke_workflow -> plan -> invoke_agent -> chat/tool`; konten off.
False-success: klaim tanpa evidence, test contradict, scope lie, sha mismatch, state contradiction,
empty verifier, duplicate outcome.

---

## 14. Rollback, flag, dan data

| Flag | Default | Fungsi |
|---|---|---|
| `WEBTERM_FANOUT` | off saat P0 | Multi-subscriber |
| `WEBTERM_AGENT_API` | off | Control API |
| `WEBTERM_TOKEN_SCOPE` | off/warn/enforce | Scoped token |
| `WEBTERM_STATE_VERIFY` | off/warn/enforce | Hook fail-closed |
| `WEBTERM_LEDGER` | off/shadow/on | Ledger |
| `WEBTERM_ORCHESTRATOR` | off | Orkestrator |
| `WEBTERM_MEMORY` | off | Memory |
| `WEBTERM_CENTRAL` | off | Agent pusat |
| `WEBTERM_CHANNELS` | off | Adapter kanal (off/shadow/on) |
| `WEBTERM_TELEGRAM` | off | Telegram (off/readonly/control) |

Data: backup `VACUUM INTO` sebelum migrasi, `integrity_check`, retensi 3. Migrasi per-file
transaksi. Restore = stop server, ganti file. Worktree disposable. FTS rebuildable.
Tidak ada deploy/push tanpa perintah.

---

## 15. Keselarasan dengan dokumen

Konflik yang sudah diputuskan:
- **Memori:** file+git truth, SQLite indeks; P4a claim/FTS5, P4b file promotion. Tidak dual-write.
- **Project:** `project` 1:1 `workspace_id`; workspace tetap kanvas.
- **Roadmap:** 5 fase P0-P4; Fase 0-7 AGENT_PUSAT dipetakan, bukan dipakai ganda.
- **Token:** scoped per agent, tidak diwariskan; loopback bukan principal.
- **Approval:** kelas risiko + digest + blocking, bukan queue advisory.
- **Depth:** 3 peran, spawn depth <=2; lane lead tidak spawn.
- **opencode:** Claude-first MVP; adapter HTTP fase lanjut.
- **Framework:** kernel sendiri; OpenAI Agents SDK JS hanya jika adopsi.
- **Durability:** tanpa engine sampai ambang multi-host/HA/>1.000 run.
- **Omnichannel:** adapter ingress, bukan control plane; Telegram P5, flag off, approval chat blocking.

---

## 16. File ownership dan paralelisasi

| Wave | Lane A server | Lane B data/API | Lane C client | Shared single owner |
|---|---|---|---|---|
| W1 | sessions, subscribers, outputLog, fake | test clock, route harness | - | index.ts (A) |
| W2 | auth, sessionsApi, agentStatusApi | db, migrations, repos | - | api.ts split (B) |
| W3 | lease/wake/scheduler | event/evidence/run | - | index.ts (A) |
| W4 | worktree/spawn controller | verify/task service | client split first | App shell (C) |
| W5 | panel server contracts | e2e VS2 | inbox/panel | - |
| W6 | memory store/API | memory UI | - | index.ts (A) |
| W7 | central router | docs/CHANGELOG | - | - |
| W8 | channel ingress/outbox | telegram adapter | SettingsChannels | index.ts (A), api.ts (B) |

Aturan: satu owner per file per wave; lane client tidak menyentuh server; lane server tidak
menyentuh client; migration bernomor dan append-only; tidak ada commit/push dari worker.

---

## 17. Stop/go gate

1. **G1 Seam:** dua subscriber menerima output dan exit sama; late join tanpa duplikat; test lama
   hanya berubah di helper. Gagal = stop.
2. **G2 Auth:** matriks token negatif lulus; hook Claude 200; tidak ada `WEBTERM_*` di child.
   Satu hook 403 atau bypass scope = no-go.
3. **G3 Data:** migrasi idempoten pada salinan DB; crash tidak setengah state; jumlah baris/byte
   sama. Kehilangan data = restore dan stop.
4. **G4 Orchestrator:** `verified` butuh evidence; human input tidak mencuri stream; cap memblokir.
5. **G5 Memory:** worker tidak bisa tulis fact/CORE; claim tanpa bukti ditolak; supersede menjaga history.
6. **G6 Central:** hanya setelah 2 project berjalan P3 >=2 minggu dan verified rate memenuhi
   ambang yang ditetapkan (mis. >=80% claimed tanpa rework).
7. **G7 Omnichannel:** replay 100x satu aksi; cross-project ditolak; approval chat blocking +
   digest; channel down tidak memblokir ledger; token tidak ada di env/log.

---

## 18. Tujuh hari pertama

1. Branch `feature/pty-observation-seam` dari branch utama.
2. Tambah `subscribers.ts`, `outputLog.ts`, `nodeRegistry.ts`, `launchLine.ts` + test.
3. Refactor `sessions.ts` menjadi wiring, tambah read API, fake spawn/clock.
4. Perbaiki replay dan close/onExit ordering.
5. Perbaiki B1 (timer switch) dan B3 (nodeId escape) di branch terpisah.
6. Jalankan typecheck, vitest, bun test; pastikan 33 test sesi lama tetap lulus dengan helper baru.
7. Tulis catatan hasil + metrik awal; jangan lanjut P1 sebelum G1 lulus.

---

## 19. Keputusan terbuka

1. Apakah `wait` P1 cukup long-poll atau langsung durable object di P2?
2. Apakah memory file promotion benar-benar ditunda sampai 2 project, atau perlu lebih awal?
3. Apakah `stateVerified` langsung enforce atau satu rilis warn?
4. Apakah central mengelola budget atau hanya membaca proyeksi?
5. Apakah opencode adapter masuk P3 atau P4?
6. Apakah backup otomatis tiap boot atau hanya sebelum migrasi?
7. Siapa owner requirement C/X/T/R yang saat ini 0/145?
8. Apakah Telegram cukup private chat + topic, atau perlu forum supergroup sejak v1?
9. Apakah approval chat diizinkan untuk aksi irreversible, atau hanya notify + step-up web?

---

## 20. Artefak

- `01-TEMUAN.md`, `02-KEBUTUHAN.md`, `04-OMNICHANNEL.md`, `05-TRACEABILITY.md`, `06-BUG-RISK.md`.
- `90-REFERENSI/AGENT_PUSAT.md`: bukti lengkap dan URL.
- `~/.jcode/scratch/orchestra/wave5-*.md`, `wave6-*.md`: audit implementasi dan omnichannel.
- Rencana ini sengaja tidak mengubah kode. Eksekusi dimulai hanya setelah branch dan gate disetujui.
