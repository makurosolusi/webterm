# 07: Implementasi P3/P4/P5: Peta, Gap, Gate

Snapshot awal: 2026-11-01 11:32; verifikasi terakhir 11:37 (+08:00). Commit `9933afe`,
branch `feature/agent-pusat-p3`.
Kode P3/P4/P5 sebagian ada sebagai **untracked/uncommitted** dan berubah saat review.
Dokumen ini peta, bukan klaim selesai. Verifikasi ulang §9 sebelum menyatakan selesai.

Label: `[V]` terverifikasi di snapshot · `[W]` ada di working tree, belum commit/ter-wire/gate ·
`[P]` rencana.

---

## 1. Baseline terverifikasi

| Cek | Hasil | Waktu |
|---|---|---|
| `tsc --noEmit` pada commit `9933afe` | bersih | 11:25 |
| `vitest run` pada `9933afe` | 83 file / 1201 test lulus | 11:25 |
| `bun test src/server/ledger` | 12 file lulus | 11:26 |
| `vitest src/server/control/approvalApi.test.ts` `[W]` | 17 test lulus | 11:28 |
| `bun test src/server/memory src/server/inbox` `[W]` | 11 test lulus | 11:31 |
| `vitest src/server/channels` `[W]` | 33 test lulus | 11:30 |
| `tsc --noEmit` working tree 11:34 `[W]` | bersih | 11:34 |
| `vitest run` working tree 11:36 `[W]` | 94 file / 1349 test: 1348 lulus, 1 flake `terminalCore.test.tsx` (0x0 open) | 11:36 |
| `bun test src/server/ledger` `[W]` | 64 test lulus | 11:35 |

P0-P2 `[V]`. P3-P5 `[W]`; working tree 11:34 typecheck bersih, suite WIP punya satu flake
`terminalCore.test.tsx` yang lulus saat diulang. Angka bisa berubah karena sesi lain menulis file.

---

## 2. Yang sudah ada (file + API)

### P3

| File | API | Status |
|---|---|---|
| `orchestrator/roles.ts` | `assertCanSpawn`, `assertRoleDepth`, `roleForDepth`, `assertProjectOwnership`, `ownsProject`, `RoleError` | `[W]` + test |
| `orchestrator/caps.ts` | `DEFAULT_CAPS`, `checkCaps`, `assertCaps`, `emptyCapSnapshot`, `CapExceededError` | `[W]` + test |
| `orchestrator/planModel.ts` | `validateScope`, `ITEM_TRANSITIONS`, `PlanError`, tipe `Plan`/`PlanItem` | `[W]` |
| `orchestrator/plan.ts` | `createPlanStore(db)` → `get/create/replace/assign/updateItem`, optimistik `version` | `[W]`, schema v2 WIP |
| `orchestrator/worktree.ts` | `createWorktreeService({root,exec})` → `allocate/release/get/list`; `branchProblem`, `assertInsideRoot` | `[W]` + test, exec produksi belum |
| `orchestrator/orchestrator.ts` + `orchestratorAssign.ts` + `orchestratorRun.ts` + `orchestratorSupport.ts` | `createOrchestrator(deps)` → `assignTask/startWorker/recordWorkerResult/canSpawn`; `evidenceVerified` | `[W]`, tsc bersih 11:34, test ada |
| `ledger/ledgerApproval.ts` | `requestApproval/getApproval/listApprovals/decideApproval/consumeApproval/expireApprovals/approvalDigest` | `[V]` |
| `control/approvalApi.ts` | `handleApproval`, `APPROVAL_ROUTES` request/decide/consume/list, `ApprovalLedgerPort` | `[W]`, 17 test, **belum di-mount** |
| `control/capabilities.ts` | verb `approval.request/decide/consume/read` | `[W]` modified |
| `ledger/ledgerSchema.ts` | migrasi v2 `plan` + `plan_item` | `[W]` modified |

### P4

