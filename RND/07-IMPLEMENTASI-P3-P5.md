# 07: Implementasi P3/P4/P5: Peta, Gap, Gate

Snapshot awal: 2026-11-01 12:22 (+08:00), branch `feature/agent-pusat-p3`.
Commit terakhir `31c0886` (P3 resume approved-unconsumed); perbaikan P3 sudah commit.
Dokumen ini peta keadaan, bukan klaim selesai. Verifikasi ulang §9 sebelum menyatakan selesai.

Update wave 2: 2026-11-01 15:24 (+08:00), `0f12506`..`2f04f77` (13 commit kode + QC
`98441a4`/`c85d37e`). Semua angka "12:22" di bawah adalah snapshot lama yang sengaja
dipertahankan; angka gate terbaru ada di §1 dan §8.

Update wave 3: 2026-11-01 19:03 (+08:00), `9af9047`..`5d466e7` (10 commit, termasuk commit docs
ini). Menutup C2, C3, residual binding group saat load, cap body settings/workspaces, throttle
proxy, alias nama token bot Telegram, gate plan terminal, dan dua temuan correctness dari
percobaan Claude nyata; plus cek status Telegram hidup (tanpa webhook/pesan). Snapshot wave 1/2
di bawah tidak ditulis ulang.

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

Kegagalan snapshot 12:22 (`memoryCore` redeclare, `channelsRuntime` 2, `channelDispatch` 1)
sudah tidak berlaku di `31c0886`; ulangan di bawah adalah angka yang dipakai.

File `memory/*`, `channels/*` berubah saat snapshot diambil, jadi angka 12:22 bisa berubah;
jangan klaim hijau tanpa suite ulang pada tree yang sama.

Histori: `31c0886` vitest 1526 lulus (111 file); `5cd492a` bun 192 lulus, vitest 1526 lulus
(satu flake `terminalCore` saat paralel, lulus terisolasi).

Gate wave 2 (tree `2f04f77`, 2026-11-01 15:24; termasuk fix kontrol dan loop worker):

| Cek | Hasil |
|---|---|
| `tsc --noEmit` | bersih |
| `vitest run` penuh | 127 file / 1697 test lulus |
| `bun test` penuh | 28 file / 201 test lulus |
| Wave-2 terarah (`auth`, `extendedApi`, `workerRuntime`, `memoryFile`, `memoryFileEnsure`, `orchestratorControlApi`, `orchestratorRunApi`, gate awal) | 7 file / 137 test lulus |

Flake yang diketahui: `terminalCore` dan `paneSplit` bisa gagal di bawah beban paralel dan
lulus saat diisolasi. Jangan klaim deterministik 100%.

Gate wave 3 (HEAD `5d466e7`, 2026-11-01 19:03; fokus C2/C3 + residual P5 + cap body + token
alias + plan terminal + correctness worker):

| Cek | Hasil |
|---|---|
| `tsc --noEmit` (strict + unused) | bersih |
| `vitest run` penuh (`TMPDIR=/tmp`) | 135 file / 1768 test lulus |
| `bun test` penuh | 29 file / 204 test lulus |
| Wave-3 terarah (`orchestratorRun`, `orchestratorRunApi`, `channelStore`, `channelsRuntime`, `webhookPeer`, `settingsApi`, `workspacesApi`) | 7 file / 85 test lulus |
| `ledgerRuntime.bun.test.ts` | 6 test lulus |

Tanpa `TMPDIR=/tmp`, `controlCwd` gagal (lingkungan, lihat §9), bukan regresi kode.

---

## 2. P3: orchestrator dan approval

