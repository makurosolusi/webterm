# 30 — Rencana Implementasi Central Agent v2 (bagian b: urutan, spec, gerbang, risiko)
Lanjutan `30-CA2-IMPLEMENTATION-PLAN-a.md` (peta WS-01…WS-20, gelombang W0–W3, titik panas). Singkatan path sama.

## 5. Urutan quick-win (central terasa hidup paling cepat)
Acuan `21` QW1–QW6 dan `22`. Urutan nilai/risiko `[opini]`:
1. **W0 bug-fix (WS-02)** — sesi berlanjut, turn yatim bebas, `limits` terisi. Tanpa ini central "pikun" dan bisa terkunci; paling murah, tanpa flag.
2. **QW1 prompt hidup (WS-06 sebagian)** — path project, katalog tool, N pesan terakhir sungguhan.
3. **QW2 tool baca (WS-05)** — central bisa melihat project/node/task nyata (R0, aman).
4. **QW4 worker configurable (WS-10)** — pengguna tanpa Claude bisa punya worker.
5. **QW3 `agent.*` (WS-09)** di level `propose` (kartu approval) — central menghidupkan/memerintah/menutup agen.
6. **QW5 `task.run` (WS-10)** setelah QW3 stabil; **QW6 `project.bootstrap`** (R3) paling akhir.
Paralel dengan itu: memori (WS-08) dan kanal Telegram ack-cepat (WS-12) karena independen.

## 6. Template prompt worker (tempel di awal setiap spec)
"Kamu worker `wkr-ca2-<id>`. Baca `CLAUDE.md` repo dan `RND/29-CA2-ARSITEKTUR.md` + `-b.md` bagian yang relevan. Bekerja di worktree sendiri pada branch `<branch>` dari `main`. HANYA boleh menulis/menyunting file yang tercantum pada baris WS-xx di `RND/30-…-a.md` §3. Dilarang: sentuh file WS lain, `index.ts`/`api.ts`/migrasi/`envRegistry*` kecuali milikmu, `git commit/push/merge/checkout` lain, install package, ubah `package.json`, baca `.env*`, cetak secret. Tulis test nyata (vitest atau `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`) bersama kodenya; jalankan `TMPDIR=/tmp/st npm run typecheck` dan test terkait; lapor file+hasil. Rule 8: jaga file di bawah batas; pecah bila lewat. Jangan rename `WEBTERM_*`/`x-webterm-node-token`. Laporan ≤150 kata dengan bukti `git diff --stat` (laporan tanpa diff dianggap tidak sah)."

