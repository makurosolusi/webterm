# MEMORI & KONTEKS AGENT PUSAT (November 2026)

Tanggal: 2026-11-01. Status: **riset, bukan implementasi**; tidak ada kode yang diubah.
Lingkup: memori jangka panjang dan perakitan konteks agent pusat di webterm.
Dasar kode: `src/server/memory/*`, `hookContext.ts`, `RND/03-RENCANA.md`, `RND/07-IMPLEMENTASI-P3-P5.md`.
Semua sumber web diakses **2026-11-01**; label bukti mengikuti `RND/90-REFERENSI/AGENT_PUSAT.md`.

## 1. Ringkasan
Tesis: memori central bukan transkrip dan bukan salinan ledger. Ia **lapisan retrieval atas
kebenaran yang sudah dimiliki sistem** (git, ledger, file fakta), dengan provenance, otoritas
tulis berlapis, dan anggaran token eksplisit.

1. Fondasi P4a benar arahnya: `claim -> fact` berbukti mesin, FTS5, event audit, supersede tanpa
   overwrite, file+git di balik flag. [kode: `memoryWrite.ts`, `memorySearch.ts`]
2. Belum ada **scope/aktor `central`** (`MemoryActorKind` hanya human/orchestrator/worker) dan
   `claimMemory` mewajibkan `projectId`, jadi preferensi user/lintas-project belum punya tempat.
3. File+git baru truth untuk fact yang **diekspor manual**; promosi tidak menulis file, supersede
   tidak menombok file lama, rebuild tidak menghapus baris yang hilang. "Files-win" masih parsial.
4. FTS5 cukup untuk MVP; embedding hanya setelah probe parafrase gagal (`sqlite-vec` pra-v1).
   Bukti promosi masih divalidasi bentuknya, **bukan diatesti server**, sehingga bisa dikarang;
   benchmark 2025-2026 didominasi klaim vendor dan staleness masih terbuka. [S1][S5][S7][S10][S11]

Rekomendasi: **MVP = retrieval read-only central + scope/aktor eksplisit + outbox ekspor file +
harness evaluasi**; hybrid retrieval dan konsolidasi menyusul.

---

## 2. Fondasi yang sudah ada

| Lapisan | Yang ada sekarang | Konsekuensi untuk central |
|---|---|---|
| Skema | `memory(id, project_id, scope, key, title, body, status, source_kind, source_ref, supersedes, superseded_at)`; scope `project|scratch|core`; status `claim|fact|quarantine|superseded` | Identitas stabil per `(project, scope, key)`; tidak ada `central`/`user`; `project_id` nullable tetapi claim menolak null |
| Tulis | Worker hanya `claim`; `promote` human/orchestrator; `core` human-only; `supersede` menyimpan riwayat; `quarantine` tanpa hapus | Pola otoritas sudah ada; central harus aktor baru, bukan dipaksa menjadi orchestrator |
| Bukti | `MachineEvidence {command, exitCode=0, observedAt, digest?}`; command ≤500 char; digest sha256; toleransi clock | Belum terikat `run_id`/`task_id`/commit dan tidak ditandatangani |
| Baca | `searchMemory`: FTS5 `MATCH`, `status='fact'`, `superseded_at IS NULL`, `bm25` asc, limit ≤100; `listMemory` memuat riwayat | Tidak ada provenance ringkas, stale flag, atau scope gabungan |
| Audit | `memory_event`: claim/promote/supersede/quarantine, actor, payload | Tidak dapat direkonstruksi penuh dari file |
| File+git | Flag `WEBTERM_MEMORY_FILES=on`; Markdown + JSON frontmatter; atomik `0600`; git argv tetap; root `0700`; redaksi; path confinement; rebuild files-win + karantina konflik | Hanya fact project/scratch; `core` tidak file-backed; ekspor tidak otomatis; file lama tidak ditombok |
| HTTP | `GET /api/memory`, `/api/memory/search`; `POST /api/memory/claim|promote` root-only (`human:api-root`) | Belum ada route baca central, pemanggil agent, atau ekspor otomatis |
| Central | Portfolio projection + pause/resume/priority + scheduler otonom opt-in; `hookContext.ts` hanya metadata roster (cap 10.000 karakter) | Central belum membaca memory; tidak ada context builder; pola benar: konteks kecil, data, konten penuh pull-based |