| File | API / perilaku | Status |
|---|---|---|
| `orchestrator/roles.ts` | `assertCanSpawn`, `assertRoleDepth`, `roleForDepth`, `assertProjectOwnership`, `ownsProject`, `RoleError`; depth maks 2 | `[W]` + test |
| `orchestrator/caps.ts` | `DEFAULT_CAPS`, `checkCaps`, `assertCaps`, `emptyCapSnapshot`, `CapExceededError` | `[W]` + test |
| `orchestrator/planModel.ts` | `validateScope`, `ITEM_TRANSITIONS`, tipe `Plan`/`PlanItem` | `[W]` |
| `orchestrator/plan.ts` | `createPlanStore(db)` → get/create/replace/assign/updateItem, optimistic `version` | `[V]` + test; atomicity C2 ditutup wave 3 (§2a) |
| `orchestrator/worktree.ts` | `createWorktreeService({root,exec})` → allocate/release/get/list; branch + path guard | `[V]` + test; dipakai `workerRuntime` |
| `orchestrator/orchestrator*.ts` | `createOrchestrator` → assignTask/startWorker/recordWorkerResult/canSpawn | `[V]`; spawn PTY produksi di `workerRuntime.ts`; `recordWorkerResult` atomik bila `ledger.tx` ada |
| `orchestrator/workerRuntime.ts` (+`Prompt`/`Session`/`Settle`/`Types`) | run satu task: worktree → PTY → prompt satu baris → settle/timeout → record → cleanup; cap prompt 8 KiB, output 64 KiB; sessionId baru per run agar Claude memakai `--settings`/hooks; `verified` wajib `changedFiles.length > 0` | `[V]` + test; loop fake-agent terverifikasi, Claude nyata **BLOCKED** (§2b) |
| `orchestratorRunApi.ts` | `POST /api/orchestrator/run`, gate `WEBTERM_ORCHESTRATOR_RUN=on`; tolak field client (`repo/cmd/...`), repositori dari `project.path`, root worktree dibuat `0700`, timeout 5 s..15 mnt | `[V]` + test; acceptance loop fake-agent (`2f04f77`); C3 ditutup wave 3: `project.status` `paused` → 409 `project_paused` sebelum repo/plan/worktree; plan `completed`/`abandoned` → 409 `plan_closed` sebelum assignment/worktree |
| `orchestratorControlApi.ts` | `POST /api/orchestrator/bootstrap` (project+orchestrator+worker+plan, path harus root git absolut, item wajib `scope` eksplisit) dan `/assign` (task ledger + kunci item, `expectedVersion`, agent id ber-`:` diterima) | `[V]`: acceptance HTTP bootstrap → duplicate 409 → assign → plan/tasks, tanpa worktree/PTY; B1 (`repo` ditolak) + B2 (agent id eksplisit) fixed di `0b63714` |
| `ledger/ledgerApproval.ts` | request/get/list/decide/consume/expire; digest + nonce + single-use | `[V]` |
| `ledger/durableAck.ts` | `DurableAckStore` + `durableAckFor(db, scope)`; ack di tabel `request_ack`, `INSERT OR IGNORE` (replay tidak memperpanjang expiry), prune expiry + evict tertua | `[V]` + test |
| `control/approvalApi.ts` | `handleApproval`, rute request/decide/consume/list lewat capability | `[W]` 17 test; di-mount |
| `control/approvalMount.ts` | deps memo per ledger port; ack `control` memakai `DurableAckStore` | `[W]` fixed |
| `approvalAuth.ts` | `approvalAuthAllowed`; tolak loopback tanpa token | `[W]` + test |
| `approvalHumanApi.ts` | `/api/approvals/*`: challenge, request, decide, consume, **list approved**; transisi task saat review | `[V]`, 20 test modul |
| `approvalFailures.ts` | `classifyLedgerError`, `boundedText`, `invalid`; error tidak lagi kolaps ke satu kode | `[V]` + test |
| `inbox/inbox.ts` | `buildInbox`, `inboxCounts`; item task membawa `fence` | `[W]` |
| `client/InboxPanel.tsx` | panel inbox + dialog consent `APPROVE`; review task mengirim `taskId`/`fence` | `[V]`; narrow layout beres, baris dipisah ke `inboxItemRow.tsx` |

Alur review task sekarang (commit `31c0886`):

1. UI `beginReview` untuk item task memanggil `/api/approvals/request` dengan `taskId` + `fence`.
2. Reject saat `decide` memanggil `failTask` (dari `claimed_done`) atau `reopenTask`.
3. Consume yang berhasil memanggil `verifyTask` dengan `reviewedBy: 'human'` + `approvalId`.

Ketiga transisi itu sekarang punya test (`approvalHumanApi.test.ts`: verify setelah consume,
reject mem-fail, stale fence ditolak, verify ulang pada task non-`claimed_done` ditolak).

### 2a. Atomicity `recordWorkerResult` (C2)

