# 21 — CA2 Gap Audit: central agent nyata vs visi user

Tanggal 2026-11-03. Branch `chore/rnd-central-v2` (dari `main` fdaf2b4). Semua temuan = **dibaca dari kode/RND**, tidak ada yang dijalankan di sesi ini. Fakta dan opini dipisah: fakta diberi `file:baris`, opini diberi label **[opini]**. Tanpa riset web (audit ini murni internal), jadi tidak ada klaim eksternal.

## 1. Ringkasan keputusan / rekomendasi tegas

1. **Akar masalah "central hanya membalas chat" bukan model lemah, tapi runtime nyata tidak diberi satu pun tool.** `OpenCodeRuntime` jalan tanpa MCP/executor; satu-satunya jalur aksi adalah blok teks `<webterm-proposal>` untuk 4 tool tulis-draf. Executor `portfolio.read` hanya dipakai `MockRuntime`.
2. **Control plane untuk spawn/prompt/wait/close/read node sudah ada dan matang** (`/api/control/*`, token `wcap_*`, idempoten, realpath guard). Central tidak memanggilnya sama sekali. Jembatan ini yang hilang, bukan fitur baru dari nol.
3. **Revisi I5 secara eksplisit** (central boleh `agent.spawn/prompt/close` lewat adapter server, bukan lewat env/token di proses model), dengan tier R2 + approval, cap worker, audit, kill-switch yang sudah ada sebagian. Rincian desain = RND/22.
4. **Urutan quick win**: (a) tool path untuk runtime nyata + katalog tool & path project di prompt; (b) tool baca (project detail, nodes, hasil run); (c) `agent.spawn/prompt/close` bergerbang approval; (d) agen worker bisa dikonfigurasi (bukan hard-coded `claude`); (e) history/ringkasan nyata di prompt. Pecah file over-limit sebelum menambah kode (§2.D).
5. **Jangan** mengaktifkan `WEBTERM_OPENCODE_ALLOW_TOOLS` sebagai jalan pintas: itu membuka `bash/edit/webfetch/task` tanpa batas ke model di cwd server (`opencodeOptions.ts:121-124`). Itu bukan control plane; itu shell bebas.

## 2. Temuan + bukti

### A. Matriks kemampuan visi vs kenyataan

