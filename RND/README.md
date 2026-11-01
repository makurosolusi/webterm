# RND — Agent Pusat webterm

Status: riset, perencanaan, dan implementasi bertahap. **P0-P2 selesai.**
**P3 tertutup end-to-end; P4/P5 ter-wire lewat HTTP tetapi belum production-ready.**
Branch aktif `feature/agent-pusat-p3`; commit terakhir `2f04f77` (wave 2 + loop worker).
Snapshot status: 2026-11-01 15:24 (+08:00).

Semua dokumen di folder ini bahan keputusan sebelum implementasi lebih lanjut.

---

## 1. Mulai dari sini

1. `00-RINGKASAN.md` — vonis, prinsip, keputusan inti.
2. `01-TEMUAN.md` — temuan project dan riset.
3. `02-KEBUTUHAN.md` — requirement per domain (K/S/M/C/X/T/R/A/I/E/U/D/O).
4. `03-RENCANA.md` — fase P0-P5, gate, rollback, mitigasi.
5. `04-OMNICHANNEL.md` — Telegram/webhook, identitas, approval chat.
6. `05-TRACEABILITY.md` — coverage dan gap.
7. `06-BUG-RISK.md` — bug B1-B12 dan deteksi dini.
8. `07-IMPLEMENTASI-P3-P5.md` — peta kode P3/P4/P5, gap, acceptance, gate.
9. `qc/` — review P0-P4: security, integration, tests, E2E UI, acceptance wave 2 dan
   `p4-wave2-fixes.md` (temuan → fix → bukti, residual).
10. `90-REFERENSI/AGENT_PUSAT.md` — bukti detail, URL, insiden.
11. `90-REFERENSI/BUKTI.md` — artefak riset dan clone Jcode.

---

## 2. Struktur

```
RND/
  README.md
  00-RINGKASAN.md
  01-TEMUAN.md
  02-KEBUTUHAN.md
  03-RENCANA.md
  04-OMNICHANNEL.md
  05-TRACEABILITY.md
  06-BUG-RISK.md
  07-IMPLEMENTASI-P3-P5.md
  qc/
    p1-*.md p2-*.md p3-*.md p3-e2e-ui-assets/
  90-REFERENSI/
    AGENT_PUSAT.md
    BUKTI.md
```

---

## 3. Keputusan yang sudah diambil

| Topik | Keputusan |
|---|---|
| Bentuk | 3 peran, 2 hop komando: agent pusat (depth 0), orkestrator project (1), worker (2) |
| Agent pusat | Router + portfolio authority, bukan eksekutor; opsional setelah project orchestrator stabil |
| State | Ledger SQLite + event log; task row = state, event = audit |
| Memory | File+git truth, SQLite FTS5 index, claim -> fact; P4a lalu P4b |
| Cache | Prefix-exact, sticky route, prefix hash, hit/miss accounting |
| Context | Budget per peran, compaction 80/95, summary schema, cross-agent ledger |
| Tool | Catalog + deferred search, output spill, policy, untrusted result |
| Security | Principal, scoped token, blocking approval digest, blast-radius gate |
| Approval manusia | Root token wajib, atau `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` untuk demo lokal |
| Self-approval | Agen tidak boleh approve/consume aksinya sendiri; node token tidak membuka route manusia |
| Omnichannel | Adapter ingress, bukan control plane; Telegram P5, flag off |
| Framework | Kernel sendiri; OpenAI Agents SDK JS hanya jika adopsi |
| Durability | Tanpa engine sampai ambang multi-host/HA/>1.000 run |
| Docs | RND sumber perencanaan; kode P3-P5 belum boleh disebut selesai |

---

## 4. Fase

```
P0 Observation seam
 -> P1 Headless control + scoped auth
 -> P2 Ledger + migration + usage + scheduler
 -> P3 Project orchestrator + verification + approval
 -> P4 Inbox + memory + central thin
 -> P5 Omnichannel (Telegram + webhook)
```

| Fase | Status | Catatan |
|---|---|---|
| P0 | ✅ selesai | seam, replay, close/exit, tombstone |
| P1 | ✅ selesai | control API, capability `wcap_*`, node token |
| P2 | ✅ selesai | ledger v1, migration runner, lease/fence, reaper |
| P3 | ✅ | approval + inbox + review verify/fail; gate blocking di jalur run belum |
| P4 | ⚠️ WIP | memory + inbox baca; file/git truth (P4b) di balik flag; soak 2×2 minggu belum |
| P5 | ⚠️ WIP | ingress + store + binding + sender; uji jaringan nyata belum |
| Central | ⚠️ | proyeksi portfolio + pause/resume/priority; agen otonom belum |

Gate: G1 seam, G2 auth, G3 data, G4 orchestrator, G5 memory, G6 central, G7 omnichannel.
Detail `03-RENCANA.md` dan `07-IMPLEMENTASI-P3-P5.md`.