`recordWorkerResult` (`orchestratorRun.ts`) sekarang membungkus transisi task
(`claimSuccess`/`failTask`), `plan.updateItem`, dan `event.appendEvent` dalam `ledger.tx`
bila port `tx` tersedia. Plan yang basi (`plan_stale`) me-rollback status task, jadi task
tidak lagi bisa tertinggal `verified` sementara item plan tetap `running`. Tanpa `tx`
(fake db/port lama), perilaku lama yang non-atomik tetap berlaku.

Pemulihan approved-unconsumed (B4) punya jalur UI: `GET /api/approvals?status=approved`
memproyeksikan `taskId`/`fence`/`request` dari `request_json`, dan `InboxPanel` menampilkan
**Finish approval** untuk baris task yang punya consent approved-unconsumed yang cocok. Klik
membuka consent yang ada di langkah Consume, tidak pernah mencetak approval kedua; `ready`
menggerbang ulang tombol Review sampai daftar approved selesai dibaca, saat panel dibuka dan
saat ditutup-lalu-dibuka. Terverifikasi nyata (HTTP + ego-browser): Finish approval → Consume →
task `verified`, baris keluar dari inbox, tidak ada approval kedua.

### 2b. Percobaan Claude nyata: BLOCKED (bukan verified)

Percobaan 2026-11-01 lewat `/api/orchestrator/run` dengan Claude Code nyata **gagal sebelum
Claude menjalankan satu turn**:

- Run 1 kena prompt workspace-trust Claude Code lalu keluar.
- Run 2 (trust diterima) melaporkan `Not logged in · Run /login`.

Tidak ada perubahan source/repo, worktree dilepas, server dihentikan. Jadi Claude nyata tetap
**belum terverifikasi**; blocker-nya lingkungan (login CLI + workspace trust), bukan bukti kode
worker benar atau salah.

Dua temuan correctness dari percobaan itu ditutup di `5d466e7`:

- `workerRuntime` mencetak `sessionId` baru per run, sehingga Claude diluncurkan dengan
  `--settings`/hooks dan completion tidak lagi hanya bergantung pada exit PTY.
- `verified` sekarang mewajibkan `changedFiles.length > 0`; diff kosong (mis. keluar di prompt
  trust) menghasilkan `verify_failed: no files changed`, bukan sukses palsu.

Test baru mencakup kedua jalur. Ini menutup false-positive verifikasi, tetapi **tidak** membuktikan
Claude nyata bekerja.

---

## 3. P4: memory dan inbox

| File | API / perilaku | Status |
|---|---|---|
| `memory/memoryWrite.ts` | `claimMemory`, `promoteMemory`, `supersedeMemory`, `quarantineMemory` | `[W]` |
| `memory/memorySearch.ts` | `searchMemory` (FTS5 + bm25), `listMemory`, `memoryEvents` | `[W]` |
| `memory/memoryCore.ts` | `toFtsQuery`, `validateEvidence`, `assertCanPromote` | `[V]`; redeclare `evidence` snapshot sudah hilang |
| `memory/memoryFile.ts` (+`FilePath`/`Render`/`Ensure`) | export fact → Markdown+JSON frontmatter, commit git, rebuild files-win; root `0700` + `git init` otomatis, identitas git milik server | `[V]` + test |
| `memoryFileHttp.ts` (+`Response`) | `POST /api/memory/export`, `POST /api/memory/rebuild`, gate `WEBTERM_MEMORY_FILES=on`; error di-redaksi | `[V]` + test |
| `central/*` | portfolio + project projection, pause/resume/priority (lihat §4b) | `[V]` + test |
| `memoryApi.ts` | `GET /api/memory`, `GET /api/memory/search` (read-only) | `[V]`, ter-mount |
| `inboxApi.ts` | `GET /api/inbox` + counts; pagination + validasi | `[W]`, ter-mount |
| `client/inboxApi.ts` + `InboxPanel` | klien inbox, consent dialog, badge dock | `[W]` |

Gap P4 yang masih terbuka:

- Otoritas tulis file telah dipin ke `{kind:'human', id:'root'}` dan scope `core` ditolak
  (`memoryFileRender`), jadi body tidak bisa mengklaim otoritas. Route claim/promote tetap
  belum ada; authority dari payload masih laten di sana.
- P4b (fact file + git truth) sekarang `[V]` di balik flag, dengan acceptance cold root nyata
  (`qc/p4-memory-fix-acceptance.md`). Soak 2 project × 2 minggu belum dijalankan.