| Kemampuan | Status | Bukti (fakta) |
|---|---|---|
| Spawn agent | **tidak** (untuk central); blok bangunan ada | Larangan: `RND/08:29` (I5), `RND/08:189` item 4, `RND/09:19`. `ALLOWED` hanya 4 tool, `proposalPolicy.ts:9`. Control plane `POST /api/control/spawn` ada, `controlApi.ts:28`, tapi tak dipanggil central. Orchestrator run spawn worker di worktree (`orchestratorRunProduction.ts`, `orchestrator/workerRuntime.ts`) hanya lewat jalur run. |
| Prompt agent | **tidak** (central) | `POST /api/control/prompt` ada `controlApi.ts:29`; central tak punya jalur. Env child dibersihkan dari `WEBTERM_*: `opencodeOptions.ts:47,91`. |
| Tutup agent | **tidak** (central) | `POST /api/control/close` `controlApi.ts:31`; tak diwire ke central. |
| Assign task | **ada** | `task.assign` di `applyProposal.ts`, validasi `proposalPolicy.ts`. Membuat task ledger + kunci item plan; tidak spawn/run (RND/14 §B3). Perlu flag `PLANNER=on`, `TOOLS=write`, `ORCHESTRATOR_RUN=on` (`turnService.ts:177-179`). |
| Run task | **sebagian** | Bukan tool LLM. Hanya timer otonomi: `centralAutonomy.ts` memanggil `orchestratorRunRoute` untuk 1 item assigned per tick; hidup bila `WEBTERM_CENTRAL_AUTONOMY=on` + `WEBTERM_ORCHESTRATOR_RUN=on` (`centralAutonomyBoot.ts:2,34,99`). Klaim "central tidak `task.run`" benar untuk LLM, salah untuk sistem. |
| Baca detail project | **sebagian** | Prompt hanya `{id,name,status}` + pending + memori (`centralPrompt.ts`, 23 baris). Tak ada path project, tree, README, branch, test status. `controlApiQuery.ts:22-27` `GET /api/control/plan` masih 501 `plan_not_available`. |
| Skill | **tidak** | Satu-satunya skill terkait webterm = `webterm-linked-context` untuk agent node, bukan untuk central. Tak ada registri/penambahan skill di `src/server/central/**`. |
| Memori | **sebagian** | Ledger tabel `memory`; retrieval read-only hanya scope project: `central/memory/contextBuilder.ts` (limit 6 fakta, 2048 char, 300/body); scope global mengembalikan `''`. Claim memori scope `central` ada di server tapi tidak jadi tool central. Flag `WEBTERM_CENTRAL_MEMORY` (`turnService.ts:179`). |
| Bot | **tidak** | Tak ada kode pembuat bot. Telegram bridge hanya konsumsi (`channels/telegramCentralBridge.ts`, 49 baris). |
| Channel | **sebagian** | Web chat: `/api/central/conversations` (`centralChatApi.ts:26`) berjalan, real OpenCode turn terbukti (RND/14 §1). Telegram: logika + test; teks bebas -> `ask()` ke `central:project:<id>`; grammar perintah deterministik `channels/identity.ts` (~158-200). Pengiriman nyata tak pernah E2E (CHECKPOINT; milik user). |
| Multi-project | **sebagian** | Portfolio list + percakapan per project `central:project:<id>`; `central:global` tanpa memori. Project ledger harus dibuat via `POST /api/orchestrator/bootstrap` (root-only, `extendedApi.ts:5`); grep client tidak menemukan pemanggilnya [belum terverifikasi menyeluruh, §8]. |
| Long-running | **sebagian** | Resume `--session` ada; loop otonom ada. Tidak ada: history nyata di prompt (`history` hanya id pesan, tak dipakai runtime OpenCode — `turnService.ts` ~162-206), ringkasan/kompaksi, checkpoint turn. Wall default 10 menit (`opencodeRuntime.ts`). Free model kena 429 `provider.quota` setelah ~4 turn (RND/14 §6). |

### B. Peta control-plane webterm yang bisa dipakai central

**Rute `/api/*`** (urutan di `api.ts:60-150`; keluarga lain di `extendedApi.ts`):
- Workspace/node: `/api/workspaces[/:id]`, `/api/active` (`workspacesApi.ts`). Settings `/api/settings` (`api.ts:80`) — memuat `agentLaunchCommands` (satu-satunya sumber cmd spawn).
- FS: enam verb `/api/fs/<verb>` + `GET /api/fs` (picker) (`fsApi.ts`, `api.ts:87-116`).
- Hook status agent: `agentStatusApi.ts` (token node terikat ke node-nya).
- **Control `/api/control/*`** (`control/controlApi.ts:28-34`): `POST spawn|prompt|wait|close|token`, `GET nodes|plan`. Verb token: node.spawn/prompt/wait/close/read, plan.read, approval.*.
- Orchestrator: `/api/orchestrator/{bootstrap,assign,run}` (`extendedApi.ts:4-5`, `orchestratorRunApi.ts`, `orchestratorControlApi.ts`); bootstrap/assign root-only.
- Approval manusia: `/api/approvals[/challenge...]` (`approvalHumanApi.ts:34-76`). Inbox `/api/inbox`. Central `/api/central/{portfolio,conversations,health}`. Memori `/api/memory/export|rebuild`.

**Mekanisme token**
- Capability `wcap_*`: hanya sha256 di memori proses; TTL default 15 menit, maks 60; resource `node:|workspace:|project:|*` (`control/capabilities.ts`, `controlAuth.ts`). Diterima hanya di `/api/control/*` via header (`auth.ts` ~128-171).
- Mint token: `POST /api/control/token`, wajib `WEBTERM_ALLOW_TOKEN_MINT=1` (`mount.ts:62`) dan root token.
- Node token `x-webterm-node-token` + env `WEBTERM_NODE_ID`/`WEBTERM_PORT`: dipakai agent di PTY untuk hook status; nama protokol webterm (lihat CLAUDE.md repo).
- Ack idempoten 10 menit/1000 entri; cwd lewat `controlCwdAllowed` (realpath); cmd dibangun hanya dari `settings.agentLaunchCommands` (`spawnSession.ts`, `controlCwd.ts`).

**Hari ini agent-node dibuat/di-prompt/ditutup lewat:** (1) UI client (user klik) -> workspace API + PTY WebSocket; (2) control plane (`spawn` -> `prompt` -> `wait` -> `close`) untuk klien terprogram; (3) orchestrator run: spawn di worktree, prompt, wait, verifikasi server-side, catat hasil (`workerRuntime.ts`, timeout default 300 s). Tidak ada satu pun yang dipicu oleh LLM central.

### C. Kenapa central hanya membalas chat (akar teknis, berurutan dari yang paling menentukan)

1. **Tanpa tool pada runtime nyata.** `turnService` mengirim `tools: [...DEFAULT_CENTRAL_TOOLS]` = `['portfolio.read']` (`turnService.ts:184`, `toolExecutors.ts:15`), tetapi executor-nya hanya di-wire ke `MockRuntime` (`centralChatHandlers.ts:50`). OpenCode tak diberi MCP. Parser proposal sengaja tanpa MCP in-process (komentar `proposalParser.ts`).
2. **Permission OpenCode menolak semua** `bash/edit/webfetch/task` (`OPENCODE_PERMISSION_DENY`, `opencodeOptions.ts:21-24,121`). Flag `WEBTERM_OPENCODE_ALLOW_TOOLS` benar-benar ter-wire (`opencodeRuntime.ts:140`, `opencodeToolsAllowed()`), tetapi mengubah semuanya jadi `allow` sekaligus — tak ada granularitas.
3. **Jalur aksi tunggal = blok proposal 4 tool** (`goal.propose`, `plan.propose`, `task.assign`, `approval.request`), maks 4 blok/turn, 16 KiB/blok (`proposalParser.ts`), kunci terlarang `path, repo, command, cmd, cwd, capability, token, decision...` (`proposalPolicy.ts:10`). Efek: draf, bukan aksi.
4. **Tak ada kredensial ke control plane.** Child env membuang `WEBTERM_* (`opencodeOptions.ts:47`) — benar secara I2, tetapi tidak ada pengganti (adapter server-side) sehingga central buta terhadap `/api/control/*`.
5. **Prompt miskin pengetahuan**: tanpa path project, tanpa katalog tool/API, tanpa dokumentasi webterm, riwayat percakapan hanya id (`centralPrompt.ts`; `contextBuilder.ts`). Cwd child = cwd server (`opencodeRuntime.ts`), bukan folder project.
6. **Kebijakan memblokir by design**: I5 (`RND/08:29`), tabel otoritas `RND/08:44` (central: "tidak decide approval, spawn, tulis fact"), I3, I4. Ini keputusan, bukan bug — perlu direvisi sadar (§6).
7. **Worker run hard-coded ke `claude`**: `DEFAULT_AGENT_ID/CMD = 'claude'` (`orchestratorRunModel.ts:16-17`) — user tanpa langganan Claude tak bisa memakai jalur run apa adanya.
8. **Permukaan UX**: ledger project hanya terbentuk via bootstrap root-only; tanpa itu portfolio kosong sehingga central tak punya apa pun untuk dikelola.

### D. Jebakan / hutang yang menghambat

Fakta (jumlah baris dari `wc -l`/dibaca; batas Rule 8: service 300, hard 500):
- **Over-limit**: `central/runtime/opencodeRuntime.ts` 306; `orchestratorRunProduction.ts` 335; `ledger verify.ts` 321; `orchestrator/workerRuntime.ts` 313. Hampir limit: `approvalApi.ts` 299, `channelStore.ts` 298, `channelDispatch.ts` 288, `memoryWrite.ts` 284, `conversationStore.ts` 284; client `App.tsx` 490 (hard 500), `SessionsPanel.tsx` 467. Rule 8: **tolak menambah kode** ke file over-limit (>10 baris) — pecah dulu.
- **Flag berlapis** (semua off secara default; fitur "hidup" butuh semuanya): `WEBTERM_CENTRAL`, `_CENTRAL_RUNTIME=opencode`, `_CENTRAL_PLANNER`, `_CENTRAL_TOOLS=write`, `_CENTRAL_MEMORY`, `_ORCHESTRATOR_RUN`, `_RUN_REQUIRE_APPROVAL`, `_CENTRAL_AUTONOMY`, `_ALLOW_TOKEN_MINT`, `_OPENCODE_ALLOW_TOOLS`. Flag dibaca langsung `process.env` di runtime (`turnService.ts:177-179`), bukan lewat satu fungsi — risiko drift. **[opini]** satu "mode central" (off/chat/propose/act) lebih mudah dioperasikan.
- **Bug/perilaku**: `step_finish` final kadang tak dikirim, sehingga `sessionRef` dan usage bisa nol (RND/14 §1); free model 429 tidak boleh di-retry; `GET /api/control/plan` 501.
- **Operasional**: vitest butuh `--maxWorkers=4 --testTimeout=20000`; test Bun butuh `TMPDIR=/tmp/st` (batas `sun_path` 104); `distAssets.generated.ts` stub (CHECKPOINT.md, tak terlacak git).
- **Belum terbukti** (RND/14 §5): turn dengan model berkredensial, soak 2-project, resume lintas proses, tool MCP nyata.

## 3. Opsi yang dipertimbangkan + alasan menolak

| Opsi | Keputusan |
|---|---|
| **A. Buka `ALLOW_TOOLS`** (bash+curl ke API) | Ditolak: shell bebas di cwd server; token harus dibocorkan ke env (melanggar I2); tak ada audit per aksi. |
| **B. Perluas blok proposal** (`agent.spawn/prompt/close` jadi tool teks ke-5..7) | **Dipilih sebagai langkah 1**: nol dependency, server tetap penegak, audit `central.proposal` sudah ada, jalan di model murah (hanya butuh teks). Kelemahan: satu arah — hasil baca harus lewat prompt/turn berikutnya. |
| **C. MCP stdio lokal** (OpenCode `mcp add` mendukung local `command/environment/timeout`, RND/14 §6) | **Dipilih sebagai langkah 2** untuk tool baca & loop multi-langkah. Syarat: server MCP mini memanggil fungsi internal, bukan HTTP bertoken; belum terbukti di runtime ini. Ditunda karena butuh bukti E2E dulu. |
| **D. Ganti runtime ke SDK agentik** (ClaudeAgentRuntime) | Ditolak: user tanpa langganan Claude; harus provider-agnostic (spec). |
| **E. Central memanggil `/api/control/*` via HTTP + `wcap_*` di env** | Ditolak: token di proses model; prompt injection bisa eksfiltrasi. Adapter in-process lebih aman. |
| **F. Biarkan semuanya lewat autonomy timer** | Ditolak sebagai satu-satunya jalur: tak ada interaksi ("hidupkan agent X sekarang"), hanya satu item per tick. |

## 4. Rekomendasi konkret untuk webterm (urutan quick win)

Tiap langkah: satu branch, test nyata, flag di balik `WEBTERM_CENTRAL_TOOLS`. Detail desain lanjutan di RND/22–23, 27.

1. **QW1 — prompt hidup (kecil, tanpa risiko)**: tambahkan ke `centralPrompt.ts` path project (dari `project.path`, `ledgerSchemaV1.ts`), katalog tool bertipe (nama + input singkat), dan N pesan terakhir sungguhan. Perlu pecah `opencodeRuntime.ts` (306) dahulu bila menyentuhnya; `centralPrompt.ts` (23 baris) aman.
2. **QW2 — tool baca server-side**: `project.read` (tree dangkal, README/CLAUDE.md terpotong, branch), `node.list`, `task.status`/`run.result`. Diimplementasi sebagai tool proposal "read" yang hasilnya disuntik ke turn lanjutan (maks 2 putaran/turn), tanpa efek tulis. Wire `GET /api/control/plan` (hapus 501) sebagai sumbernya.
3. **QW3 — `agent.spawn` / `agent.prompt` / `agent.close`** sebagai tool proposal tier **R2**: server menerjemahkan ke fungsi internal `spawnSession`/prompt/close, memakai `wcap_*` TTL pendek berscope `node:<id>` yang dipegang server, **tidak pernah** ke env model. Cap: ≤3 worker/project (I11), depth ≤2, cwd hanya worktree project lewat `controlCwdAllowed`, cmd hanya dari `agentLaunchCommands`. Default `WEBTERM_RUN_REQUIRE_APPROVAL=on` (manusia klik approve di `/api/approvals`). Audit tiap aksi; kill-switch = `central.pause` yang sudah ada (`central.ts`) + flag off.
4. **QW4 — worker agent configurable**: ganti `DEFAULT_AGENT_ID/CMD` (`orchestratorRunModel.ts:16-17`) dengan nilai dari settings (`agentLaunchCommands`) agar opencode/codex/gemini bisa jadi worker. Pecah `orchestratorRunProduction.ts` (335) lebih dulu.
5. **QW5 — `task.run` tool (R2)** yang memanggil jalur `orchestratorRunRoute` yang sama dengan timer, dengan `expectedVersion`. Setelah QW3 stabil.
6. **QW6 — bootstrap project dari UI/chat** (tool `project.bootstrap`, R3, wajib manusia) supaya portfolio tidak kosong.
7. **Konfigurasi**: satu fungsi `centralMode()` (off/chat/propose/act) menggantikan pembacaan `process.env` tersebar. **[opini]** hanya bila QW1–3 sudah merah-hijau; jangan didahulukan.

Bukan quick win (diserahkan RND lain): skill (RND/25), bot & channel baru (RND/26), memori global/promosi (RND/24), kompaksi (RND/23), indeks kode (RND/27).

## 5. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Prompt injection (pesan Telegram/isi README/hasil worker) memicu spawn berbahaya | Semua tool aksi = proposal yang divalidasi server; cwd/cmd tak pernah dari model; R2 butuh approval manusia; teks channel diberi label tak tepercaya. |
| Spawn berlebihan / biaya | Cap worker per project (I11), WIP 1, 3 attempt, wall 5–10 menit, budget token harian [angka = RND/23, 28]. |
| Free model 429 membuat demo mati | Tampilkan error `provider.quota` apa adanya, jangan retry; model default dapat dikonfigurasi (`WEBTERM_CENTRAL_MODEL`). |
| Token bocor | Tidak ada token di env/prompt/log; `wcap_*` hanya di memori server (sha256 tersimpan). |
| Menambah kode ke file over-limit | Pecah dulu (§2.D); tolak PR yang menambah ke file >300. |
| Model lemah tak patuh format proposal | Parser sudah menolak aman; tambah satu contoh few-shot tiap tool di katalog. |

## 6. Dampak ke invarian / keputusan lama

- **I5 ("central tidak spawn worker")** -> revisi: "central boleh *mengusulkan* spawn/prompt/close; server mengeksekusi lewat adapter dengan capability sempit dan approval tier R2". Alasan: visi user menuntutnya; kontrol pindah dari "larang" ke "gerbang", dan fondasi (control plane, `controlCwdAllowed`, ack, TTL) sudah menegakkannya.
- **RND/08 "Yang tidak boleh" item 4** dan tabel otoritas baris central -> ubah sejalan; `subagent_depth: 0` (`RND/08:79`) tetap untuk proses OpenCode (central sendiri tak membuat subagent internal).
- **I2 (tanpa token/`WEBTERM_*` di env agent)**: **dipertahankan**; adapter in-process membuatnya tetap benar.
- **I3 (central tak menyetujui)**, **I4 (central tak menulis fact)**: tetap; promosi memori via approval = RND/24.
- **"Tak ada `task.run`"** (RND/08 tabel tool MVP) -> revisi: sistem sudah menjalankannya via autonomy; tambahkan sebagai tool R2.
- I11 (depth ≤2, 3 worker/project, 3 attempt, WIP 1, 50 item) -> dipakai apa adanya sebagai cap.

## 7. Pertanyaan terbuka (butuh keputusan produk)

1. Setuju merevisi I5 sesuai §6? Tier default untuk `agent.spawn`: R2 (approval tiap spawn) atau R1 (otomatis sampai cap, approval hanya di atasnya)? **[opini]** mulai R2.
2. Agen worker default untuk user tanpa Claude: opencode, codex, atau gemini? Apa yang terpasang di mesin user?
3. Apakah project ledger harus dibuat otomatis saat workspace dibuat (tanpa bootstrap manual)?
4. Batas biaya/hari untuk central & worker (token atau jumlah turn), dan perilaku saat kena 429 free tier.
5. Apakah `ALLOW_TOOLS` boleh dihapus/dikunci agar tak ada jalan pintas shell bebas?

## 8. Yang TIDAK terverifikasi

- **Tidak ada yang dijalankan** (test, server, runtime). Semua status "ada/sebagian/tidak" berasal dari pembacaan kode dan RND.
- Nomor baris beberapa file (`turnService.ts` ~162–206, `identity.ts` ~158–200, `auth.ts` ~128–171) adalah rentang perkiraan dari pembacaan sebagian; fungsi lain dibaca penuh tapi baris tertentu tidak di-grep ulang.
- Klaim live OpenCode 2.0.26 (RND/14 §1, §6) dikutip dari dokumen, **tidak diulang** di sesi ini.
- Apakah node hasil `/api/control/spawn` tampil di canvas/workspace client: tidak dicek.
- Apakah UI client punya jalur membuat project ledger: hanya satu grep string `bootstrap`/`api/orchestrator` di `src/client`; hasil kosong tidak membuktikan ketiadaan.
- Perilaku MCP lokal OpenCode dengan `OPENCODE_CONFIG` (variabel itu di allowlist env, `opencodeOptions.ts:33`): tidak diuji.
- Pengiriman Telegram nyata: tidak pernah E2E (milik user).
- `CHECKPOINT.md` dibaca sebagian dan layout cabangnya basi; hanya dipakai untuk jebakan operasional.
- Tidak ada sumber eksternal 2026 dipakai; keputusan arsitektur eksternal (supervisor pattern, MCP, A2A) diserahkan ke RND/22–26.
