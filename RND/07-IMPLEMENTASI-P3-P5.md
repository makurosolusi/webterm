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

Update wave 4: 2026-11-01 20:39 (+08:00), HEAD `6a5fa55`, commit kode `e52e767`..`6a5fa55`
(3 commit: `e52e767` route claim/promote memory, `db20f7b` master switch `WEBTERM_CHANNELS`,
`6a5fa55` gate approval opt-in di jalur run). Wave 4 menutup route tulis memory, kill switch
kanal, dan prasyarat approval untuk run. **Tidak** menutup verifikasi independen sebagai
satu-satunya jalur `verified`, agen pusat otonom, actor binding di auth/capability, soak,
delivery Telegram, atau E2E Claude nyata/node canvas.

Update wave 5: 2026-11-01 21:13 (+08:00), HEAD `51dab65`, commit `9e7416d`..`51dab65`
(provenance verifikasi server, actor binding dari transport, scheduler otonom pusat, harness soak).
Wave 5 menutup klaim verifikasi otomatis worker, derivasi aktor approval manusia, dan loop otonom
opt-in. **Tidak** membuktikan soak 2 project × 2 minggu wall-clock, delivery Telegram, atau E2E
Claude/node canvas; identitas aktor tetap root/loopback, bukan per-user.

Update wave 6: 2026-11-01 21:36 (+08:00), HEAD `5214ea2`, commit `c8e799f`..`5214ea2` (fix
deteksi perubahan ter-commit + laporan acceptance). Acceptance HTTP nyata 17/17 PASS dengan agen
PTY palsu di port 8830/8831 (`RND/qc/wave5-public-acceptance.md`) — **bukan** Claude nyata.

Label: `[V]` terverifikasi di snapshot · `[W]` ada di working tree, belum commit atau belum
teruji end-to-end · `[P]` rencana saja, belum ada di kode.

---

## 1. Baseline snapshot

Snapshot 12:21 (dipertahankan sebagai sejarah): `tsc` bersih; vitest terarah 5 file / 46 test;
vitest penuh 104 file lulus + 2 gagal, 1442/1445 test; bun 30 file, 255/258 test. Kegagalan
`memoryCore`/`channelsRuntime`/`channelDispatch` sudah tidak berlaku di `31c0886`. Histori:
`31c0886` vitest 1526 lulus (111 file); `5cd492a` bun 192, vitest 1526 (flake `terminalCore`).
File `memory/*`/`channels/*` berubah saat snapshot, jadi angka 12:22 tidak boleh diklaim hijau
tanpa suite ulang.

Gate per wave (HEAD masing-masing): wave 2 `2f04f77` tsc bersih, vitest 127/1697, bun 28/201,
terarah 7/137; wave 3 `5d466e7` vitest 135/1768, bun 29/204, terarah 7/85 + ledger 6; wave 4
`6a5fa55` vitest 137/1808, bun 29/204, terarah 4/64.
Flake yang diketahui: `terminalCore` dan `paneSplit` bisa gagal di bawah beban paralel dan
lulus saat diisolasi. Jangan klaim deterministik 100%. Tanpa `TMPDIR=/tmp`, `controlCwd` gagal
(lingkungan, lihat §9), bukan regresi kode.

Gate wave 5-6 (HEAD `5214ea2`, 2026-11-01 21:36; suite di `51dab65`+, acceptance di `c8e799f`):

| Cek | Hasil |
|---|---|
| `tsc --noEmit` (strict + unused) | bersih |
| `vitest run` penuh (`TMPDIR=/tmp`) | 138 file / 1835 test lulus |
| `bun test` penuh | 29 file / 204 test lulus |
| Wave-5 terarah (verifier, orchestratorRun, approvalHumanApi, centralAutonomy) | 4 file / 65 test lulus |
| Acceptance HTTP publik (agen PTY palsu, port 8830/8831) | 17/17 PASS (`RND/qc/wave5-public-acceptance.md`) |
| `bun scripts/soakCentralAutonomy.ts --cycles 10000 --fail-every 17 --pause-every 500` | exit 0, PASS (`RND/qc/soak-harness.md`) |

