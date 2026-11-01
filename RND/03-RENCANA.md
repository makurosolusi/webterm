# RENCANA: Implementasi Agent Terpusat di webterm

Tanggal: 2026-10-31; status disegarkan 2026-11-01 (+08:00).
Status: P0-P2 terimplementasi. P3-P5 sebagian ada di working tree, **belum production-ready**.
Peta kode, gap, dan gate aktual: `07-IMPLEMENTASI-P3-P5.md`. Dokumen ini rencana eksekusi.

---

## 1. Prinsip eksekusi

1. **Satu fase = satu capability yang bisa didemokan.** Jangan bangun lapisan atas sebelum
   seam di bawahnya stabil.
2. **Branch per concern, commit kecil, tanpa push/merge tanpa perintah.**
3. **Test nyata sebelum klaim selesai.** Gate: typecheck, vitest, bun test, test baru.
4. **Feature flag default off**, kecuali perbaikan yang tidak mengubah perilaku lama.
5. **Tidak menambah kode ke file over-limit.** Pecah dulu, baru tambah.
6. **Jangan mengubah nama protokol `nodeterm`.** Env/header baru berawalan `webterm`.
7. **State otoritatif di server, bukan di prompt.** Event log = audit; task row = state.
8. **Verifikasi independen.** "Turn selesai" bukan "task selesai".

---

## 2. Baseline dan kendala nyata

| Area | Fakta | Dampak |
|---|---|---|
| PTY | Satu slot per sesi; `open` menimpa; `close` menghapus map sebelum kill | P0 wajib sebelum API |
| Auth | Satu token proses; loopback token-free; `tokensMatch(undefined,x)=true` | Perlu principal + opt-in eksplisit |
| Approval manusia | `/api/approvals/*` tanpa capability; default harus menolak loopback tanpa token | Root token atau `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` |
| Env | `ptyShell` membuang `WEBTERM_*`/`NODETERM_*`; token node di-inject per sesi | Root token tidak diwarisi PTY |
| Env lokal | `.env` mode `600`, hanya `HOST`/`PORT`; `WEBTERM_TOKEN` tidak disimpan | Bun auto-load `.env`; token harus eksplisit |
| Ledger | SQLite v1 stabil; v2 plan WIP; v3 kanal belum | Migrasi append-only, backup sebelum upgrade |
| Channels | Hanya `WEBTERM_TELEGRAM=on`; `WEBTERM_CHANNELS` belum ada di kode | P5 belum control plane |
| Test | Snapshot 12:22: tsc bersih; suite penuh belum hijau | Jangan klaim selesai |
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

P1 dan P2 boleh paralel setelah P0, tetapi merge P1 lebih dulu. P3 tidak boleh mulai tanpa P1
(spawn) dan P2 (evidence/fence). Central paling akhir dan opsional.

---

## 4. Ringkasan fase

| Fase | Hasil | Gate utama | Rollback |
|---|---|---|---|
| P0 | Multi-subscriber, seq log, exit benar, fake harness | Dua subscriber menerima output/exit sama | Revert branch, tanpa data |
| P1 | API spawn/prompt/wait/close, scoped token, env scrub | Matriks token negatif lulus | Flag off, token in-memory |
| P2 | Migration runner, ledger, lease/fence, usage/run | Migrasi idempoten; crash tidak setengah state | Restore backup |
| P3 | Orkestrator project, caps, verifikasi, approval | 3 worker, evidence lengkap, gate memblokir | Worktree dibuang, kill switch |
| P4 | Inbox, memory claim/FTS5, central tipis | Worker tidak bisa tulis fact/CORE | Flag off, FTS rebuildable |
| P5 | Adapter Telegram/webhook, identity, approval chat | Replay 1 aksi, cross-project ditolak | Flag off, revoke binding |

---

## 5. P0-P2: status historis

**P0 selesai.** `SubscriberSet`, `outputLog` dengan `seq`, `nodeRegistry`, `launchLine`,
`sessions.ts` jadi wiring, replay sekali ke joiner, close/exit ordering, tombstone bounded.
Test: 1063 vitest + 84 bun pada saat itu.

**P1 selesai.** `/api/control/*` spawn/prompt/wait/close/nodes; capability `wcap_*`
(verb + resource, TTL, sha256-at-rest, idempotent `requestId`); transport token per node;
hook Claude lewat file header `0600`; `WEBTERM_STRICT_HOOK_AUTH` opt-in; `cwd` dikurung.
Gate: 1199 vitest, 84 bun hijau saat itu.