Gap terukur: (a) tidak ada aktor/scope `central`, `core` terikat project; (b) promosi/ekspor dua
tulisan tanpa outbox, crash menghasilkan fact tanpa file; (c) supersede mengubah key tetapi file
path lama tetap berisi konten lama; (d) rebuild tidak menghapus baris hilang, tidak memulihkan
`memory_event`, tanpa lock/transaksi; (e) tidak ada `stale_after`/`verified_at`; (f) central tidak
punya jalur baca gabungan `core` + fact proyek + ringkasan.

---

## 3. Yang perlu diingat agent pusat

Prinsip: **jangan simpan yang bisa diturunkan**. Ledger/git otoritatif; memori menyimpan pengetahuan mahal ditemukan ulang yang tidak terbaca langsung dari keduanya.

| Kategori | Contoh | Sumber otoritatif | Tempat memori | Penulis | Retensi |
|---|---|---|---|---|---|
| Goals | tujuan, definisi sukses, batas anggaran | `project` + `decision` + CORE | `core`/`central` fact | human | sampai diganti |
| Decisions | pilihan arsitektur, alasan, alternatif ditolak | tabel `decision` + event | fact ringkas + `source_ref` decision id | human/orchestrator | permanen |
| Project state | fase, plan, worker, blocker | proyeksi ledger | **tidak disimpan**; dibaca live | - | - |
| Conversation summary | goal, keputusan, state, open questions | transkrip sesi | `scratch`/`central` claim | central/orchestrator | 30-90 hari |
| Task outcome | pelajaran yang tidak terlihat dari diff | `task`/`run`/evidence | claim -> fact per project | worker claim, orchestrator promote | permanen bila fact |
| User preferences | bahasa, gaya review, zona waktu, tool | pernyataan manusia | `user`/`core` human-only | human | sampai dicabut |
| Procedural | runbook, perintah test, konvensi PR | `CLAUDE.md`, skills, repo | fact/`core` | human | versi git |

**Bukan memori (default tolak):** secret/token/password/key/connection string/`.env`, PII;
transkrip mentah, chain-of-thought, output tool/log penuh, scrollback; kode/diff (git); state
task/plan/approval (query ledger); teks web/tool/agent lain sebagai instruksi; ringkasan dari
ringkasan tanpa sumber; scratch kedaluwarsa. TTL hanya `scratch`; fact memakai `stale_after` (M9).

---

## 4. Retrieval dan perakitan konteks

### 4.1 FTS5 vs embeddings

| Aspek | FTS5 (sekarang) | Embedding | Hybrid |
|---|---|---|---|
| Kekuatan | identifier, path, error code, nama fungsi, exact/prefix, deterministik | parafrase, sinonim, lintas bahasa | menutup kelemahan masing-masing |
| Kelemahan | tidak paham makna; query `OR` token bisa over-recall; tanpa stemming (porter Inggris opsional) | model + biaya + versi index; `sqlite-vec` pra-v1 | dua index, dua jalur gagal, fusion perlu kalibrasi |

FTS5 adalah indeks keyword: `unicode61` memecah kata, tanpa stemming/sinonim; `bm25` mengurutkan
kecocokan, bukan makna. [S1] Embedding menambah recall semantik, tetapi `sqlite-vec` pra-v1 dan
bisa breaking. [S7] Mem0 2026 melaporkan fusi semantic + BM25 + entity, tetapi itu klaim vendor
dengan benchmark diperdebatkan. [S5][S11] **Rekomendasi:** FTS5 + filter + recency untuk MVP;
embedding hanya jika `recall@10 < 0.8` pada subset parafrase, dengan `embedding_model`, `dim`,
`chunk_hash` tersimpan. Graph DB menunggu query temporal/relasi yang gagal berulang.

### 4.2 Skoring dan pemilihan