Angka wave 5-6 adalah gate terbaru. Wave 5 menutup provenance, actor binding, otonomi, soak.

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
| `orchestratorRunApi.ts` | `POST /api/orchestrator/run`, gate `WEBTERM_ORCHESTRATOR_RUN=on`; tolak field client (`repo/cmd/...`), repositori dari `project.path`, root worktree dibuat `0700`, timeout 5 s..15 mnt | `[V]` + test; acceptance loop fake-agent (`2f04f77`); C3 ditutup wave 3: `project.status` `paused` → 409 `project_paused` sebelum repo/plan/worktree; plan `completed`/`abandoned` → 409 `plan_closed` sebelum assignment/worktree. Wave 4: body menerima pasangan opsional `approvalId` + `approvalDigest`; `guardedRun` dipanggil setelah semua pemeriksaan body/project/plan dan membungkus worktree/PTY (§2c) |
| `orchestratorRunModel.ts` | parsing `RawRun` termasuk `approvalId` + `approvalDigest` (wajib berpasangan; digest 64 hex huruf kecil), `orchestratorRunRequireApproval` untuk `WEBTERM_RUN_REQUIRE_APPROVAL` | `[V]` + test (pasangan valid, separuh pasangan ditolak 400 `invalid_approval`) |
| `orchestrator/approvalGate.ts` | `runApproved`, `ApprovalRequiredError`; consent `approved` di-consume tepat sekali, digest mengikat aksi | `[V]` + test; sebelumnya hanya library, wave 4 mulai dipakai jalur run (§2c) |
| `orchestratorControlApi.ts` | `POST /api/orchestrator/bootstrap` (project+orchestrator+worker+plan, path harus root git absolut, item wajib `scope` eksplisit) dan `/assign` (task ledger + kunci item, `expectedVersion`, agent id ber-`:` diterima) | `[V]`: acceptance HTTP bootstrap → duplicate 409 → assign → plan/tasks, tanpa worktree/PTY; B1 (`repo` ditolak) + B2 (agent id eksplisit) fixed di `0b63714` |
| `ledger/ledgerApproval.ts` + `durableAck.ts` | request/get/list/decide/consume/expire, digest + nonce + single-use; `DurableAckStore` di `request_ack` (`INSERT OR IGNORE`), prune expiry + evict tertua | `[V]` + test |
| `control/approvalApi.ts` + `Mount.ts` + `approvalAuth.ts` | `handleApproval` rute request/decide/consume/list lewat capability; ack `control` memakai `DurableAckStore`; `approvalAuthAllowed` menolak loopback tanpa token | `[W]` + 17 test; di-mount, deps memo per ledger port |
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

### 2c. Gate approval di jalur run (opt-in, bukan default)

`6a5fa55` memasang prasyarat approval pada `POST /api/orchestrator/run`. Ini **kebijakan opt-in**,
bukan gate default untuk setiap run:

| Kondisi | Perilaku |
|---|---|
| `WEBTERM_RUN_REQUIRE_APPROVAL=on` dan body tanpa `approvalId`/`approvalDigest` | 409 `approval_required` sebelum worktree/PTY |
| Field dikirim (flag apa pun, termasuk off) | `runApproved` meng-consume approval **tepat sekali** sebelum worktree/PTY |
| Flag off dan field tidak dikirim | perilaku lama, tanpa approval |
| Field hanya separuh (id tanpa digest, atau sebaliknya) | 400 `invalid_approval` dari parsing body; digest bukan 64 hex huruf kecil → 400 `invalid_approval_digest` |
| Approval tidak ada / belum `approved` / expired / digest beda / sudah dipakai | 409 `approval_rejected` dengan `code` dari `ApprovalRejectionCode` (`approval_not_found`, `approval_pending`, `approval_not_approved`, `approval_expired`, `approval_digest_mismatch`, `approval_already_consumed`) |

Urutan yang dijaga (dan diuji): parsing body → cek project (`paused`) → cek plan terminal →
assignment item → `guardedRun` → resolve worktree → runtime/PTY. Karena gate dipanggil setelah
semua penolakan murah, request tidak valid tidak pernah membakar approval; dan karena gate
membungkus `startRun`, approval yang ditolak tidak meninggalkan root dir, git exec, atau PTY.
Kalau aksi gagal setelah consume, approval tetap terbakar (by design, tidak dihidupkan ulang).