- Central agent otonom tetap `[P]`; yang ada hanya proyeksi portfolio + kontrol (§4b).

---

## 4. P5: channels

| File | API / perilaku | Status |
|---|---|---|
| `channels/webhook.ts` | `verifyWebhook` (HMAC+timestamp), `verifyTelegramSecret`, `signWebhook`, `redactSecrets`, `bodyWithinLimit` | `[W]` + test |
| `channels/identity.ts` | `IdentityRegistry`, `authorizeCommand`, `parseCommand`, `isBareConsent` | `[W]` + test |
| `channels/channelsRuntime.ts` | `POST /webhooks/telegram`; aktif hanya jika `WEBTERM_TELEGRAM=on` + secret + ledger; throttle auth-failure per peer, opt-in `WEBTERM_TRUST_PROXY=on` memakai entri pertama `x-forwarded-for` yang valid | `[V]` + test (throttle proxy) |
| `channels/telegram.ts` | `parseTelegramUpdate`, `sendTelegramMessage`, `telegramBotToken` | `[V]` + test |
| `channels/outbox.ts` | `Outbox` in-memory, backoff, dead-letter | `[V]` + test |
| `channels/channelStore.ts` | binding + dedupe persisten, file `0600`, dir `0700`; `parseStoreState` menurunkan `owner`/`approver` group (`chatId` mulai `-`) ke `operator` saat load, file tidak ditulis ulang sampai save berikutnya | `[V]` + test (load + no-rewrite) |
| `channels/channelBindingsApi.ts` + `Http` | `GET/POST/DELETE /api/channels/telegram/bindings`, root-only; tolak `approver`/`owner` untuk group | `[V]` + test |
| `channels/channelSenderBoot.ts` + `telegramSend.ts` | sender outbox: retry/backoff, dead-letter, redaksi token; boot hanya bila token ada | `[V]` + test; boot dengan token asli terverifikasi (status hidup), delivery belum |

Yang **belum** ada:

- `WEBTERM_CHANNELS` belum dibaca kode mana pun. Flag nyata hanya `WEBTERM_TELEGRAM` dan
  nilainya hanya `on` (tidak ada `off|readonly|control`).
- Binding punya route dan pemanggil produksi; chat yang belum di-bind tetap ditolak.
- Delivery Telegram nyata belum diuji: semua test tetap memakai fetch/update palsu, webhook
  publik belum dipasang, dan tidak ada pesan yang dikirim. Yang sudah diverifikasi hanya
  status hidup boot dengan token asli (lihat di bawah).

Status hidup Telegram (manual, 2026-11-01): token divalidasi lewat `getMe` (read-only; username
bot bukan rahasia), lalu server dijalankan dengan token asli dan wiring boot mencapai
`telegram channel: on` serta egress aktif (tidak ada warning `telegram egress disabled`).
Webhook **tidak** di-`setWebhook` dan tidak ada pesan keluar. Jadi ini bukti konfigurasi boot,
bukan bukti delivery.

Artinya ingress + egress + binding sudah ter-wire, dan residual throttle proxy serta binding
group saat load sudah ditutup; P5 belum boleh disebut production-ready sampai delivery Telegram
nyata (webhook publik + satu pesan) diuji.

---

## 4b. Central thin layer dan loop control plane

Central adalah proyeksi + kontrol, bukan agen otonom:

| Permukaan | Perilaku | Status |
|---|---|---|
| `GET /api/central/portfolio` | daftar project + agregat plan/task/approval/usage, paginasi `limit`/`offset` | `[V]`; acceptance HTTP |
| `GET /api/central/projects/:id` | proyeksi satu project; 404 `project_not_found` | `[V]`; acceptance HTTP |
| `POST .../pause`, `/resume`, `/priority` | ubah status/prioritas, tulis event audit `actorKind:'human'` | `[V]`; acceptance HTTP |
| Gate | `WEBTERM_CENTRAL=on`; tanpa flag → 503 `central_off` | `[V]`; acceptance HTTP |