## 7. Spec ringkas siap-tempel (tambahan setelah template)
- **WS-01** Buat `ledgerSchemaV5..V9.ts` persis skema `29-b §4.6` (aditif, `IF NOT EXISTS`, guard ALTER seperti `applyV4`; dedupe baris `memory` project NULL sebelum `uq_memory_key`; V9 hanya setelah `grep` membuktikan tak ada UPDATE/DELETE pada `event`, bila ada tinggalkan V9 sebagai TODO(ca2-audit) berkonteks). Daftarkan di `ledgerSchema.ts`. Buat `envRegistry.ca2.ts` untuk flag `29-b §4.7` (default aman) dan sambungkan di `envRegistry.ts`. Tes migrasi DB v4→v9 dua kali + backup.
- **WS-02** Perbaiki B1 (warisi `session_ref` turn sukses terakhir; teruskan `--session`), B2 (`reconcileTurns` saat boot: turn `running/queued` tanpa proses → `failed`+`interrupted`, kosongkan `active_turn_id`, simpan `partial_text`), B3 (`limits` dari env: turn 12 langkah/120 dtk/60k token), B6 (HOME/XDG khusus `<dataDir>/central/home`, tetap tanpa `WEBTERM_*`/`WEBTERM_*`). Pecah `opencodeRuntime.ts` (>300). Tambah `contextPort.ts` dengan default perilaku lama.
- **WS-03** Bangun `ToolDef`/registry/`execTool`/`toolsHash`; migrasikan 4 tool lama tanpa mengubah perilaku (semua test `proposal.test.ts` tetap hijau); `ALLOWED` diturunkan dari registry; katalog prompt dibangkitkan dari registry (≤1.200 token).
- **WS-04** Tulis tipe kontrak lintas-WS sesuai `29-a §4.3–4.4` dan `29-b §4.6`; tanpa logika; satu test tipe.
- **WS-05** Implementasikan `project.read`, `node.list`, `task.status`, `run.result` (R0) dan `runToolLoop` (maks `WEBTERM_CENTRAL_MAX_STEPS`=2) di `turnService`; hasil dipotong, di-redaksi, dibungkus data-bukan-instruksi.
- **WS-06** `ContextAssembler` nyata: urutan statis→checkpoint→memori→header→teks user; `central_checkpoint` (fakta deterministik + narasi ≤1.500 char, fallback saat gagal); rotasi sesi di 70% jendela, tolak di 85%; `ctx_tokens` dari `step_finish` terakhir; pindahkan instruksi statis ke file agent-prompt. Memori lewat `MemoryBlockProvider` (mock dulu).
- **WS-07** `ControlGuard` (level efektif `min(env,global,project)`, hitungan 3/project dan 5 global dan 20 spawn/hari, breaker persisten, budget harian, doom-loop), handler halt root-only; level turun berlaku seketika, naik hanya via token manusia.
- **WS-08** Perluas memori: scope `central|user|global`, aktor `central`, `memory.remember` (claim), `memory.remember_user` (kutipan verbatim diverifikasi server), FTS5+trigram+RRF, fix `contextBuilder.ts:26` (global kosong), ≤2.500 token, canary secret 0.
- **WS-09** Tabel `central_agents` store + state machine `29-b §4.8` + `execRunner` (argv array, env diskrub) + tool `agent.list/status/read/spawn/prompt/close`; spawn lewat `ControlGuard` dan deps injeksi (tanpa `wcap_*` ke LLM); `req_id` idempoten; intent→done adopsi saat crash.
- **WS-10** Ganti `DEFAULT_AGENT_ID` terpaku dengan kind dari `settings.agentLaunchCommands`; pecah `orchestratorRunProduction.ts`; `workerSignal.candidate_done`; ekspos `runTaskInProcess` dan tool `task.run` (R2, hormati `RUN_REQUIRE_APPROVAL`, `expectedVersion`).
- **WS-11** `agent_mail` store, `agent.relay`, pengiriman saat target tak `working`, amplop "bukan manusia, bukan persetujuan", ≤20 belum-ack, TTL 24 jam.
- **WS-12** Webhook langsung `200` lalu turn async; `callback_query` → approval via `decideApproval` (hanya private+terbinding); `ChannelAdapter`, `accountId`, migrasi `channels.json` v1→v2 dengan backup; grup tak bisa menyetujui.
- **WS-13** Managed Bots (`channel.bot.propose` R3, `getMe`, token ke `SecretStore`), kartu status editable, topic per project; fetch palsu untuk unit; catat bahwa uji nyata manual.
- **WS-14** Skill store + lint + lifecycle (proposed→lint→eval→approval R3→hash→active, rollback symlink) + `skill.list/load/propose`; skill builtin `webterm-*`; `permission.skill` hanya `webterm-*`.
- **WS-15** `knowledge.db` + Lite Map + `kb.search/map` + `project.discover` + `project.brief` deterministik ≤800 token dengan `asOf/stale`; scan terbatas (`light` bila >20k file).
- **WS-16** `scriptedRuntime` (JSONL rekaman + mode adversarial), adaptor `fakeWorkers`, harness golden, SQL metrik; W1: G2,G3,G7; W2: G1,G4–G6,G8–G12.
- **WS-17** Dispatcher non-blocking (tick hanya klaim lease; `inflight` terlacak; `maxInflightWorkers`=3), breaker persisten di otonomi, `wake()` event-driven + sweep 60 dtk, simpan handle timer, reconciler agen boot.
- **WS-18** Panel kontrol (level, budget, halt), daftar agen, kartu approval R2 dengan ringkasan aksi dari server (bukan narasi LLM), review skill, tampilan memori; tampilkan label privasi model gratis.
- **WS-19** Sambungkan semua: `registerAll.ts`, mount rute di `api.ts`, boot di `index.ts` lewat `ca2Boot.ts`, verifikasi semua flag off = perilaku lama (tes regresi).
- **WS-20** Dokumen sekali di akhir: `CHANGELOG.md` (versi dari manifest, perspektif user), README (hanya bagian kontrak berubah), `RND/README.md`, `07-…md`; jangan menulis "selesai" untuk hal tak terbukti (OpenCode+MCP nyata, Telegram delivery, soak).