Batas: route ini root/loopback, dan approval yang di-consume adalah approval ledger buatan
manusia lewat `/api/approvals/*`. Gate menutup "worker jalan tanpa consent", **bukan** "worker
memverifikasi hasilnya sendiri"; klaim otomatis worker ditutup provenance (§2d), dengan jalur
approval manusia tetap sebagai pengecualian.

### 2d. Provenance verifikasi: klaim worker tidak lagi cukup

`9e7416d` menutup celah "worker mengarang evidence hijau":

| Lapisan | Perilaku |
|---|---|
| `orchestratorModel.ts` | `VerificationEvidence.verifiedBy` wajib bernilai `SERVER_VERIFIED_BY = 'server-verifier'`; `evidenceVerified` menolak evidence tanpa marker itu |
| `verify.ts` | setiap outcome `verifyWorktree` diberi `verifiedBy: 'server-verifier'` oleh `verdict()`, bukan oleh input |
| `verifier.ts` | `toModelEvidence(outcome)` melempar bila outcome bukan buatan `verifyWorktree`; hanya fungsi ini yang boleh membentuk evidence model |
| `orchestratorRun.claimSuccess` | evidence tanpa marker berhenti di `claimed_done`, meski angka test hijau |

Batas yang tetap ada:

- Consume approval manusia memanggil `verifyTask(..., null, {actor})` langsung, jadi `verified`
  masih punya jalur approval manusia (disengaja: manusia memutuskan, bukan worker). "Satu-satunya
  jalur `verified`" karena itu tidak benar secara absolut.
- Pemanggil ledger in-process tepercaya (kode server, test) tetap bisa memanggil `verifyTask`
  langsung; yang ditutup adalah **klaim otomatis worker**, bukan semua pemanggil.

### 2e. Bug nyata dari acceptance: perubahan ter-commit

Acceptance HTTP menemukan `verify_failed: no files changed` padahal agen sudah meng-commit
`src/change.txt`: verifier hanya membaca working tree, dan commit meninggalkan tree bersih.
`c8e799f` membandingkan baseRef yang divalidasi server (fallback `HEAD^`) lalu menggabungkan file
committed + uncommitted; berlaku untuk run biasa maupun central autonomy. Detail:
`RND/qc/wave5-public-acceptance.md`.

---

## 3. P4: memory dan inbox

| File | API / perilaku | Status |
|---|---|---|
| `memory/memoryWrite.ts` | `claimMemory`, `promoteMemory`, `supersedeMemory`, `quarantineMemory` | `[W]` |
| `memory/memorySearch.ts` + `memoryCore.ts` | `searchMemory` (FTS5 + bm25), `listMemory`, `memoryEvents`; `toFtsQuery`, `validateEvidence`, `assertCanPromote` | `[V]`; redeclare `evidence` snapshot sudah hilang |
| `memory/memoryFile.ts` (+`FilePath`/`Render`/`Ensure`) | export fact → Markdown+JSON frontmatter, commit git, rebuild files-win; root `0700` + `git init` otomatis, identitas git milik server | `[V]` + test |
| `memoryFileHttp.ts` (+`Response`) | `POST /api/memory/export`, `POST /api/memory/rebuild`, gate `WEBTERM_MEMORY_FILES=on`; error di-redaksi | `[V]` + test |
| `memoryWriteApi.ts` (+`test`) | `POST /api/memory/claim`, `POST /api/memory/promote`; body cap 64 KiB dibaca lazy, otoritas server `human:api-root` (field `authority`/`actor`/`status` dari payload diabaikan), root/loopback saja (tidak ada di `isNodeTokenPath`); error stabil 400 `invalid_memory` / 404 `memory_not_found` / 409 `memory_conflict`; ledger off → 503 `ledger_off` | `[V]` + test; dipasang di `api.ts` sebelum route baca (`e52e767`) |
| `central/*` | portfolio + project projection, pause/resume/priority (lihat §4b) | `[V]` + test |
| `memoryApi.ts` | `GET /api/memory`, `GET /api/memory/search` (read-only) | `[V]`, ter-mount |
| `inboxApi.ts` | `GET /api/inbox` + counts; pagination + validasi | `[W]`, ter-mount |
| `client/inboxApi.ts` + `InboxPanel` | klien inbox, consent dialog, badge dock | `[W]` |

Gap P4 setelah wave 4:

- Route tulis memory sekarang ada (`POST /api/memory/claim|promote`, `e52e767`). Otoritas tidak
  lagi laten di payload: server selalu memakai `human:api-root`, dan field `authority`/`actor`/
  `status` kiriman client diabaikan (bukan ditolak dengan pesan yang membocorkan bentuk internal).
  Route ini root/loopback saja dan ber-body-cap 64 KiB. Yang belum: pemakaian nyata dari UI/agent
  (belum ada pemanggil produksi selain HTTP) dan uji end-to-end claim → promote → export file.
- Otoritas tulis file tetap dipin ke `{kind:'human', id:'root'}` dan scope `core` ditolak
  (`memoryFileRender`), jadi body tidak bisa mengklaim otoritas.
- P4b (fact file + git truth) sekarang `[V]` di balik flag, dengan acceptance cold root nyata
  (`qc/p4-memory-fix-acceptance.md`). Soak 2 project × 2 minggu belum dijalankan.
- Central: scheduler otonom awal ada di §4c (`WEBTERM_CENTRAL_AUTONOMY=on`, satu item `assigned`/tick, audit, karantina). Otonomi yang lebih luas (membuat/memilih task sendiri, prioritas) belum ada.

---

## 4. P5: channels

| File | API / perilaku | Status |
|---|---|---|
| `channels/webhook.ts` | `verifyWebhook` (HMAC+timestamp), `verifyTelegramSecret`, `signWebhook`, `redactSecrets`, `bodyWithinLimit` | `[W]` + test |
| `channels/identity.ts` | `IdentityRegistry`, `authorizeCommand`, `parseCommand`, `isBareConsent` | `[W]` + test |
| `channels/channelsRuntime.ts` | `POST /webhooks/telegram`; aktif hanya jika `WEBTERM_TELEGRAM=on` + secret + ledger; throttle auth-failure per peer, opt-in `WEBTERM_TRUST_PROXY=on` memakai entri pertama `x-forwarded-for` yang valid | `[V]` + test (throttle proxy) |
| `channels/telegram.ts` + `outbox.ts` | `parseTelegramUpdate`, `sendTelegramMessage`, `telegramBotToken`; `Outbox` in-memory, backoff, dead-letter | `[V]` + test |
| `channels/channelStore.ts` | binding + dedupe persisten, file `0600`, dir `0700`; `parseStoreState` menurunkan `owner`/`approver` group (`chatId` mulai `-`) ke `operator` saat load, file tidak ditulis ulang sampai save berikutnya | `[V]` + test (load + no-rewrite) |
| `channels/channelBindingsApi.ts` + `Http` | `GET/POST/DELETE /api/channels/telegram/bindings`, root-only; tolak `approver`/`owner` untuk group | `[V]` + test |
| `channels/channelSenderBoot.ts` + `telegramSend.ts` | sender outbox: retry/backoff, dead-letter, redaksi token; boot hanya bila token ada | `[V]` + test; boot dengan token asli terverifikasi (status hidup), delivery belum |
| `channels/channelsMasterGate.ts` | `channelsMasterState(env)` untuk `WEBTERM_CHANNELS`: kosong/`on` = perilaku lama, `off` = runtime kanal tidak dibuat, nilai lain (`readonly`/`control`) fail-closed jadi off + satu warning; nilai mentah tidak pernah dicetak | `[V]` + test; dipasang paling awal di `startChannelsRuntime` (`db20f7b`) |

Efek master switch `off`: `startChannelsRuntime` mengembalikan `null`, sehingga webhook dan binding
API tidak terpasang (bukan 503 `channel_disabled`, yang hanya muncul bila store `undefined`) dan
sender egress tidak di-boot. Store kanal JSON, jadi tidak ada migrasi SQL v4 untuk kanal (§8 G3).

Yang **belum** ada:

- `WEBTERM_CHANNELS` berfungsi sebagai kill switch `on|off` (`db20f7b`); `readonly|control` belum
  diimplementasi dan sengaja fail-closed (satu warning, kanal mati).
- Binding punya route dan pemanggil produksi; chat yang belum di-bind tetap ditolak.
- Delivery Telegram nyata belum diuji: test memakai fetch/update palsu, webhook publik belum
  dipasang, tidak ada pesan terkirim. Yang terverifikasi hanya boot dengan token asli.