**P2 fondasi selesai.** Migration runner (`BEGIN IMMEDIATE`, `user_version`, backup
`VACUUM INTO`, WAL), schema v1 (project/agent/task/event/decision/approval/run/usage/
prefix/budget/memory/memory_fts), task state machine + fence + lease + evidence, runtime
`WEBTERM_LEDGER=off|shadow|on`, reaper 30 detik, metrics in-memory.
Gate: 62 bun ledger test hijau saat itu.

Detail historis tidak diulang di sini; lihat `RND/README.md` §7 dan riwayat commit.

---

## 6. P3: project orchestrator

**Deliverable:** role agent/orchestrator/worker (`depth` 0..2, worker tidak spawn), worktree
per worker, caps (3 worker, 3 attempt, lease 10 menit), plan versioned, verifikasi independen
(git diff/test/typecheck/scope), approval blocking untuk aksi irreversible, audit append-only.

**Status 2026-11-01:** ledger approval `[V]`. Roles, caps, plan, worktree, orchestrator,
`control/approvalApi` `[W]` + test. Approval manusia `[W]` dengan gate token/opt-in dan
transisi review task (verify/fail) yang belum dites. Gap: spawn PTY produksi, verifikasi
independen sebagai satu-satunya jalur `verified`, gate blocking, route task/plan/agent,
worktree cleanup. Detail: `07-IMPLEMENTASI-P3-P5.md` §2.

**Acceptance:** plan 3 worker; worker ke-4 ditolak; worker spawn ditolak; evidence tanpa test
bukan `verified`; gate menolak aksi tanpa decision; human input tidak mencuri stream agent;
kill switch dan rollback drill lulus.

**Rollback:** worktree disposable, kill switch. `WEBTERM_ORCHESTRATOR` masih `[P]`.

### 6.1 Keputusan approval manusia

- Route `/api/approvals/*` **bukan** capability plane. Otoritasnya transport token root.
- Tanpa `WEBTERM_TOKEN`, route menolak `403 approval_requires_token`.
- `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` hanya untuk demo lokal sekali pakai.
- Agen tidak boleh menyetujui aksinya sendiri: node token/capability tidak membuka route ini.
- Control plane `/api/control/approval/*` tetap capability-gated.

---

## 7. P4: inbox, memory, central

**P4a (wajib):** inbox state-first (needs you/review/broken), decision rows, memory claim +
FTS5 + `memory_event`. Worker hanya claim; orkestrator promosikan dengan bukti mesin;
supersede/quarantine. File+git promotion ditunda ke P4b.

**Status 2026-11-01:** memory claim/promote/supersede/quarantine + FTS `[W]`; inbox projection
dan route baca `[W]`; klien inbox `[W]`. Gap: otoritas `actorKind` dari principal, route tulis
memory, P4b, central. Detail: `07-IMPLEMENTASI-P3-P5.md` §3.

**P4b (gated ≥2 project × 2 minggu):** fact file di git, CORE human-only, reindex files-win,
defrag lewat PR. Jangan dual-write; SQLite tetap indeks. `[P]`.

**Central (opsional):** router + portfolio projection, prioritas/budget dalam amplop manusia,
pause/resume, status lintas project. Tidak spawn worker, tidak tulis fact/CORE. `[P]`.

**Acceptance:** worker tidak bisa tulis central/CORE; claim tanpa source ditolak; supersede
menjaga history; FTS `MATCH`/bm25; path traversal ditolak; approve/reject mengubah task +
decision; inbox tidak memuat aksi otomatis; central menjawab dari proyeksi.

**Rollback:** flag memory off menyembunyikan search tetapi menyimpan baris; FTS rebuildable.

---

## 8. P5: Omnichannel

**Prasyarat:** P3 control API/ledger/approval, P4 inbox.

**Status 2026-11-01:** webhook verify/HMAC, identity/grammar, Telegram parse/send, outbox
in-memory, channel store `0600` `[W]` + test. Ingress `POST /webhooks/telegram` terpasang bila
`WEBTERM_TELEGRAM=on` + secret + ledger. Gap: `WEBTERM_CHANNELS` tidak ada di kode
(`[P]`), migrasi v3, binding produksi, sender outbox, approval bridge, uji jaringan nyata.
Detail: `07-IMPLEMENTASI-P3-P5.md` §4 dan `04-OMNICHANNEL.md`.