Urutan: (1) **filter keras** scope/status/`superseded_at`/project/stale; (2) **candidate** FTS5
top 50, vektor top 50 bila hybrid, gabung dengan reciprocal rank fusion (RRF), bukan menjumlah
skor mentah; (3) **boost** exact key, scope priority (`core` > `user` > project > `central`),
entity/tag; (4) **recency** `exp(-age_days/half_life)` (14 hari state, 90 hari pelajaran, tak
terhingga untuk `core`/preferensi), hanya tie-breaker; (5) **importance** 1-5 dari manusia atau
frekuensi akses/link, bukan penilaian LLM saat menulis; (6) **dedupe** rantai `supersedes`, satu
key satu item; (7) **diversity** MMR ringan; (8) **pack** potong per item + pointer.

Formula usulan: `score = 0.55*rrf + 0.20*recency + 0.15*importance + 0.10*scope_boost -
0.20*stale_penalty`; bobot adalah konstanta bernama, bukan angka literal tersebar.

### 4.3 Anggaran token dan packing

- **Pinned** (`core`, aturan keras, indeks project): ≤2.000 token / ≤200 baris, prefix stabil.
- **Retrieved**: ≤4.000 token central, ≤2.000 orchestrator, 0 worker (pull sendiri); total memori
  ≤6.000 token, sisakan ruang task/tools.
- **Hook**: `hookContext` membatasi 10.000 karakter; roster hanya dikirim saat berubah.
- **Format**: header `id | scope | updated_at | source | confidence`, penanda data, dan kalimat
  bahwa memori adalah data, bukan instruksi; body tidak dirangkai menjadi perintah.
- **Truncation**: potong di batas paragraf, sertakan `memory_id` dan cara mengambil sisanya.

### 4.4 Summarization dan compaction

- Ringkasan adalah **claim**, bukan fact: goal, keputusan + alasan, state, open questions, bukti
  (commit/test/decision id), tanggal.
- Kompaksi mempertahankan beberapa turn terakhir verbatim dan merangkum sisanya; mengurangi
  context rot tetapi dapat kehilangan instruksi. [S3][S11]
- Jangan merangkum fact menjadi fact turunan tanpa `source_ref`; ringkasan mewarisi provenance
  dan tidak dipromosikan tanpa verifikasi ulang.
- Konsolidasi dipicu N task selesai, kontradiksi, recurrence ≥3, atau nightly; deterministik dan
  tercatat (M13/M14). Constraint penting ditulis ke file saat itu juga. [S2]

### 4.5 Provenance dan staleness

Setiap hasil wajib membawa `memory_id`, `source_kind`, `source_ref`, `updated_at`,
`evidence_digest`, status verifikasi. Tanpa provenance, baris tidak boleh `fact`. Staleness =
perubahan sumber setelah `updated_at`, bukan umur baris; fact basi ditandai dan skornya turun. [S5]

---

## 5. Kebijakan tulis dan konflik

| Aktor | Boleh | Tidak boleh |
|---|---|---|
| Worker | `claim` dengan `sourceKind`/`sourceRef`; `PROGRESS.md` di worktree | fact, `core`, memori bersama; promosi diri; hapus riwayat |
| Orchestrator | promosikan claim project dengan bukti server; supersede/quarantine dalam project | `core`; promosi lintas-project tanpa manusia; menilai hasil sendiri |
| Central | baca semua scope diizinkan; tulis ringkasan/episodik `scope=central` sebagai claim; usulkan fact lintas-project | fact project; `core`; promosikan klaim sendiri; spawn worker |
| Human | semua; `core`; keputusan lintas-project; approve/rollback | - |

Aturan: (1) **claim tidak dapat dicari** (`searchMemory` hanya fact), jadi klaim worker tidak
menjadi prompt injection sampai ditinjau. (2) **Promosi butuh bukti ter-atesti server**; bentuk
sekarang hanya validasi struktural karena `command`/`exitCode`/`observedAt`/`digest` dikirim
pemanggil. Server harus menerbitkan `evidence_id` terikat `run_id`/`task_id`/commit, command
allowlist, digest dihitung server, sekali pakai. [kode: `memoryCore.ts`; M8] (3) **Tidak ada
self-promotion**; `core`/lintas-project butuh dua kunci (usulan + persetujuan manusia). (4)
**Dedupe** key kanonik `<domain>.<subject>.<predicate>`; duplikat exact ditolak unique, duplikat
semantik digabung lewat supersede. (5) **Konflik**: key sama + nilai beda = claim + status
konflik; dua file beda isi = karantina; keputusan manusia dicatat di `decision`. (6) **Supersede**
menjaga rantai `supersedes`/`superseded_at`; key lama menjadi alias `key#superseded:<id>`; tidak
ada penghapusan diam-diam. (7) **Poisoning**: semua tulisan agent tidak tepercaya; batasi laju
klaim, pindai secret/injection, jangan auto-promote output tool. OWASP ASI06. [S10]