---

## 5. Flag dan `.env`

| Flag | Default | Status |
|---|---|---|
| `WEBTERM_TOKEN` | kosong (loopback token-free) | aktif; tidak disimpan di `.env` |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `0` (deny) | aktif; opt-in demo lokal |
| `WEBTERM_LEDGER` | `off` (`off|shadow|on`) | aktif |
| `WEBTERM_TELEGRAM` | `off` (`on` saja) | aktif |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | kosong | aktif |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | kosong; legacy `TELEGRAM_BOT_TOKEN` | aktif |
| `WEBTERM_CHANNELS` | — | `[P]`; belum dibaca kode |
| `WEBTERM_ORCHESTRATOR_RUN` | `off` | aktif; gate run/bootstrap/assign |
| `WEBTERM_MEMORY_FILES` | `off` | aktif; gate export/rebuild |
| `WEBTERM_MEMORY_DIR` | `<dataDir>/memory` (absolut) | aktif |
| `WEBTERM_CENTRAL` | `off` | aktif; gate `/api/central/*` |
| `WEBTERM_ALLOW_TOKEN_MINT` | `0` | aktif |
| `WEBTERM_STRICT_HOOK_AUTH` | `0` | aktif |

- `.env` lokal mode `600`, hanya `HOST`/`PORT`. `WEBTERM_TOKEN` tidak lagi disimpan di sana.
- Bun auto-load `.env` untuk dev server dan binary. Apa pun di `.env` masuk `process.env`;
  jangan taruh secret yang tidak ingin diwarisi.
- Token root harus diekspor eksplisit. Tanpa token, approval manusia menolak loopback.
- `.gitignore` menutup `.env`, `.env.*` (kecuali `.env.example`). Tidak ada secret di dokumen.

---

## 6. Cara melanjutkan

1. Baca `03-RENCANA.md` dan `07-IMPLEMENTASI-P3-P5.md`; jangan lompat fase.
2. Pilih gap yang belum selesai; branch baru per concern.
3. Sebelum kode: cek `02-KEBUTUHAN.md` dan `05-TRACEABILITY.md`.
4. Setelah kode: jalankan typecheck, vitest, bun test pada tree yang sama.
5. Update CHANGELOG bila perilaku publik berubah.
6. Jangan push/deploy/merge tanpa perintah eksplisit.

---

## 7. Aturan dokumen

- Satu dokumen satu tanggung jawab.
- Jangan menduplikasi tabel besar; tautkan file.
- Setiap requirement punya ID, fase, file, test, evidence.
- Angka vendor dan klaim belum terverifikasi tetap di `90-REFERENSI/AGENT_PUSAT.md`.
- Jika dokumen melewati batas sehat, pecah ke file baru dan update README.
- Bahasa: Indonesia; istilah teknis tetap Inggris bila lebih tepat.

---

## 8. Status singkat

### Snapshot 2026-11-01 15:24 (`2f04f77`)

- `tsc --noEmit`: **bersih**.
- `vitest run` penuh: **127 file / 1697 test lulus**.
- `bun test` penuh: **28 file / 201 test lulus**.
- Flake diketahui: `terminalCore` / `paneSplit` di bawah beban paralel, lulus terisolasi.
  Jangan klaim deterministik 100%.
- **Vonis: P3 tertutup end-to-end; loop P4/P5 ter-wire lewat HTTP, belum production-ready.**
  Detail dan gate: `07-IMPLEMENTASI-P3-P5.md` §8; riwayat temuan/fix:
  `qc/p4-wave2-fixes.md`.

### Yang sudah terverifikasi

- **P0**: multi-subscriber, `outputLog` seq, nodeRegistry, replay remount, close/exit,
  B1 save flush, B3 nodeId validation, hook token bukan argv.
- **P1**: control API `spawn/prompt/wait/close/nodes`, capability `wcap_*` (TTL, sha256-at-rest,
  idempotent `requestId`), transport token per node, hook lewat file `0600`, `cwd` dikurung.
- **P2**: migration runner, schema v1, task state machine + fence + lease + evidence,
  `WEBTERM_LEDGER=off|shadow|on`, reaper, metrics, approval digest/nonce/single-use.
- **P3 approval**: `approvalAuth` menolak loopback tanpa token; `approvalMount` memakai deps
  stabil sehingga replay `requestId` hidup; `InboxPanel` consent `APPROVE`.
- **P4**: memory claim/promote/FTS, proyeksi inbox + `fence`, route baca `/api/inbox`,
  `/api/memory`, `/api/orchestrator/*`; file+git truth (`export`/`rebuild`) di balik flag,
  root `0700` + `git init` otomatis, path per `(project, scope, key)`, rebuild tidak
  me-rollback supersede.
