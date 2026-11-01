# 07: Implementasi P3/P4/P5: Peta, Gap, Gate

Snapshot: 2026-11-01 12:22 (+08:00), branch `feature/agent-pusat-p3`.
Commit terakhir `c7c0eda`; sebagian perbaikan P3 masih **uncommitted** di working tree.
Dokumen ini peta keadaan, bukan klaim selesai. Verifikasi ulang §9 sebelum menyatakan selesai.

Label: `[V]` terverifikasi di snapshot · `[W]` ada di working tree, belum commit atau belum
teruji end-to-end · `[P]` rencana saja, belum ada di kode.

---

## 1. Baseline snapshot

| Cek | Hasil | Waktu |
|---|---|---|
| `tsc --noEmit` working tree | bersih | 12:21 |
| `vitest` terarah (approvalAuth, inboxApi, approvalMount, InboxPanel, inboxApi client) | 5 file / 46 test lulus | 12:21 |
| `vitest run` penuh | 104 file lulus, 2 gagal; 1442/1445 test lulus | 12:21 |
| `bun test` orchestrator+inbox+memory+channels+ledger | 30 file, 255/258 test lulus | 12:21 |

Kegagalan snapshot, jangan disembunyikan:

- `memoryApi.test.ts` gagal transform: `memoryCore.ts:139` mendeklarasikan `evidence` dua kali.
- `channelsRuntime.test.ts` 2 gagal (store korup tidak terdeteksi; route tidak terpasang).
- `channelDispatch.test.ts` 1 gagal (claim tidak dilepas saat reply gagal di-enqueue).

File `src/server/memory/*`, `channels/*` berubah **saat** snapshot ini diambil (sesi lain),
jadi angka di atas bisa berubah. Jangan klaim hijau sampai suite dijalankan ulang pada tree
yang sama dan tidak ada perubahan bersamaan.

---

## 2. P3: orchestrator dan approval

| File | API / perilaku | Status |
|---|---|---|
| `orchestrator/roles.ts` | `assertCanSpawn`, `assertRoleDepth`, `roleForDepth`, `assertProjectOwnership`, `ownsProject`, `RoleError`; depth maks 2 | `[W]` + test |
| `orchestrator/caps.ts` | `DEFAULT_CAPS`, `checkCaps`, `assertCaps`, `emptyCapSnapshot`, `CapExceededError` | `[W]` + test |
| `orchestrator/planModel.ts` | `validateScope`, `ITEM_TRANSITIONS`, tipe `Plan`/`PlanItem` | `[W]` |
| `orchestrator/plan.ts` | `createPlanStore(db)` → get/create/replace/assign/updateItem, optimistic `version` | `[W]` |
| `orchestrator/worktree.ts` | `createWorktreeService({root,exec})` → allocate/release/get/list; branch + path guard | `[W]` + test; exec produksi belum |
| `orchestrator/orchestrator*.ts` | `createOrchestrator` → assignTask/startWorker/recordWorkerResult/canSpawn | `[W]`; spawn PTY produksi belum |
| `ledger/ledgerApproval.ts` | request/get/list/decide/consume/expire; digest + nonce + single-use | `[V]` |
| `control/approvalApi.ts` | `handleApproval`, rute request/decide/consume/list lewat capability | `[W]` 17 test; di-mount |
| `control/approvalMount.ts` | deps memo per ledger port supaya AckStore replay 10 menit hidup | `[W]` fixed |
| `approvalAuth.ts` | `approvalAuthAllowed`; tolak loopback tanpa token | `[W]` + test |
| `approvalHumanApi.ts` | `/api/approvals/*`: challenge, request, decide, consume; transisi task saat review | `[W]`, belum ada test modul |
| `inbox/inbox.ts` | `buildInbox`, `inboxCounts`; item task membawa `fence` | `[W]` |
| `client/InboxPanel.tsx` | panel inbox + dialog consent `APPROVE`; review task mengirim `taskId`/`fence` | `[W]`; minimap/narrow layout belum beres |

Alur review task sekarang (uncommitted):

1. UI `beginReview` untuk item task memanggil `/api/approvals/request` dengan `taskId` + `fence`.
2. Reject saat `decide` memanggil `failTask` (dari `claimed_done`) atau `reopenTask`.
3. Consume yang berhasil memanggil `verifyTask` dengan `reviewedBy: 'human'` + `approvalId`.