| File | API | Status |
|---|---|---|
| `memory/memory.ts` | re-export publik | `[W]` |
| `memory/memoryWrite.ts` | `claimMemory/promoteMemory/supersedeMemory/quarantineMemory` | `[W]` |
| `memory/memorySearch.ts` | `searchMemory` (FTS5+bm25), `listMemory`, `memoryEvents` | `[W]` |
| `memory/memoryCore.ts` | `toFtsQuery` (quote token), `validateEvidence`, `assertCanPromote` | `[W]` |
| `memory/memory.bun.test.ts` | 6 test termasuk injeksi FTS | `[V]` |
| `inbox/inbox.ts` | `buildInbox(db, projectId?, {now,limit,offset})`, `inboxCounts` | `[W]` |
| `inbox/inbox.bun.test.ts` | 5 test, proyeksi read-only | `[V]` |
| `client/inboxApi.ts` | `listInbox/requestApproval/decideApproval/consumeApproval`, `InboxApiError` | `[W]` 343 baris |
| `client/InboxPanel.tsx` + `inboxApprovalDialog.tsx` + `inbox.css` | panel + consent `APPROVE` | `[W]` 500/211, belum mount |

### P5

| File | API | Status |
|---|---|---|
| `channels/webhook.ts` | `verifyWebhook` (HMAC+timestamp), `verifyTelegramSecret`, `signWebhook`, `redactSecrets`, `bodyWithinLimit` | `[W]` 12 test |
| `channels/dedupe.ts` | `DedupeStore.claim/once`, `dedupeKey` | `[W]` |
| `channels/identity.ts` | `IdentityRegistry`, `authorizeCommand`, `parseCommand`, `isBareConsent` | `[W]` |
| `channels/telegram.ts` | `parseTelegramUpdate`, `sendTelegramMessage`, `telegramBotToken` | `[W]` |
| `channels/outbox.ts` | `Outbox.enqueue/due/dispatch/retryDead`, backoff | `[W]` |
| `channels/channels.test.ts` | 21 test | `[V]` |

---

## 3. P3: gap berurutan + acceptance

| # | Gap | Acceptance |
|---|---|---|
| P3-1 **Wire approval (blocker)** | `handleApproval` tidak dipanggil dari `control/mount.ts`/`controlApi.ts`; `handleControlHttp` mengirim `url.pathname` sehingga query `approval/list?projectId=` hilang; `requestRoute` tidak mengembalikan `kind/projectId`; `inboxApi` tidak mengirim `requestId`/`actor` | request 201; decide 200; consume sekali 200, kedua 409; list query benar; replay `requestId` body identik; root token ditolak; klien lulus kontrak |
| P3-2 **Audit approval** | `decideApproval` tidak menulis `decision.choice/decided_by`; tidak ada event `approval.*`; `expireApprovals` tidak dijadwalkan | event append-only actor+digest; decision row terisi; expiry masuk reaper; `list?status=expired` memuat pending kedaluwarsa |
| P3-3 **Route task/plan/agent (blocker)** | Tidak ada route `task.create/lease/claim/verify/cancel/block`, `plan.create/get`, `agent.create`; `/plan` masih 501; `isValidResource` tidak menerima `task:`; belum ada verb `task.*`/`plan.write` | plan→assign→lease→claim→verify via HTTP; depth 3 dan worker-spawn ditolak; cross-project 403; plan stale 409 |
| P3-4 **Spawn worker (blocker)** | `startWorker` hanya worktree+lease+plan `running`; `OrchestratorDeps` tanpa `sessions.open`/PTY | ada PID live; `GET /nodes` memuat worker; close mematikan PTY; double lease satu pemenang; gagal plan tidak meninggalkan PTY yatim |
| P3-5 **Verifikasi independen (blocker)** | `evidenceVerified` percaya payload worker; tidak ada runner server | server jalankan `git diff`, scope check, command allowlist (argv, timeout, output cap, cwd worktree, env bersih); test merah/scope violation tidak `verified` |
| P3-6 **Worktree safety (blocker)** | ownership in-memory; `release --force` tanpa cek dirty; branch tidak dihapus; tanpa orphan sweep; `resolve` bukan `realpath` (symlink); exec produksi belum ada; dua proses bisa branch sama | branch aneh/`..`/kontrol ditolak; symlink keluar root ditolak; dirty tidak dihapus tanpa approval; restart tanpa collision; sweep diaudit |
| P3-7 **Approval gate** | Tidak ada `requireApproval` blocking; action berisiko tidak memanggil `consumeApproval` | tanpa approval 403 `approval_required`; consume sekali; expiry/dua kali 409; urutan `event intent→consume→action→outcome`; crash tidak dobel |
| P3-8 **Flag/metrik** | Tidak ada `WEBTERM_ORCHESTRATOR`, kill switch, metrik cap/gate/verify/orphan | flag off → 404 tanpa spawn; kill switch menutup worker; orphan 0; metrik terlihat |
| P3-9 **Klien** | `InboxPanel` belum di-mount; test tsc merah; file 500 baris (hard limit); `Kanban` hanya status | toggle Dock membuka inbox; consent checkbox+`APPROVE`; digest mismatch terlihat; tanpa token di DOM/log; test fokus lulus |