**Acceptance:** replay 100x satu aksi; cross-project ditolak; approval blocking + digest;
channel down tidak memblokir ledger; secret tidak di env/log; group tidak bisa approve.

**Rollback:** flag off, stop worker, revoke binding, delete webhook.

---

## 9. Traceability dan gap

Ringkasan lengkap di `05-TRACEABILITY.md`: 167 requirement ID (145 + 22 O), 88 punya
deliverable/file/test, 13 implisit, 64 belum punya fase, 2 deferred, owner 0.
Gap terbesar: cache, context, tool, routing, reliability tail, data lifecycle, UX, eval.

---

## 10. Test strategy

| Tier | Isi | Runner |
|---|---|---|
| T0 | Invariant: depth, cap, fence, redaction, false-success R1-R7 | vitest <1 menit |
| T1 | Golden task 20-40, deterministic grader, 5 trap false-success | `bun scripts/eval/t1.ts` |
| T2 | Paired same-model single vs orchestrator, k=3 | opt-in, <1 jam |
| T3 | Fault matrix: kill, duplicate, stale, 429, truncation | nightly |
| T4 | Replay penuh, cost reconciliation, label failure baru | weekly |

Fake wajib: `FakePty`, fake clock, fake Sessions, fake MCP transport, fixture JSONL Codex,
fixture SSE opencode. Test unit tidak boleh `setTimeout`/`Date.now` langsung. Test PTY nyata
budgeted-polling dan `TMPDIR=/tmp/st`.

Gate per PR: `npm run typecheck`, `npm test`, dan `bun test` untuk suite `.bun.test.ts`.
Snapshot 12:22: suite penuh belum hijau; lihat `07-IMPLEMENTASI-P3-P5.md` §1.

---

## 11. Observability dan deteksi dini

Metrics lokal tanpa PII:

- P0: subscriber/session, replay dup, dropped chunk, exit delivery miss, log truncation.
- P1: 4xx per reason, hook 403 (harus 0), spawn failure, kill switch.
- P2: migration ms, `SQLITE_BUSY`, lease expiry, suspect, stale-fence reject, wake latency.
- P3: cap rejection, claimed→verified rate, verify failure reason, gate denial, orphan worktree.
- P4: actionable inbox count, decision latency, unapproved irreversible attempt, stale fact.
- P5: webhook 401/413/duplicate, dispatch denial per reason, outbox retry/dead-letter.

Run record: `run_id, project, task, agent, depth, provider, model, route, prefix_hash,
tools_hash, tokens bucket, cost, outcome, failure_label, evidence_json, versions_json`.

False-success: klaim tanpa evidence, test contradict, scope lie, sha mismatch, state
contradiction, empty verifier, duplicate outcome.

---

## 12. Flag runtime

| Flag | Default | Status |
|---|---|---|
| `WEBTERM_TOKEN` | kosong (loopback token-free) | aktif; tidak disimpan di `.env` |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `0` (deny) | aktif |
| `WEBTERM_LEDGER` | `off` (`off|shadow|on`) | aktif |
| `WEBTERM_TELEGRAM` | `off` (`on` saja) | aktif |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | kosong | aktif |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | kosong; legacy `TELEGRAM_BOT_TOKEN` | aktif |
| `WEBTERM_CHANNELS` | — | rencana; belum dibaca kode |
| `WEBTERM_ALLOW_TOKEN_MINT` | `0` | aktif |
| `WEBTERM_STRICT_HOOK_AUTH` | `0` | aktif |

Data: backup `VACUUM INTO` sebelum migrasi, `integrity_check`, retensi 3. Migrasi per-file
transaksi. Restore = stop server, ganti file. Worktree disposable. FTS rebuildable.
Tidak ada deploy/push tanpa perintah.

### 12.1 `.env` dan secret

- `.env` lokal mode `600`; isinya hanya `HOST`/`PORT`. `WEBTERM_TOKEN` **tidak** disimpan
  di `.env` (tidak ikut auto-load). Token root harus diekspor eksplisit atau diganti opt-in
  loopback untuk demo.
- Bun memuat `.env` otomatis untuk dev server dan binary. Karena itu, apa pun yang ditulis
  di `.env` masuk ke `process.env`; jangan taruh secret yang tidak ingin diwarisi.