Itu menutup temuan QC "consume tidak mengubah task", tetapi belum ada test yang mengunci
transisinya. Bukti lama (E2E `p3-e2e-ui.md` B1) tetap berlaku untuk commit `c7c0eda`.

---

## 3. P4: memory dan inbox

| File | API / perilaku | Status |
|---|---|---|
| `memory/memoryWrite.ts` | `claimMemory`, `promoteMemory`, `supersedeMemory`, `quarantineMemory` | `[W]` |
| `memory/memorySearch.ts` | `searchMemory` (FTS5 + bm25), `listMemory`, `memoryEvents` | `[W]` |
| `memory/memoryCore.ts` | `toFtsQuery`, `validateEvidence`, `assertCanPromote` | `[W]`; snapshot gagal parse |
| `memoryApi.ts` | `GET /api/memory`, `GET /api/memory/search` (read-only) | `[W]`, ter-mount |
| `inboxApi.ts` | `GET /api/inbox` + counts; pagination + validasi | `[W]`, ter-mount |
| `client/inboxApi.ts` + `InboxPanel` | klien inbox, consent dialog, badge dock | `[W]` |

Gap P4 yang masih terbuka:

- Otoritas memory masih dari payload (`actorKind`), bukan principal server. Belum ada route
  tulis, jadi ini laten sampai route claim/promote ditambahkan.
- P4b (fact file + git truth, CORE human-only) tetap `[P]`, digate 2 project × 2 minggu.
- Central agent tetap `[P]`, belum ada kode.

---

## 4. P5: channels

| File | API / perilaku | Status |
|---|---|---|
| `channels/webhook.ts` | `verifyWebhook` (HMAC+timestamp), `verifyTelegramSecret`, `signWebhook`, `redactSecrets`, `bodyWithinLimit` | `[W]` + test |
| `channels/identity.ts` | `IdentityRegistry`, `authorizeCommand`, `parseCommand`, `isBareConsent` | `[W]` + test |
| `channels/channelsRuntime.ts` | `POST /webhooks/telegram`; aktif hanya jika `WEBTERM_TELEGRAM=on` + secret + ledger | `[W]` |
| `channels/telegram.ts` | `parseTelegramUpdate`, `sendTelegramMessage`, `telegramBotToken` | `[W]` + test |
| `channels/outbox.ts` | `Outbox` in-memory, backoff, dead-letter | `[W]` |
| `channels/channelStore.ts` | binding + dedupe persisten, file `0600`, dir `0700` | `[W]` + test |

Yang **belum** ada:

- `WEBTERM_CHANNELS` belum dibaca kode mana pun. Flag nyata hanya `WEBTERM_TELEGRAM` dan
  nilainya hanya `on` (tidak ada `off|readonly|control`).
- `ChannelStore.bind` belum punya pemanggil produksi; chat nyata selalu unbound.
- Outbox belum punya pengirim; balasan tidak pernah terkirim.
- Tidak ada uji jaringan Telegram nyata (semua test memakai fetch/update palsu).

Artinya P5 masih ingress yang tertutup dan belum bisa dipakai sebagai control plane.

---

## 5. Security decision: approval manusia

Keputusan yang berlaku:

- Route manusia `/api/approvals/*` **tidak** capability-gated. Otorisasinya transport token
  (root) atau opt-in loopback eksplisit.
- Default menolak: tanpa `WEBTERM_TOKEN`, route menjawab `403 approval_requires_token`.
- `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` adalah satu-satunya pengecualian, untuk demo lokal
  sekali pakai. Ini bukan mode produksi.
- Node token (`wcap_*` / token per node) tidak membuka route manusia. Agen tidak boleh
  menyetujui aksinya sendiri, sekalipun ia bisa curl loopback.
- Control plane `/api/control/approval/*` tetap capability-gated dan tidak membaca
  `x-webterm-token` sebagai otoritas.

Konsekuensi operasional: approval manusia butuh root token **dan** UI yang membawa token itu,
atau flag opt-in di mesin lokal. `.env` tidak lagi menyimpan `WEBTERM_TOKEN`; Bun tetap
auto-load `.env`, jadi token hanya masuk bila operator mengekspornya secara eksplisit.