Loop yang sekarang bisa dilalui lewat HTTP: `bootstrap` → `assign` → `run` → hasil task.
`bootstrap`/`assign` hanya metadata (tanpa cmd/worktree/spawn), otoritas root, dan `run` tetap
menolak field yang dikendalikan klien. Acceptance HTTP: `p4-control-plane-acceptance.md`
(bootstrap → 409 duplikat → assign → plan/tasks, nol worktree/PTY, B1/B2 fixed `0b63714`) dan
`p4-worker-loop-acceptance.md` (fresh data dir: run → worktree → PTY → prompt satu baris →
SessionEnd → verify independen → `verified` → cleanup; **agen palsu, bukan Claude**).
Agen pusat otonom (memilih task sendiri, menjalankan portfolio tanpa manusia) belum dibangun.

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

Sudah ditutup (per `5cd492a`):

- H1: loopback tanpa token tidak lagi bisa request/decide/consume (`approvalAuth.ts`).
- H2/B1: ack approval disimpan di ledger (`request_ack`, migrasi v3), jadi replay `requestId` hidup
  lagi **dan bertahan setelah restart**; `approvalMount` tetap memakai deps stabil per ledger port.
- B2: item task membawa `taskId` + `fence`; review task sekarang punya transisi verify/fail.
- Minimap putih: specificity + custom property React Flow diperbaiki di `styles.css`.
- B4 approved-unconsumed: lihat §2; daftar `approved` manusia + tombol **Finish approval**,
  idempoten (tidak mencetak approval baru) dan terverifikasi HTTP + browser.
- Idempotensi route manusia: `request`/`decide`/`consume` membaca `requestId` lewat ack store
  (`approvalHumanRoutes.ts`). Ack route manusia memakai `DurableAckStore` ber-scope `'human'`
  (`durableAckFor(runtime.db, 'human')`), control plane ber-scope `'control'` (`control/mount.ts`),
  sehingga replay di satu surface tidak bisa mengembalikan respons milik surface lain. Migrasi v3
  membuat `request_ack` + indeks `expires_at`; `INSERT OR IGNORE` berarti replay tidak
  memperpanjang expiry, dan baris kedaluwarsa dipangkas sebelum evict tertua di atas `ACK_LIMIT`.
  Diuji: replay sebelum dan sesudah restart mengembalikan approval id yang sama, key baru, retry
  `decide`, dan isolasi human vs control (`durableAck.bun.test.ts`, `migration.bun.test.ts`).
  Fallback hanya untuk db palsu tanpa `query` (fake db test): ack tetap in-memory `AckStore`.
- Error taxonomy: `approvalFailures.classifyLedgerError` memetakan digest/nonce/expired/
  not-pending/stale-fence/not-found ke kode berbeda; `internal_error` tidak membocorkan pesan.
- Task transition punya test: verify setelah consume, reject mem-fail, stale fence, dan verify
  ulang pada task non-`claimed_done` (`approvalHumanApi.test.ts`).
- InboxPanel: baris yang di-hide optimistis sekarang dibuang setiap daftar server dibaca
  (`setHidden(new Set())`), jadi baris yang masih dilaporkan server kembali tanpa full reload.
- Narrow viewport: `@media (max-width: 640px)` di `inbox.css` memindahkan panel ke kanan dock
  (`left: dock + gap`), `min-width: 0`, dialog selebar panel.
- File budget: `inboxApi.ts` server 66 / klien 200 baris (di batas utility), `InboxPanel.tsx`
  475 setelah baris dipisah ke `inboxItemRow.tsx`.

Masih terbuka:

- Node canvas interactions belum diuji E2E (E2E P3 memakai workspace kosong).
- `DedupeStore` teruji tetapi tidak dipakai produksi.
- Gate blocking (`requireApproval` → `consumeApproval`) di jalur run belum ada; approval masih
  dipakai untuk review task, bukan sebagai prasyarat aksi worker.
- Verifikasi independen belum menjadi satu-satunya jalur `verified`.
- Claude nyata lewat `/api/orchestrator/run` **BLOCKED** (2026-11-01): belum pernah menjalankan
  satu turn. Run 1 keluar di prompt workspace-trust; Run 2 (trust diterima) `Not logged in ·
  Run /login`. Loop penuh hanya lulus dengan agen palsu (PTY, prompt satu baris, SessionEnd,
  verify, cleanup). Lihat §2b.

Sudah ditutup di wave 2:

- `InboxPanel.tsx` 369 baris dan `inboxItemRow.tsx` 63 baris, jadi tidak lagi di atas 80%
  hard cap.