---

## 4. P4: gap berurutan + acceptance

| # | Gap | Acceptance |
|---|---|---|
| P4-1 **Otoritas memory (blocker)** | `actorKind`/`actor` dari body; worker bisa kirim `human` dan tulis `core` | server turunkan principal dari capability; worker promote/core 403; audit principal asli |
| P4-2 **Route memory** | Belum ada `/api/control/memory/*`; belum ada verb `memory.claim/promote/read` | claim→promote evidence→search `fact`; supersede menjaga history; quarantine terlihat; invalid 400; cross-project 403 |
| P4-3 **Route inbox + kontrak** | Server `category`/`evidenceSummary`/`projectId:null`; klien `state`/`detail`/string wajib → semua baris dibuang; belum ada `GET /api/inbox` | pilih satu kontrak; item lintas project tampil; null tidak membuang baris; pagination; render tanpa aksi; redaksi payload |
| P4-4 **FTS maintenance** | `toFtsQuery` aman + test; belum ada rebuild/uji supersede/perf | rebuild idempoten; `"`/`NEAR(`/`*` tidak error; bm25 stabil; hanya `fact` non-superseded |
| P4-5 **P4b** | File+git truth/CORE ditunda | Gate 2 project × 2 minggu; tanpa dual-write; `[P]` |

---

## 5. P5: gap berurutan + acceptance

| # | Gap | Acceptance |
|---|---|---|
| P5-1 **Migrasi kanal v3** | v2 dipakai plan; tabel kanal belum ada (`channel_account/identity/conversation/message/outbox/presence/policy`) | v1→v2→v3 idempoten; rollback aman; replay 100x satu row; channel down tidak blokir ledger |
| P5-2 **Secret kanal (blocker)** | `telegramBotToken` baca env; desain minta file 0600/Keychain; `TELEGRAM_BOT_TOKEN` tidak di-scrub `ptyShell` | env anak/`ps -E` tanpa token; log `[redacted]`; rotasi tanpa restart; file 0600 |
| P5-3 **Ingress** | Belum ada `channelsApi.ts`/`POST /api/channels/:id/webhook`; cap body harus sebelum `readBody` | >64 KiB → 413 sebelum parse; signature salah 401; 200 hanya setelah insert unik durable |
| P5-4 **Identitas** | `IdentityRegistry` in-memory; binding per-chat, `userId` opsional; group `pause/resume` lolos | identitas persisten; link code hash/TTL/single-use; group read-only; unknown silent; unlink cabut capability |
| P5-5 **Approval bridge** | `callback_query` diabaikan; belum ada inline keyboard/MAC; `callback_data` maks 64 byte | `v1.<id>.<exp>.<mac>`; tamper/expired/replay ditolak; group/unknown tidak approve; "yes" bukan consent |
| P5-6 **Outbox durable** | `Outbox` in-memory; tanpa insert transaksional, lease dispatcher, 429/dead-letter, provider id | provider 500 1 jam → pending, ledger aman, recovery sekali; 429 `retry_after`; crash tidak gandakan |
| P5-7 **Telegram+flag** | Belum `setWebhook`/`editMessageText`/topic/4096/`setMyCommands`; belum `WEBTERM_CHANNELS`, `WEBTERM_TELEGRAM` | replay 100x; cross-project ditolak; approval blocking; token tidak di env/log; metrik O22 |