---

## 6. Gap dari QC P3

Sumber: `RND/qc/p3-security.md`, `p3-integration.md`, `p3-tests.md`, `p3-e2e-ui.md`.

Sudah ditutup di working tree:

- H1: loopback tanpa token tidak lagi bisa request/decide/consume (`approvalAuth.ts`).
- H2/B1: AckStore memakai deps stabil, replay `requestId` hidup lagi.
- B2: item task membawa `taskId` + `fence`; review task sekarang punya transisi verify/fail.
- Minimap putih: specificity + custom property React Flow diperbaiki di `styles.css`.

Masih terbuka:

- Approved-unconsumed: approval `approved` hilang dari inbox (hanya `pending`), tidak ada route
  list manusia; decide yang sukses tapi responsnya hilang tidak bisa dilanjutkan.
- Idempotensi route manusia: `/api/approvals/request` belum membaca `requestId`, jadi dua
  request identik tetap membuat dua approval.
- Error taxonomy route manusia masih kolaps ke `approval_decision_failed`.
- Task transition belum punya test; `InboxPanel` masih menyembunyikan baris secara lokal.
- Node canvas interactions belum diuji E2E (E2E P3 memakai workspace kosong).
- Narrow viewport masih memotong panel inbox.
- `DedupeStore` teruji tetapi tidak dipakai produksi.
- File budget: `ledgerSchema.ts` > 200, `inboxApi.ts`/`InboxPanel.tsx` mendekati hard cap.

---

## 7. Flag runtime

| Flag | Default | Status |
|---|---|---|
| `WEBTERM_TOKEN` | kosong (loopback token-free) | `[V]`; tidak lagi ditulis di `.env` |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `0` (deny) | `[W]` + test |
| `WEBTERM_LEDGER` | `off` (`off|shadow|on`) | `[V]` |
| `WEBTERM_TELEGRAM` | `off` (`on` saja) | `[W]` |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | kosong | `[W]` |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | kosong; legacy `TELEGRAM_BOT_TOKEN` | `[W]` |
| `WEBTERM_CHANNELS` | — | `[P]`; belum dibaca kode |
| `WEBTERM_ALLOW_TOKEN_MINT` | `0` | `[V]` |
| `WEBTERM_STRICT_HOOK_AUTH` | `0` | `[V]` |

Urutan boot yang benar: `WEBTERM_LEDGER=on` dulu (atau `shadow`), lalu `WEBTERM_TELEGRAM=on`
dengan secret. Tanpa ledger, channel tidak dipasang sama sekali. Approval manusia butuh
`WEBTERM_TOKEN` atau opt-in loopback.

---

## 8. Gate

| Gate | Status | Alasan |
|---|---|---|
| G0 typecheck | ✅ | tsc bersih 12:21 |
| G0b suite penuh | ⚠️ | 3 test + 1 suite gagal di snapshot; file berubah bersamaan |
| G1 seam | ✅ | P0 |
| G2 auth/capability | ⚠️ | capability ✅; approval manusia fixed; actor binding belum |
| G3 data/migrasi | ⚠️ | v1 ✅; v2 plan WIP; v3 kanal belum |
| G4 orchestrator | ⚠️ | plan/worktree/verify ada; spawn PTY produksi + gate blocking belum |
| G5 memory/inbox | ⚠️ | repo + route baca ✅; authority + P4b belum |
| G6 central | N/A | ditunda |
| G7 omnichannel | ⚠️ | ingress + store ✅; binding, sender, v3, live test belum |

**Vonis: belum production-ready.** Jangan sebut P3-P5 selesai sebelum G0b hijau, test transisi
task ditambahkan, dan approved-unconsumed punya jalur pulih.

---

## 9. Verifikasi ulang

```sh
TMPDIR=/tmp/st npx tsc --noEmit
TMPDIR=/tmp/st npx vitest run
TMPDIR=/tmp/st bun test src/server/orchestrator src/server/inbox \
  src/server/memory src/server/channels src/server/ledger
```

Hijau hanya bila semua lulus pada tree yang sama, tanpa file berubah di tengah run.