**Otoritas central yang disarankan:** hanya `scope='central'` (baru) status `claim` dengan TTL
untuk ringkasan/pelajaran lintas-project; fact lintas-project tetap milik manusia. Butuh
`MemoryActorKind='central'`; memaksakan central menjadi `orchestrator` memberinya hak promosi fact.

---

## 6. File+git sebagai truth, SQLite sebagai indeks

**Model kebenaran.** Durable fact = baris `fact` yang sudah diekspor ke Markdown dan di-commit;
hanya ini yang dijamin pulih dari git. SQLite = indeks + antrean + audit; boleh hilang dan
dibangun ulang, tetapi `memory_event` tidak sepenuhnya dapat direkonstruksi dari file, jadi
frontmatter membawa `createdAt`, `updatedAt`, `evidence`, `supersedes`, `source`. `core` human-only,
tidak pernah diekspor/di-rebuild oleh agent; saat ini `core` tidak file-backed, gap yang harus
diputuskan. Scratch/ringkasan tidak durable dan tidak masuk git kecuali dipromosikan.

**Sinkronisasi (outbox, bukan dual-write).** (1) Dalam transaksi `promote`/`supersede`, tulis
baris memory + event + outbox idempoten per `memory_id`+`updated_at`. (2) Worker ekspor menulis
file atomik, `git add/commit` path eksplisit, menandai `exported_at`; crash aman karena ulang
ekspor menghasilkan `unchanged`. (3) Rebuild = maintenance: lock global, snapshot file, satu
transaksi, files-win; baris yang tidak ada di file ditandai `missing`/`quarantine`; konflik isi
tetap karantina. (4) Supersede menulis tombstone `_history/<id>.md` (`status: superseded`,
`supersededBy`) dan memindahkan file path lama dalam commit yang sama; tanpa ini file basi tetap
terlihat. (5) `core` tidak pernah masuk rebuild.

**Konkurensi & retensi.** SQLite satu writer, `BEGIN IMMEDIATE`, transaksi pendek; WAL tidak untuk
network filesystem. Git commit per fact, retry `index.lock`, jangan `git add -A`, identitas server.
Rebuild/ekspor tidak bersamaan; rebuild memakai snapshot DB atau ditunda; ekspor memeriksa ulang
`updated_at` sebelum commit. Fact/superseded/quarantine permanen; defrag ke 15-25 file per project
lewat PR. [S4] Scratch/ringkasan TTL 30-90 hari; transkrip mentah default off, 7-30 hari bila
diaktifkan. Backup `VACUUM INTO`, `integrity_check`, retensi 3; FTS rebuild sebagai pemulihan. File
`0600`, direktori `0700`, redaksi secret, tolak traversal/symlink, jangan log isi memori. [S2]

---

## 7. Evaluasi

Harness dibangun **sebelum** embedding/konsolidasi: 100 query per project dari decision/task nyata, gold `memory_id` + jawaban.

| Probe | Definisi | Target (usulan) | Cara |
|---|---|---|---|
| Recall@10 / nDCG@10 | gold fact muncul dan urutan | ≥0.80 / ≥0.75 | query berlabel + graded relevance |
| Precision@5 | 5 hasil teratas relevan | ≥0.70 | human/LLM judge, sampel ganda |
| Paraphrase | query tanpa kata kunci sama | ≥0.60 tanpa embedding | subset sinonim |
| Staleness / contradiction | sumber berubah; dua fact bertentangan | ≤5% / 0 | commit/task; pasangan key |
| Leakage | secret/PII/cross-project lolos | 0 | canary + scanner + boundary test |
| Cost / latency p95 | token memori; waktu retrieval | ≤2.000; ≤200 ms | hitung token; benchmark lokal |
| Write precision | fact di-supersede/quarantine ≤30 hari | ≥0.90 | audit event |