---

## 6. Risiko tersembunyi produksi

| # | Risiko | Bukti | Dampak |
|---|---|---|---|
| R1 | Approval tidak ter-wire | `control/mount.ts` tanpa `handleApproval` | fitur mati |
| R2 | Kontrak klien approval | `inboxApi` tanpa `requestId`; `toChallenge` butuh `kind/projectId` | approve 400/502 |
| R3 | Query list hilang | mount kirim `pathname`; `approvalApi` baca `?` dari path | list 400 |
| R4 | Audit decision kosong | `decideApproval` tidak tulis `decision.choice`; tanpa event | G4 gagal |
| R5 | Self-approval | `approval.request` + `decide` bisa satu principal | consent tidak independen |
| R6 | Worker tak pernah spawn | `OrchestratorDeps` tanpa `sessions`/PTY | "running" palsu |
| R7 | Verifikasi palsu | `evidenceVerified` percaya payload worker | false-success |
| R8 | Worktree tidak aman | in-memory, `--force`, tanpa dirty/sweep, `resolve` bukan `realpath` | kerja hilang/escape |
| R9 | `plan` butuh v2 | `plan.ts` query tabel v2; migrasi v2 WIP | crash di DB v1 |
| R10 | `wait:exit` residual | tombstone output sudah ada; `idle`=dua snapshot kosong; `status:done` butuh hook | idle palsu/timeout |
| R11 | FTS | `toFtsQuery` aman+test; rebuild/perf belum | regresi query |
| R12 | Shape inbox | server `category`/null vs klien `state`/string | semua item dibuang |
| R13 | Authority memory | `actorKind` dari body | worker tulis `core` |
| R14 | Identitas kanal | in-memory, per-chat, group mutasi | bypass/restart |
| R15 | Secret kanal | env; legacy token tidak di-scrub PTY | bocor |
| R16 | Body webhook | cek setelah body; `readBody` tanpa cap | memory blow-up |
| R17 | Mint loopback | butuh `WEBTERM_TOKEN`+flag | control API mati di default |
| R18 | Budget | `checkBudget` tanpa caller; cap dari `input.usage` | biaya liar |
| R19 | File health | `sessions.ts` 338; `InboxPanel` 500; `inboxApi` 343; `approvalApi` 299 | jangan tambah |
| R20 | Reaper approval | `expireApprovals` tak dijadwalkan | row menggantung |
| R21 | `verifyTask` longgar | ledger terima evidence `null` | route wajib tolak |
| R22 | Flake gate | `terminalCore.test.tsx` 0x0 open gagal saat load tinggi; ulang lulus | gate goyah |

Sudah diperbaiki/terverifikasi, jangan diklaim gap: `wait:exit` tombstone output
(`sessions.getTerminal` fallback), capability gate transport, `cwd` realpath, ghost close,
mint session id, `maxAttempts`/`claimDone` lease guard, FK pragma.

---

## 7. Integrasi & kepemilikan

Shared single-owner (jangan disentuh worker lain): `src/server/index.ts` (satu blok wiring),
`api.ts` (satu baris/family), `control/mount.ts` (satu dispatch), `control/controlApi.ts` (satu
baris dispatch), `ledger/ledgerSchema.ts` (migrasi append-only v3), `client/App.tsx`+`Dock.tsx`
(mount inbox satu PR), `CHANGELOG.md`+`RND/*`.

| Lane | File |
|---|---|
| P3 approval | `control/approvalApi.ts`, `ledgerApproval.ts`, `capabilities.ts` |
| P3 task/plan | `control/taskApi.ts`, `control/planApi.ts` (baru), `orchestrator/plan*.ts` |
| P3 spawn/verify | `orchestrator/orchestratorRun.ts`, `worktree.ts`, `verify.ts`, `approvalGate.ts` (baru) |
| P4 memory | `memory/*`, `control/memoryApi.ts` (baru) |
| P4 inbox | `inbox/*`, `client/inboxApi.ts`, `InboxPanel*` |
| P5 channels | `channels/*`, `channelsApi.ts` (baru), migrasi v3 |