- **P5**: verifikasi webhook HMAC/secret Telegram, dedupe store `0600`, identity/grammar,
  parse/send Telegram, outbox in-memory; binding API + sender outbox ter-wire.
- **Loop**: `bootstrap` → `assign` → `run` lewat HTTP; central portfolio + pause/resume/
  priority. Loop penuh lulus dengan **agen palsu** (worktree, PTY, prompt satu baris,
  SessionEnd, verify, cleanup); Claude nyata belum.

### Yang belum / masih gap

- Task review: transisi verify/fail sudah ada dan kini punya test (consume mem-verify,
  reject mem-fail, stale fence ditolak) di `approvalHumanApi.test.ts`.
- Approved-unconsumed: **tertutup di `31c0886`.** `GET /api/approvals?status=approved`
  membawa `taskId`/`fence`/`request`, dan inbox menampilkan "Finish approval" yang membuka
  consent lama di langkah Consume tanpa mencetak approval baru.
- `/api/approvals/request` sudah idempoten (`requestId` per ledger runtime); error taxonomy
  route manusia tidak lagi kolaps ke satu kode.
- Gate blocking (`requireApproval` -> `consumeApproval`) di jalur run belum ada.
- Verifikasi independen belum menjadi satu-satunya jalur `verified`.
- Telegram: binding dan sender sudah ada, tetapi tidak ada uji jaringan nyata; throttle
  webhook masih di-key alamat proxy (E1), dan group role tidak divalidasi ulang saat load.
- `WEBTERM_CHANNELS` dan mode `off|readonly|control` belum ada di kode.
- Claude nyata, soak P4b 2 project × 2 minggu, dan agen pusat otonom belum.
- Node canvas interactions belum diuji E2E.
- Residual C2 (task `verified` vs item `running` pada plan stale) dan C3 (`plan.status`/
  `project paused` tidak memblokir run).

### QC P3

- `qc/p3-security.md`: H1 loopback token-free (fixed), H2 AckStore (fixed), M1 actor
  separation, M2 memory authority, M3 secret Telegram lemah, M4 verifier env, M5 review
  task tanpa semantik (sebagian fixed).
- `qc/p3-integration.md`: B1 idempotency (fixed), B2 taskId (fixed), B3 requestId manusia
  (fixed), B4 approved-unconsumed (fixed), B5 error taxonomy (fixed), B6 validasi, B7 body cap.
- `qc/p3-tests.md`: mutation survive M4/M8/M12b/M14/M15/M16; `approvalHumanApi` tanpa test
  (sejak `31c0886` sudah ada 20 test modul).
- `qc/p3-e2e-ui.md`: E2E pada `c7c0eda`; workspace kosong, jadi node canvas tidak teruji.

---

## 9. Riwayat

| Commit | Isi |
|---|---|
| `b274834` | RND baseline |
| `b4e7f01` | P0 observation seam |
| `509a61f` | test regresi P0 |
| `b46a06a` / `65c696f` | laporan QC P0 |
| `2c276a0` | fix blocker QC P0 |
| `7effdd2` | hardening test PTY |
| `999a920` | capability-scoped headless API |
| `2872190` | transport token per node + env scrub |
| `30d02a7` | fix blocker QC P1 |
| `8655602` | migration runner + schema v1 |
| `49373c3` | repository project/task/event |
| `83556ad` | fix invariant ledger pasca-QC |
| `b55540a` | runtime flag + reaper sweep |
| `e315c53` | run/usage/budget + reaper tick |
| `476cda4` | backup otomatis sebelum migrasi |
| `9c05bf8` | metrics P2 in-memory |
| `ac34683` | approval digest/nonce/single-use |
| `1b3411e` | line-budget split context-link + control IO |
| `11f1f07` | P3/P4/P5 foundations |
| `9bcf8f5` | wire approval, inbox, memory, orchestrator APIs |
| `c7c0eda` | human approval surface + inbox decisions |
| `31c0886` / `5cd492a` | resume approved-unconsumed + ack approval persisten |
| `984cef2`..`a65d67f` | P3 hardening (backup, files, ack journal) |
| `0f12506` | pecah migrasi ledger + panel inbox |
| `4c5110c` / `d3d4c47` | worker runtime produksi + pecah modul |
| `56eeef1` | memory file + git truth di balik flag |
| `26ac251` / `f04dd5d` | sender Telegram + binding API |
| `f82342e` | central portfolio + kontrol |
| `59b9523` | run/central/memory HTTP |
| `ab2fb6e` | fix memory: scope path, rebuild stale, cold root |
| `2176c98` | fix body cap + cleanup run gagal + test auth |
| `4765230` | bootstrap/assign control plane |
| `0b63714` | fix kontrol: tolak field klien konsisten + agent id ber-`:` |
| `2f04f77` | fix loop: root worktree `0700` + prompt satu baris |
| `98441a4` / `c85d37e` | QC wave 2: acceptance, security, cold root |