Status hidup Telegram (manual, 2026-11-01): `getMe` read-only (username bot bukan rahasia), lalu
server dengan token asli mencapai `telegram channel: on` dan egress aktif. Webhook **tidak**
di-`setWebhook` dan tidak ada pesan keluar: ini bukti konfigurasi boot, bukan delivery.

Artinya ingress + egress + binding ter-wire dan residual throttle/binding group tertutup; P5
belum production-ready sampai delivery nyata (webhook publik + satu pesan) diuji.

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
menolak field yang dikendalikan klien. Sejak `6a5fa55`, `run` juga bisa diwajibkan membawa
approval ledger: dengan `WEBTERM_RUN_REQUIRE_APPROVAL=on`, langkah `run` baru jalan setelah ada
approval `approved` yang di-consume tepat sekali (§2c). Approval itu tetap dibuat manusia; loop
belum bisa menyetujui dirinya sendiri. Acceptance HTTP: `p4-control-plane-acceptance.md`
(bootstrap → 409 duplikat → assign → plan/tasks, nol worktree/PTY, B1/B2 fixed `0b63714`) dan
`p4-worker-loop-acceptance.md` (fresh data dir: run → worktree → PTY → prompt satu baris →
SessionEnd → verify independen → `verified` → cleanup; **agen palsu, bukan Claude**).
Agen pusat otonom versi awal ada di §4c; yang **belum** ada adalah perilaku otonom yang lebih
luas dari "satu item `assigned` per tick".

---

## 4c. Central autonomy: scheduler opt-in (`WEBTERM_CENTRAL_AUTONOMY`)

`9e200da` menambahkan loop yang memilih pekerjaan sendiri, tetapi batasnya sempit dan harus
dibaca sebagai scheduler, bukan otoritas:

| Aspek | Perilaku |
|---|---|
| Gate + interval | `WEBTERM_CENTRAL_AUTONOMY=on` (default off, case-insensitive), default 30 s (`DEFAULT_AUTONOMY_INTERVAL_MS`), timer `unref` dan idempoten; boot wajib ledger hidup + `WEBTERM_ORCHESTRATOR_RUN=on`, kalau tidak satu warning lalu tidak start |
| Seleksi | global, satu item `assigned` dengan `seq` terkecil per tick; item `running`/`done`/`failed` tidak disentuh |
| Skip | project `paused`, plan `completed`/`abandoned`, plan null; error baca plan diaudit `autonomy.tick_error` dan dilewati |
| Eksekusi | lewat `orchestratorRunRoute` yang sama dengan manusia; tidak pernah membuat task/plan, tidak pernah menyetujui approval, tidak melewati `WEBTERM_RUN_REQUIRE_APPROVAL` (run tanpa approval tetap 409) |
| Kegagalan | 3 kegagalan berturut-turut (default) mengkarantina project sampai ada sukses atau `project.status` berubah |
| Audit | event `autonomy.run`, `autonomy.budget_exhausted`, `autonomy.tick_error` dengan `actor: 'central'`, tanpa path/stack |

Bukti: `centralAutonomy.test.ts` dan harness soak (§1) menjalankan **scheduler nyata** dengan deps
palsu: 10.000 tick, max concurrency 1, satu run/tick, skip pause/terminal, karantina + reset. Itu
**bukan** soak 2×2 minggu wall-clock, bukan PTY/Claude/ledger nyata, dan tidak mengukur drift timer.

---

## 5. Security decision: approval manusia

Keputusan yang berlaku:

- Route manusia `/api/approvals/*` **tidak** capability-gated. Otorisasinya transport token
  (root) atau opt-in loopback eksplisit.
- Default menolak: tanpa `WEBTERM_TOKEN`, route menjawab `403 approval_requires_token`.
  `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` satu-satunya pengecualian, khusus demo lokal, bukan produksi.
- Node token (`wcap_*` / token per node) tidak membuka route manusia. Agen tidak boleh
  menyetujui aksinya sendiri, sekalipun ia bisa curl loopback.
- Control plane `/api/control/approval/*` tetap capability-gated dan tidak membaca
  `x-webterm-token` sebagai otoritas.