**Blocker koordinasi:** WIP P3-P5 untracked di tree yang sama dan sedang diedit sesi lain.
Commit/stash per lane atau pindah ke worktree terpisah sebelum worker paralel; jika tidak,
worker saling menimpa dan test saling merusak.

---

## 8. Urutan eksekusi

1. Bekukan WIP: commit per lane setelah tsc hijau.
2. P3-1..P3-3 wire approval + route task/plan/agent.
3. P3-4..P3-6 spawn + verifikasi independen + worktree safety (G4).
4. P3-7..P3-9 gate blocking, flag, klien.
5. P4-1..P4-3 authority, route memory, route/kontrak inbox (G5).
6. P5-1..P5-7 migrasi v3, secret, ingress, identitas, bridge, outbox (G7).
7. P4b/central setelah 2 project × 2 minggu.

---

## 9. Stop/go gate

| Gate | Status | Alasan |
|---|---|---|
| G0 build commit bersih | ✅ | `9933afe`: tsc, 1201 vitest, ledger bun |
| G0b build working tree | ⚠️ | tsc bersih 11:34; 1 flake `terminalCore` 0x0, ulang lulus |
| G1 seam | ✅ | P0 |
| G2 auth/capability | ⚠️ | gate capability ✅; mint loopback ❌; actor binding ❌ |
| G3 data/migrasi | ⚠️ | v1 ✅; v2 WIP; v3 ❌; backup ✅ |
| G4 orkestrator | ❌ | spawn, verifikasi independen, route, gate blocking belum |
| G5 memory/inbox | ❌ | repo+test ✅; route/authority/kontrak ❌ |
| G6 central | N/A | ditunda |
| G7 omnichannel | ❌ | tabel/route/outbox/secret/identity belum |

**Vonis: belum production-ready.** Hijaukan G0b + P3-1/3/4/5/6/7 sebelum demo P3; G7 + v3 +
secret file + identitas persisten sebelum P5.

---

## 10. Keputusan menunggu user

1. Mint loopback: CLI lokal vs route `/token` loopback? Tanpa ini control API mati di default.
2. Pemisahan approver: requester boleh `approval.decide`? Rekomendasi tidak.
3. Kontrak inbox: ubah server (`state`/`detail`) atau klien (`category`/null)? Rekomendasi
   adapter server.
4. Secret kanal: file 0600 vs Keychain; env hanya dev? Rekomendasi file 0600, env ditolak prod.
5. Worktree dirty: `--force` atau pertahankan+approval? Rekomendasi pertahankan.
6. Verifier allowlist: command apa dan siapa yang boleh mengubah?
7. Group chat: read-only total atau `operator`? Rekomendasi read-only total.

---

## 11. `.env` dan secret

- `.env` snapshot mode `600`; `WEBTERM_TOKEN` **dikomentari** (65 char), `HOST`/`PORT` aktif.
  Bun memuat `.env` otomatis. Tanpa token loopback token-free; mint butuh token + flag.
- `.gitignore` menutup `.env`, `.env.*` (kecuali `.env.example`). Tidak ada nilai token di
  dokumen/log/test/commit. Log server hanya `len=N`.
- `TELEGRAM_BOT_TOKEN` legacy harus di-scrub `ptyShell` atau dilarang; token kanal di file
  0600/Keychain, bukan env global.

---

## 12. Verifikasi

```sh
TMPDIR=/tmp/st npx tsc --noEmit
TMPDIR=/tmp/st npx vitest run
TMPDIR=/tmp/st bun test src/server/*.bun.test.ts
TMPDIR=/tmp/st bun test src/server/memory src/server/inbox
TMPDIR=/tmp/st npx vitest run src/server/control/approvalApi.test.ts src/server/channels
```

Lulus hanya bila semua hijau pada tree yang sama dan tidak ada file untracked ikut teruji tanpa
di-commit.