Probe keamanan: instruksi di body, secret canary, key project lain, baris `superseded`, klaim
worker belum dipromosikan; semua harus gagal aman atau muncul sebagai data berprovenance.
Ablation FTS5 vs +recency vs hybrid; jangan menilai dengan LLM judge tunggal. [S5][S11]

---

## 8. Rekomendasi MVP dan lanjutan

**MVP:** (1) taxonomy key, kategori, aturan "bukan memori", pemetaan goal/decision/state/
summary/outcome/preference; (2) `scope='central'|'user'`, `MemoryActorKind='central'`, otoritas,
unique index `project_id NULL`; (3) context builder `core` + fact project + ringkasan dengan
provenance, stale flag, dedupe, anggaran token; (4) central hanya claim `central`/`scratch`, fact
tetap human/orchestrator, bukti ter-atesti, larangan self-promotion; (5) outbox ekspor, tombstone
supersede, rebuild dengan lock/transaksi, status `missing`; (6) harness probe, canary, biaya.

**Later (setelah data):** hybrid retrieval bila recall parafrase gagal; konsolidasi/defrag dan
deteksi kontradiksi; memori lintas-project berbasis entity/relasi bila query temporal perlu;
retensi otomatis, verifikasi ulang fact saat source berubah, audit GDPR/penghapusan. **Jangan
bangun sekarang:** vector DB terpisah, graph DB, transkrip mentah, auto-promote tool output, LLM
judge sebagai verifier, penulisan fact oleh central.

---

## 9. Keputusan terbuka

1. `core` menjadi `CORE.md` human-only, atau tetap SQLite-only?
2. Scope `user`/`central`: `project_id NULL`, tabel terpisah, atau sentinel?
3. Siapa menerbitkan evidence, masa berlaku, dan binding ke commit?
4. Ekspor otomatis saat promote, atau manual `pending durable`?
5. TTL ringkasan; bolehkah ringkasan lintas-project masuk prompt central, dan bolehkah central
   membaca `scratch` project lain atau hanya fact + ringkasan tervalidasi?

---

## 10. Sumber

Semua diakses 2026-11-01. Sumber vendor ditandai; angka benchmark vendor bukan bukti independen.

| ID | Sumber | Dipakai untuk |
|---|---|---|
| S1 | SQLite FTS5 — https://sqlite.org/fts5.html | tokenizer, `MATCH`, `bm25`, external content, rebuild |
| S2 | Anthropic Memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool | memori file client-side, just-in-time retrieval, path traversal, expiry, data sensitif, pola progress |
| S3 | Anthropic Compaction — https://platform.claude.com/docs/en/build-with-claude/compaction | ringkasan turn lama, pasangan memori+kompaksi, kualitas turun saat konteks panjang |
| S4 | Letta Context Repositories — https://www.letta.com/blog/context-repositories/ | file+git, commit tiap perubahan, worktree paralel, defrag 15-25 file |
| S5 | Mem0 State of AI Agent Memory 2026 — https://mem0.ai/blog/state-of-ai-agent-memory-2026 | benchmark, semantic+BM25+entity, scope, staleness, biaya token (vendor) |
| S7 | sqlite-vec — https://github.com/asg017/sqlite-vec | vektor di SQLite, status pra-v1, `vec0` |
| S8 | OpenAI Agents SDK Sessions — https://openai.github.io/openai-agents-python/sessions/ | histori sesi, limit, `pop_item`, trust boundary SQLite |
| S10 | OWASP Top 10 Agentic (9 Des 2025) — https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ | ASI06 memory/context poisoning |
| S11 | Chroma Context Rot (14 Jul 2025) — https://research.trychroma.com/context-rot | 18 model, focused vs full context, distraktor, degradasi |

Catatan bukti: S5 mengukur sistem sendiri; S11 independen tetapi memakai model 2025. Tidak ada
studi 2026 yang mengukur desain claim/fact webterm; semua ambang di §7 adalah **usulan**.