- `ledgerSchema.ts` dipecah (`0f12506`): 20 baris, migrasi v1/v2/v3 masing-masing ≤179 baris.
- Spawn PTY worker produksi ada di `workerRuntime.ts`; PTY ditutup dan worktree dilepas pada
  throw setelah open (`2176c98`). Binding Telegram + sender outbox ter-wire (§4).
- Revalidasi P1 (`fb08982`): cap body control/agent-status dulu diperiksa setelah buffering,
  kini dibaca berbatas saat streaming (64/256 KiB). Test baru memin ackKey per node, deps merge
  stabil, consume digest salah, replay lintas restart, fallback ack; split `orchestrator*Api` 103/38.

Sudah ditutup di wave 3 (`9af9047`..`5d466e7`):

- C2: `recordWorkerResult` memakai `ledger.tx` untuk transisi task + `plan.updateItem` + audit
  event; plan stale me-rollback task. Test rollback sukses dan gagal (`orchestratorRun.test.ts`).
- C3: `POST /api/orchestrator/run` menjawab 409 `project_paused` untuk project `paused`
  sebelum repo/plan/worktree disentuh (`4e0517c`; test `orchestratorRunApi.test.ts`).
- Gate plan terminal: `plan.status` `completed`/`abandoned` menjawab 409 `plan_closed` sebelum
  assignment dan worktree; `draft`/`active` tetap boleh run (`01e33ac`; test `it.each` di
  `orchestratorRunApi.test.ts` untuk kedua status terminal dan kedua status yang lolos).
- Correctness worker dari percobaan Claude nyata: sessionId per run (Claude memakai
  `--settings`/hooks, bukan hanya exit PTY) dan `verified` wajib ada file berubah, diff kosong →
  `verify_failed: no files changed` (`5d466e7`; test `workerRuntime.test.ts`). False-positive
  verifikasi tertutup; Claude nyata tetap BLOCKED.
- Binding group saat load: `parseStoreState` menurunkan `owner`/`approver` group ke `operator`
  di memori; file baru ditulis ulang pada save berikutnya (`887f174`; test load + no-rewrite).
- Cap body: `PATCH /api/settings` 64 KiB, `POST /api/workspaces|active` 1 MiB, ditegakkan saat
  streaming dengan tolak-cepat `Content-Length` (`0061f44`; test `settingsApi`, `workspacesApi`).
  Pembaca `fs`/`git` sengaja tetap tanpa cap karena isi file boleh besar; cap di sana akan
  memutus fitur, bukan menutup celah.
- Throttle proxy: `WEBTERM_TRUST_PROXY=on` membuat bucket auth-failure memakai entri pertama
  `x-forwarded-for` IPv4/IPv6 yang valid; default tetap alamat socket (`d6ff546`; test
  `webhookPeer`, `channelsRuntime`). Didokumentasikan di `.env.example` dengan peringatan
  hanya untuk proxy tepercaya.
- Telegram status hidup (manual): `getMe` read-only + boot token asli mencapai
  `telegram channel: on` dan egress aktif; tanpa webhook/pesan. Bukan bukti delivery.
- Alias token Telegram: egress dan boot menerima `WEBTERM_TELEGRAM_BOT_TOKEN` lebih dulu,
  fallback legacy `TELEGRAM_BOT_TOKEN`, dengan satu resolver bersama sehingga boot dan send
  tidak bisa berbeda pendapat (`8b09ff4`; sesuai README).
- Uji ledger: `ledgerRuntime.bun.test.ts` menyimpan/menghapus `WEBTERM_LEDGER` ambient karena
  Bun auto-load `.env`, lalu memulihkannya di `finally` (`10e2f8e`).

---

## 7. Flag runtime