Aktor audit (sejak `748afa3`) diturunkan dari transport, bukan body: root token lewat header
`x-webterm-token` atau `?token=` → `human:root`; loopback opt-in tanpa token → `human:loopback`.
`approvedBy`, event audit, dan transisi task memakai aktor itu; `actor` di body diabaikan. Ini
identitas tingkat transport, **bukan** per-user/per-agent, dan belum terikat capability.

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

- Node canvas interactions belum diuji E2E (E2E P3 memakai workspace kosong); `DedupeStore`
  teruji tetapi tidak dipakai produksi.
- Klaim otomatis worker sudah ditutup provenance (§2d), tetapi `verified` masih punya jalur
  approval manusia dan pemanggil ledger in-process tepercaya; "satu-satunya jalur" belum absolut.
- Claude nyata lewat `/api/orchestrator/run` **BLOCKED** (2026-11-01): belum pernah menjalankan
  satu turn. Run 1 keluar di prompt workspace-trust; Run 2 (trust diterima) `Not logged in ·
  Run /login`. Loop penuh hanya lulus dengan agen palsu (PTY, prompt satu baris, SessionEnd,
  verify, cleanup). Lihat §2b.
- Actor binding baru sampai tingkat transport (`human:root` / `human:loopback`); identitas
  per-user/per-agent dan pengikatan ke capability belum ada.
- Soak 2 project × 2 minggu wall-clock belum dijalankan; yang ada hanya harness 10.000 tick
  dengan deps palsu (§4c). Delivery Telegram nyata (webhook publik + satu pesan) juga belum;
  E2E Claude nyata + node canvas dipegang user.
- Central autonomy masih satu item `assigned` per tick: belum memilih/membuat task atau plan,
  belum menyetujui approval, dan belum punya strategi multi-item/prioritas (§4c).

Butir lama "gate blocking approval di jalur run belum ada" tidak berlaku per `6a5fa55`:
gate-nya ada, tetapi opt-in (§2c), bukan default.

Sudah ditutup di wave 2-3 (`9af9047`..`5d466e7`, plus wave 2):

- `InboxPanel.tsx` 369 baris + `inboxItemRow.tsx` 63; `ledgerSchema.ts` dipecah
  (`0f12506`); `orchestrator*Api` 103/38.
- Spawn PTY produksi di `workerRuntime.ts` (PTY ditutup + worktree dilepas saat throw, `2176c98`);
  binding Telegram + sender outbox ter-wire; P1 (`fb08982`) membaca cap body control/agent-status
  berbatas saat streaming (64/256 KiB), dengan ackKey per node dan replay lintas restart diuji.
- C2: `recordWorkerResult` memakai `ledger.tx` untuk transisi task + `plan.updateItem` + audit;
  plan stale me-rollback task (`orchestratorRun.test.ts`).
- C3: `run` menjawab 409 `project_paused` sebelum repo/plan/worktree (`4e0517c`); gate plan
  terminal 409 `plan_closed` untuk `completed`/`abandoned`, `draft`/`active` lolos (`01e33ac`).
- Correctness worker: sessionId per run (Claude memakai `--settings`/hooks) dan `verified` wajib
  ada file berubah; diff kosong → `verify_failed: no files changed` (`5d466e7`).
- Binding group saat load turun ke `operator`, file tidak ditulis ulang (`887f174`).
- Cap body: `PATCH /api/settings` 64 KiB, `POST /api/workspaces|active` 1 MiB, tolak-cepat
  `Content-Length` (`0061f44`). Pembaca `fs`/`git` sengaja tanpa cap.
- Throttle proxy `WEBTERM_TRUST_PROXY=on` memakai hop pertama `x-forwarded-for` valid; default
  alamat socket (`d6ff546`).
- Telegram hidup (manual): `getMe` read-only + boot token asli `telegram channel: on`, egress
  aktif; tanpa webhook/pesan. Alias token: `WEBTERM_TELEGRAM_BOT_TOKEN` dulu, legacy fallback
  (`8b09ff4`). `ledgerRuntime.bun.test.ts` memulihkan `WEBTERM_LEDGER` ambient (`10e2f8e`).

Sudah ditutup di wave 4 (`e52e767`..`6a5fa55`):

- Route tulis memory: `POST /api/memory/claim` dan `/promote` (`e52e767`). Otoritas diturunkan
  server sebagai `human:api-root`, payload `authority`/`actor`/`status` diabaikan, body cap
  64 KiB, root/loopback saja, error stabil 400/404/409. Menggantikan catatan "route claim/promote
  belum ada". Uji: `memoryWriteApi.test.ts`.