- `.gitignore` menutup `.env`, `.env.*` (kecuali `.env.example`). Tidak ada nilai token di
  dokumen/log/test/commit. Log server hanya `len=N`.
- `TELEGRAM_BOT_TOKEN` legacy dan secret kanal tidak boleh muncul di env anak/log; store
  kanal `0600`/`0700`.

---

## 13. Keselarasan keputusan

- **Memori:** file+git truth, SQLite indeks; P4a claim/FTS5, P4b file promotion. Tanpa dual-write.
- **Project:** `project` 1:1 `workspace_id`; workspace tetap kanvas.
- **Roadmap:** 5 fase P0-P5; Fase 0-7 AGENT_PUSAT dipetakan, bukan dipakai ganda.
- **Token:** scoped per agent, tidak diwariskan; loopback bukan principal.
- **Approval:** kelas risiko + digest + blocking, bukan queue advisory. Manusia butuh token
  root atau opt-in loopback eksplisit; agen tidak bisa approve aksi sendiri.
- **Depth:** 3 peran, spawn depth ≤2; lane lead tidak spawn.
- **opencode:** Claude-first MVP; adapter HTTP fase lanjut.
- **Framework:** kernel sendiri; OpenAI Agents SDK JS hanya jika adopsi.
- **Durability:** tanpa engine sampai ambang multi-host/HA/>1.000 run.
- **Omnichannel:** adapter ingress, bukan control plane; Telegram P5, flag off.

---

## 14. File ownership

Satu owner per file per wave: W1 sessions/subscribers/outputLog; W2 auth/db; W3 lease/reaper;
W4 worktree/verify; W5 inbox server+client; W6 memory; W7 central+docs; W8 channel ingress.
`index.ts`, `api.ts`, `control/mount.ts`, dan migrasi ledger adalah shared single-owner.
Approval: `approvalHumanApi.ts`, `approvalAuth.ts`, `client/InboxPanel.tsx` satu owner.
Lane client tidak menyentuh server; migration append-only; tidak ada commit/push dari worker.

---

## 15. Stop/go gate

1. **G1 Seam:** dua subscriber menerima output dan exit sama; late join tanpa duplikat.
2. **G2 Auth:** matriks token negatif lulus; hook Claude 200; tidak ada `WEBTERM_*` di child;
   approval manusia menolak loopback token-free.
3. **G3 Data:** migrasi idempoten pada salinan DB; crash tidak setengah state.
4. **G4 Orchestrator:** `verified` butuh verifikasi server, bukan payload worker; human input
   tidak mencuri stream; cap memblokir; review task benar-benar bertransisi.
5. **G5 Memory:** worker tidak bisa tulis fact/CORE; claim tanpa bukti ditolak; supersede
   menjaga history.
6. **G6 Central:** hanya setelah 2 project berjalan P3 ≥2 minggu dan verified rate memenuhi
   ambang.
7. **G7 Omnichannel:** replay 100x satu aksi; cross-project ditolak; approval chat blocking;
   channel down tidak memblokir ledger; token tidak ada di env/log.

Status per gate dan blocker produksi: `07-IMPLEMENTASI-P3-P5.md` §8.

---

## 16. Keputusan terbuka

1. Mint capability di loopback: CLI lokal atau route `/token` loopback?
2. Requester boleh memegang `approval.decide`? Rekomendasi: tidak.
3. Approved-unconsumed: route list manusia atau decide idempoten? Rekomendasi keduanya.
4. Secret kanal: file `0600` atau Keychain; env hanya untuk dev?
5. Worktree dirty: `--force` atau pertahankan sampai approval?
6. Verifier allowlist: command apa dan siapa yang boleh mengubah?
7. Group chat: read-only total atau `operator`? Rekomendasi read-only total.
8. `WEBTERM_CHANNELS` dan mode `readonly|control`: kapan diimplementasikan?

---

## 17. Artefak

- `01-TEMUAN.md`, `02-KEBUTUHAN.md`, `04-OMNICHANNEL.md`, `05-TRACEABILITY.md`, `06-BUG-RISK.md`.
- `07-IMPLEMENTASI-P3-P5.md`: peta kode + gate.
- `RND/qc/p3-*.md`: QC security, integration, tests, E2E UI.
- `90-REFERENSI/AGENT_PUSAT.md`: bukti detail dan URL.
- Rencana ini tidak mengubah kode. Eksekusi hanya setelah branch dan gate disetujui.