## 8. Gerbang "siap diaktifkan default" dan rollout S0–S5
Acuan `28-b`. Gate keras = otomatis; gate lunak = bukti manusia.
| Tahap | Syarat masuk | Aktif default | Bukti keluar |
|---|---|---|---|
| S0 (sekarang) | — | semua off | typecheck+test hijau |
| S1 | W0 merge; WS-07; WS-17 reconciler | chat read-only | G2,G3,G7,G9 hijau; 0 turn zombie |
| S2 | W1 merge; harness; WS-05/06/08 | level `propose` (tanpa spawn), memori+checkpoint | semua gate keras hijau; soak 7 hari: 0 turn zombie, 0 budget terlewat, 0 canary; hash chain valid |
| S3 | WS-09/10/11/19; user setuju P1/P2 | `act_gated` per project (opt-in); Telegram private untuk approval R2 | + G1,G4,G11; ≥20 spawn nyata tanpa duplikasi; `task.run` dicabut dari "tidak ada" |
| S4 | 7+ hari tanpa insiden S3 | `act_envelope` opt-in per goal | + 14 hari tanpa insiden; breaker teruji nyata sekali; G12 |
| S5 | WS-13, kanal kedua | multi-project paralel, bot, kanal baru | 3 project × 3 worker tanpa kelaparan |
Aktivasi default = perubahan nilai default di `envRegistry.ca2.ts` oleh satu commit terpisah yang dipicu user; rollback = flag off (data aditif tetap).

## 9. Harness eval, golden test, metrik
Golden G1–G12 (daftar di `29-b §4.13`) berjalan tanpa model berbayar: `scriptedRuntime` memutar rekaman JSONL nyata `opencode run --format json` (direkam sekali), mode adversarial menghasilkan proposal jahat (kunci terlarang, spawn berlebihan, exfil); `fakeWorkers` memakai `orchestrator.fake.testutil.ts`. Perintah: `TMPDIR=/tmp/st npm test` dan `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`. Metrik via SQL atas `central_turn.usage_json`, `central_budget`, `event.kind`: turn/jam, p95 durasi, rasio `error_code`, cache read/(read+input), spawn sukses/gagal, breaker terbuka, antrean, `interrupted` (target 0). Alarm ke Inbox/Telegram private: breaker terbuka, budget >80%, `interrupted`>0, rantai audit putus. Kualitas model (recall memori, ketepatan tool) diukur terpisah, tidak menggate.

## 10. Dependency baru
**Tanpa dependency baru di fase 1–3** (Rule 10: <20 baris/native lebih dulu). Validasi tool tulisan tangan seperti `proposalPolicy.ts` (tidak ada `zod` di `package.json`); FTS5, JSON, hash, SQLite = `bun:sqlite`/`node:crypto`; scan import = `Bun.Transpiler.scan`; BM25-lite = SQL FTS5. Kandidat fase 2 (hanya jika gerbangnya tercapai, diaudit saat itu): `@modelcontextprotocol/sdk` (MIT, resmi; alternatif tulis server stdio minimal sendiri — ditolak karena protokol berubah) untuk MCP `bridge`; embedding lokal opsional via endpoint `WEBTERM_EMBED_URL` (tanpa package). Audit lisensi/kesehatan/versi `[belum terverifikasi]` — wajib dilakukan sebelum install (Rule 10, 20).

## 11. Risiko eksekusi paralel dan mitigasi
| Risiko | Mitigasi |
|---|---|
| Konflik merge pada titik panas | Pemilik tunggal per gelombang (§2 di a); integrator WS-19; W1 tak menyentuh `index.ts`/`api.ts`/migrasi/registry |
| Drift kontrak antar WS | WS-04 membekukan tipe di W0; perubahan tipe W1 = minta lewat orkestrator, bukan edit sendiri |
| Merge urut W0 (01→02→03→04) mengubah dasar W1 | Cabang W1 dibuat setelah W0 merge; rebase otomatis tidak dipakai |
| Flake test (PTY, unix socket, port, jam) | `TMPDIR=/tmp/st`, port acak, jam injeksi (`now`), `scriptedRuntime`, tanpa `sleep` nyata |
| Worker melapor fiktif (`memory/worker-laporan-fiktif.md`) | Orkestrator wajib cek `git diff --stat` dan jalankan test sendiri sebelum terima |
| Worker mati 524 (proxy) | Cek tree dulu, resume via SendMessage; bukan kerja hilang |
| File melebihi Rule 8 | Pecah di dalam WS yang memilikinya; reviewer menolak >300 (service) |
| Migrasi v5–v9 merusak DB | Hanya WS-01; uji pada salinan DB; v9 bersyarat |
| Sinyal "selesai" kosong (test tanpa asersi) | Review: tiap test punya asersi nyata; golden menjadi gate |
| Biaya/kuota model gratis memperlambat uji | Hanya `scriptedRuntime` di CI; 1 uji nyata manual per tahap |
Keputusan produk P1–P12 (`29-b §7`) harus dijawab user sebelum S3; P1, P2, P4 dan P11 paling mendesak karena memengaruhi WS-07, WS-08, WS-09.