- Gate approval opt-in di jalur run (`6a5fa55`): `WEBTERM_RUN_REQUIRE_APPROVAL=on` mewajibkan
  `approvalId` + `approvalDigest`; bila field dikirim (flag apa pun) approval di-consume tepat
  sekali lewat `runApproved` setelah cek body/project/plan dan sebelum worktree/PTY. 409
  `approval_required`/`approval_rejected` (§2c).
- Master switch kanal: `WEBTERM_CHANNELS` `on|off` (`db20f7b`), dievaluasi sebelum
  `WEBTERM_TELEGRAM`; nilai tak dikenal fail-closed + satu warning tanpa mencetak nilai mentah.
  Store kanal JSON, jadi tidak ada migrasi SQL v4. Uji: `channelsRuntimeMasterGate.test.ts`.

Sudah ditutup di wave 5-6 (`9e7416d`..`5214ea2`):

- Provenance verifikasi: `verifiedBy='server-verifier'` wajib dan hanya dibentuk
  `verifyWorktree`/`toModelEvidence`; evidence rakitan worker berhenti di `claimed_done`
  (`9e7416d`; §2d). Pengecualian approval manusia tetap eksplisit.
- Actor binding: route approval manusia menurunkan `human:root`/`human:loopback` dari transport,
  body `actor` diabaikan; `approvedBy`/event/transisi task memakai aktor itu (`748afa3`; §5).
- Central autonomy: scheduler 30 s opt-in `WEBTERM_CENTRAL_AUTONOMY=on`, satu item `assigned`
  per tick, skip paused/terminal, karantina 3 kegagalan, tanpa membuat task/approval dan tanpa
  melewati gate approval (`9e200da`; §4c).
- Acceptance HTTP nyata dengan agen PTY palsu (bukan Claude) di port 8830/8831: 17/17 PASS —
  memory claim 201/promote 200, approval request 201/decide 200, run tanpa approval 409 lalu
  dengan approval 200, task `verified`, `verifiedBy=server-verifier`, `changedFiles
  ["src/change.txt"]`, plan `done`, `approved_by=human:root`, satu tick central autonomy
  (`5214ea2`; `RND/qc/wave5-public-acceptance.md`).

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
| `WEBTERM_CHANNELS` | kosong/`on` (perilaku lama); `off` mati total | `[V]` + test; master kill switch di atas `WEBTERM_TELEGRAM`; `readonly`/`control` belum ada dan fail-closed |
| `WEBTERM_TRUST_PROXY` | `off` | `[V]` + test; `on` memakai hop pertama `x-forwarded-for` untuk throttle webhook |
| `WEBTERM_ORCHESTRATOR_RUN` | `off` (`on` saja) | `[V]`; gate `/api/orchestrator/run|bootstrap|assign` |
| `WEBTERM_RUN_REQUIRE_APPROVAL` | `off` | `[V]` + test; `on` mewajibkan `approvalId`+`approvalDigest` pada `/api/orchestrator/run`; tercantum di `.env.example` + README |
| `WEBTERM_MEMORY_FILES` | `off` | `[V]`; gate `/api/memory/export|rebuild` |
| `WEBTERM_MEMORY_DIR` | `<dataDir>/memory`; hanya path absolut | `[V]`; nilai relatif diabaikan |
| `WEBTERM_CENTRAL` | `off` | `[V]`; gate `/api/central/*` |
| `WEBTERM_CENTRAL_AUTONOMY` | `off` | `[V]` + test; `on` menjalankan scheduler 30 s (§4c); butuh ledger + `WEBTERM_ORCHESTRATOR_RUN=on`; tidak melewati approval; tercantum di `.env.example` |
| `WEBTERM_ALLOW_TOKEN_MINT` / `WEBTERM_STRICT_HOOK_AUTH` | `0` | `[V]` |