| Flag | Default | Status |
|---|---|---|
| `WEBTERM_TOKEN` | kosong (loopback token-free) | `[V]`; tidak lagi ditulis di `.env` |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `0` (deny) | `[W]` + test |
| `WEBTERM_LEDGER` | `off` (`off|shadow|on`) | `[V]` |
| `WEBTERM_TELEGRAM` | `off` (`on` saja) | `[V]` boot dengan ledger+secret mencapai `telegram channel: on`; delivery belum |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | kosong | `[W]` |
| `WEBTERM_TELEGRAM_BOT_TOKEN` | kosong; legacy `TELEGRAM_BOT_TOKEN` | `[V]` boot terverifikasi (`getMe` read-only); pengiriman belum |
| `WEBTERM_CHANNELS` | — | `[P]`; belum dibaca kode |
| `WEBTERM_TRUST_PROXY` | `off` | `[V]` + test; `on` memakai hop pertama `x-forwarded-for` untuk throttle webhook |
| `WEBTERM_ORCHESTRATOR_RUN` | `off` (`on` saja) | `[V]`; gate `/api/orchestrator/run|bootstrap|assign` |
| `WEBTERM_MEMORY_FILES` | `off` | `[V]`; gate `/api/memory/export|rebuild` |
| `WEBTERM_MEMORY_DIR` | `<dataDir>/memory`; hanya path absolut | `[V]`; nilai relatif diabaikan |
| `WEBTERM_CENTRAL` | `off` | `[V]`; gate `/api/central/*` |
| `WEBTERM_ALLOW_TOKEN_MINT` | `0` | `[V]` |
| `WEBTERM_STRICT_HOOK_AUTH` | `0` | `[V]` |

Urutan boot yang benar: `WEBTERM_LEDGER=on` dulu (atau `shadow`), lalu `WEBTERM_TELEGRAM=on`
dengan secret. Tanpa ledger, channel tidak dipasang sama sekali. Approval manusia butuh
`WEBTERM_TOKEN` atau opt-in loopback. `WEBTERM_TRUST_PROXY` hanya untuk deployment di belakang
reverse proxy yang menimpa `x-forwarded-for`; jangan aktifkan bila klien bisa mengirim header itu.

---

## 8. Gate

| Gate | Status | Alasan |
|---|---|---|
| G0 typecheck + suite | ✅ | `tsc` strict + unused bersih; vitest 1768 dan bun 204 lulus pada `5d466e7` (`TMPDIR=/tmp`) |
| G1 seam | ✅ | P0 |
| G2 auth/capability | ⚠️ | capability ✅; family root-only kini dipin test; actor binding belum |
| G3 data/migrasi | ⚠️ | v1 ✅; v2 plan ✅; v3 `request_ack` ✅; schema dipecah; migrasi kanal belum (slot v4) |
| G4 orchestrator | ⚠️ | loop penuh + bootstrap/assign + verify ✅ (fake agent); C2/C3 + gate plan terminal + verifikasi wajib ada file berubah ✅; gate blocking approval di jalur run, verifikasi independen satu-satunya jalur, Claude nyata E2E BLOCKED (login/trust) |
| G5 memory/inbox | ⚠️ | repo + route baca + file/git truth (P4b) ✅; route claim/promote, soak 2×2 minggu belum |
| G6 central | ⚠️ | proyeksi + pause/resume/priority ✅; agen pusat otonom belum |
| G7 omnichannel | ⚠️ | ingress + store + binding + sender + throttle proxy + revalidasi group ✅; delivery Telegram nyata (webhook publik + pesan) belum |

**Vonis: jalur P3 (approval + inbox) tertutup end-to-end; loop P4/P5 sekarang ter-wire lewat
HTTP (bootstrap → assign → run, memory files, central portfolio, Telegram bindings/egress),
tetapi belum production-ready.** Yang masih menahan: Claude nyata E2E (BLOCKED pada login CLI +
workspace trust), gate blocking approval di jalur run, verifikasi independen sebagai satu-satunya
jalur `verified`, soak P4b, route claim/promote memory, delivery Telegram nyata (webhook publik),
agen pusat otonom, dan E2E node canvas.
Jangan sebut P3-P5 production-ready sampai itu ditutup.

---

## 9. Verifikasi ulang

```sh
TMPDIR=/tmp/st npx tsc --noEmit
TMPDIR=/tmp/st npx vitest run
TMPDIR=/tmp/st bun test $(git ls-files '*.bun.test.ts')
```

Wave 3 (`5d466e7`): vitest penuh 135 file / 1768 test, bun penuh 29 file / 204 test, `tsc`
strict + unused bersih; semua hijau dengan `TMPDIR=/tmp` (gate §9).
`TMPDIR` di dalam home membuat `controlCwd`
gagal (lingkungan, bukan regresi); run tanpa `TMPDIR=/tmp` juga mengumpulkan jumlah test berbeda
(1 gagal `controlCwd`), jadi selalu pakai `TMPDIR=/tmp` saat membandingkan angka.
Terarah wave 3: 7 file / 85 test (vitest) + `ledgerRuntime.bun.test.ts` 6 test.