Urutan boot yang benar: `WEBTERM_CHANNELS` tidak `off`, lalu `WEBTERM_LEDGER=on` dulu (atau
`shadow`), lalu `WEBTERM_TELEGRAM=on` dengan secret. `WEBTERM_CHANNELS=off` mematikan webhook,
binding API, dan sender sekalipun `WEBTERM_TELEGRAM=on`. Tanpa ledger, channel tidak dipasang
sama sekali. Approval manusia butuh `WEBTERM_TOKEN` atau opt-in loopback. `WEBTERM_TRUST_PROXY`
hanya untuk deployment di belakang reverse proxy yang menimpa `x-forwarded-for`; jangan
aktifkan bila klien bisa mengirim header itu.

---

## 8. Gate

| Gate | Status | Alasan |
|---|---|---|
| G0 typecheck + suite | ✅ | `tsc` strict + unused bersih; vitest 138 file / 1835 test dan bun 29 file / 204 test lulus pada `5214ea2` (`TMPDIR=/tmp`) |
| G1 seam | ✅ | P0 |
| G2 auth/capability | ⚠️ | capability ✅; family root-only dipin test; aktor approval manusia kini dari transport (`human:root`/`human:loopback`) ✅, tetapi identitas per-user/per-agent dan ikatan ke capability belum |
| G3 data/migrasi | ⚠️ | v1 ✅; v2 plan ✅; v3 `request_ack` ✅; schema dipecah; kanal memakai store JSON sehingga **tidak** butuh slot v4 |
| G4 orchestrator | ⚠️ | loop penuh + bootstrap/assign + verify ✅ (fake agent); C2/C3 + gate plan terminal + wajib file berubah + gate approval opt-in ✅; provenance server + deteksi perubahan ter-commit ✅ (`9e7416d`, `c8e799f`); acceptance HTTP 17/17 dengan agen palsu ✅ (`RND/qc/wave5-public-acceptance.md`); approval manusia dan pemanggil in-process tetap bisa `verifyTask` langsung; Claude nyata E2E BLOCKED (login/trust) |
| G5 memory/inbox | ⚠️ | repo + route baca + file/git truth (P4b) + route tulis claim/promote ✅ (`e52e767`); soak 2×2 minggu belum, belum ada pemanggil UI/agent untuk claim/promote |
| G6 central | ⚠️ | proyeksi + pause/resume/priority ✅; scheduler otonom opt-in ✅ (`9e200da`, satu item `assigned`/tick, audit, karantina); otonomi lebih luas (buat/milih task, prioritas) belum; harness soak bukan soak wall-clock |
| G7 omnichannel | ⚠️ | ingress + store + binding + sender + throttle proxy + revalidasi group + master switch `WEBTERM_CHANNELS` `on|off` ✅; `readonly`/`control` belum; delivery Telegram nyata (webhook publik + pesan) belum |

**Vonis: jalur P3 (approval + inbox) tertutup end-to-end; loop P4/P5 ter-wire lewat HTTP
(bootstrap → assign → run, memory read/write, central portfolio + scheduler otonom opt-in,
Telegram bindings/egress dengan kill switch), tetapi belum production-ready.**
Wave 4 menutup route tulis memory, kill switch kanal, dan prasyarat approval untuk run; wave 5
menutup klaim verifikasi otomatis worker, derivasi aktor approval manusia, dan loop otonom opt-in.
Yang masih menahan: Claude nyata E2E (BLOCKED pada login CLI + workspace trust), soak wall-clock
2×2 minggu, delivery Telegram nyata (webhook publik), E2E node canvas, otonomi lebih luas, dan
identitas aktor per-user. Gate approval run tetap opt-in: deployment default **belum** memaksa
approval untuk setiap run. Jangan sebut P3-P5 production-ready sampai itu ditutup.

---

## 9. Verifikasi ulang

```sh
TMPDIR=/tmp/st npx tsc --noEmit
TMPDIR=/tmp/st npx vitest run
TMPDIR=/tmp/st bun test $(git ls-files '*.bun.test.ts')
```

Wave 5-6 (`51dab65`..`5214ea2`): vitest penuh 138 file / 1835 test, bun penuh 29 file / 204 test,
`tsc` strict + unused bersih; hijau dengan `TMPDIR=/tmp` (gate §9). Harness soak dan acceptance
HTTP 17/17 (agen PTY palsu) PASS; `controlCwd` butuh `TMPDIR=/tmp`.
Terarah wave 5: 4 file / 65 test (`verifier`, `orchestratorRun`, `approvalHumanApi`,
`centralAutonomy`).
