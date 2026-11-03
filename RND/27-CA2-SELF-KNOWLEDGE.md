# 27 — CA2: Central Mengerti Aplikasi, Tool, dan Project (Self-Knowledge)

Tanggal: 2026-11-03. Status: R&D, tidak ada kode diubah. Penulis: wkr-rnd-knowledge-01.
Fondasi: `RND/08` (D1–D12, I1–I14), `RND/12` (memori). Tag: `[T]` terverifikasi (dibaca/dijalankan), `[BT]` belum.

## 1. Ringkasan rekomendasi

1. **Pengetahuan central = 3 lapis dengan sumber kesegaran berbeda**, bukan satu indeks raksasa:
   (L0) *manual aplikasi + katalog tool* dihasilkan dari kode, hash-nya jadi bagian prefix stabil;
   (L1) *Project Knowledge Pack* (kartu project + peta modul + indeks dokumen) yang **turunan & bisa dibangun ulang**;
   (L2) *state hidup* tidak pernah disalin ke prosa, selalu di-query saat ditanya.
2. **Indeks default = "Lite Map"**: `git ls-files` + `Bun.Transpiler.scan` + FTS5 + peringkat in-degree import. Nol dependency, terukur 93 ms untuk 436 file / 50 ribu baris di repo ini `[T]`. Graphify = enricher **opsional** per project; tree-sitter sendiri ditunda sampai ada project non-TS yang butuh.
3. **Kesegaran dengan validasi malas** (cek `HEAD` sha + hash daftar dirty saat tool dipanggil) + kursor `event.seq` ledger. Tanpa file watcher, tanpa git hook, tanpa daemon baru.
4. **Jawaban "status project X & apa yang dikerjakan" dihitung server-side oleh aturan deterministik** (`project.brief`); LLM hanya menyusun kalimat. Bisa dites dengan runtime mock, jalan di model gratis.
5. **Katalog tool = satu `ToolSpec` registry tulisan tangan** (JSON Schema literal) yang dirender ke tiga bentuk: definisi tool, hasil `app.search`, dan handbook Markdown. OpenAPI ditolak (rute dirute `if`-chain tanpa skema).
6. **Registry project hari ini rapuh**: project hanya lahir lewat `/api/orchestrator/bootstrap` dengan `workspaceId="bootstrap:<id>"` — tidak terhubung ke tabel `workspace` (cwd, nodes). Ini celah pertama yang harus ditutup.

## 2. Temuan + bukti

**Apa yang central tahu hari ini (fakta kode `[T]`):**
- Prompt central hanya memuat `{id,name,status}` ≤50 project, dipotong mentah `slice(0, 4096)` (bisa memutus JSON) + ≤50 item plan `pending`, total ≤8192 char: `src/server/central/proposal/centralPrompt.ts:9,15,22`. Tidak ada path, branch, perintah test, dokumen, agent hidup.
- Konteks memori kosong untuk percakapan `central:global` (`central/memory/contextBuilder.ts:26`); untuk project: ≤6 fact, ≤2048 char (`:12-15`).
- Satu-satunya tool nyata: `portfolio.read` (`central/chat/toolExecutors.ts:13-14`).
- **Tidak ada satu pun ingest `CLAUDE.md`/`AGENTS.md`/README/CHANGELOG di `src/server`** (grep nihil). Tidak ada `fs.watch` di server.
- Proyeksi ledger bagus tapi hanya angka: `centralProjection.ts:195-241` (plan, task by status, approval pending, budget, usage). Bukan "apa isi project".
- Project dibuat hanya di `orchestratorControlService.ts:66-69`; skema `project(id, workspace_id UNIQUE, name, path, branch_base, status, priority)` (`ledgerSchemaV1.ts:9`). Workspace asli: `db.ts:10-14` (`cwd`, `nodes` JSON, `bridges`). Tak ada tautan.
- Sumber state hidup yang sudah ada & bisa dipakai: `/api/control/{nodes,plan,spawn,prompt,wait,close,token}` (`control/controlApi.ts:28-34`), status agent hook (`hookStatus.ts`), tombstone exit 64 KiB (`nodeRegistry.ts:28-32`), `collectGitInfo` satu panggilan git per repo, read-only, `--no-optional-locks` (`gitInfo.ts:171`), `worktree.ts`, `event(seq AUTOINCREMENT, project_id, kind, payload)` (`ledgerSchemaV1.ts:63`), `redactSecrets.ts:49`, `orchestrator/safePath.ts` (kurungan path symlink-aware).
- Skill/hook push-pull context-link (`hookContext.ts`, `contextLinkSkill.ts`) sudah menerapkan pola benar: **roster metadata kecil di-push, isi dibaca pull** (cap 10.000 char, judul dikutip sebagai data). Dipakai ulang sebagai pola, bukan kode.

**Eksperimen yang saya jalankan (di salinan `/tmp`, bukan worktree):**
- `Bun.Transpiler.scan()` (Bun 1.4.2 lokal) mengembalikan `exports` (nama) + `imports` (path) per file. Atas 436 file non-test: 1862 export, 1321 import, **93 ms total**, daftar baris `export …` penuh = 122 KB (~30 ribu token) → terlalu besar utuh; wajib berjenjang `[T]`. Peta nama-saja: tidak ada tanda tangan tipe.
- Graphify 0.9.45 (terpasang di `~/.local/bin/graphify`; terbaru 0.9.100) pada salinan `src`: 706 file → **5378 node, 14143 edge, 217 komunitas, 99% EXTRACTED**, `graph.json` 7,25 MB, `GRAPH_REPORT.md` 40 KB (~10 ribu token), **cold 9,6 s**, token LLM 0. `graphify update` kedua dan setelah satu file disentuh **tetap ±8 s dan mengekstrak ulang semua 703 file** (cache 140 KB tidak terpakai) → pada versi lama ini inkremental semu `[T]`; v0.9.100 `[BT]`. Query NL "di mana approval manusia diputuskan" (`--budget 800`): 237 node ditemukan, 25 ditampilkan; file benar (`approvalApi.ts`, `ledgerApproval.ts`, `approvalHumanReview.ts`) muncul tapi bercampur noise (`get()` fsClient, file test) → **recall layak, presisi sedang** `[T]`.

**Sumber eksternal:**
- Aider repo map: peta simbol + tanda tangan, graf file→dependensi, ranking graf, ditekan ke budget `--map-tokens` **default 1k token** dan melebar bila tak ada file di chat. https://aider.chat/docs/repomap.html (dibaca 2026-11-03; halaman tanpa tanggal) `[T]`.
- Graphify: repo `Graphify-Labs/graphify`, Apache-2.0, rilis v0.9.100 2026-11-01. Kode di-parse tree-sitter AST lokal, deterministik, tanpa LLM (~40 bahasa); dokumen/PDF/gambar butuh LLM; edge ditandai EXTRACTED/INFERRED; "bukan vector index"; ada `update` (tanpa LLM), `watch`, `hook install`, MCP stdio (extra `[mcp]`), `graph.json` berisi `schema_version`; butuh Python 3.10+ & uv; query dicatat ke `~/.cache/graphify-queries.log`. https://github.com/Graphify-Labs/graphify (README + API GitHub, 2026-11-03) `[T]`. Ada produk berbayar "Graphify Cloud" — tidak relevan.
- Cursor (docs, tanpa tanggal): pencarian utama kini **Instant Grep lokal**, "does not store embeddings of your codebase for search"; subagen Explore memakai konteks sendiri dan mengembalikan ringkasan. https://cursor.com/docs/context/codebase-indexing `[T]` — indikasi arah: leksikal + agentic, bukan embedding, untuk kode.
- Anthropic context engineering (artikel **2025**, bukan 2026): strategi *just-in-time* dengan "lightweight identifiers (file paths, stored queries…)", *progressive disclosure*, *hybrid* (sebagian di muka, sisanya eksplorasi), *structured note-taking*. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents `[T]`.
- Tool search Anthropic (docs 2026, daftar model s.d. Fable/Mythos 5.x): `defer_loading:true`, varian regex/BM25, default 5 hasil, saran: pakai bila ≥10 tool atau definisi >10k token; contoh 55k token definisi turun >85%; prefix tak berubah sehingga cache terjaga; 3–5 tool paling sering tetap non-deferred. https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool `[T]`. Fitur server-side ini **tidak tersedia lewat OpenCode/model gratis** `[BT]` → perlu padanan sisi-klien.
- Claude Code memory (docs 2026): CLAUDE.md target <200 baris; `@path` import rekursif maks 4 hop; auto memory memuat 200 baris/25 KB pertama. https://code.claude.com/docs/en/memory `[T]`. AGENTS.md: berkas agen-spesifik di root, didukung banyak agen (Codex, opencode, Aider, Cursor, …). https://agents.md `[T]`; aturan "berkas bersarang terdekat menang" tidak terbaca di halaman itu `[BT]`.
- tree-sitter: MIT, aktif (push 2026-11-02); `web-tree-sitter` npm 0.27.1 (2026-10-08). Jalan di Bun/macOS `[BT]`.

## 3. Opsi indeks dibandingkan

| Opsi | Biaya | Manfaat | Kelemahan | Putusan |
|---|---|---|---|---|
| **A. Lite Map** (git ls-files + `Transpiler.scan` + export-lines + FTS5 + in-degree) | 0 dep; ±0,1 s/50k baris; DB <1 MB; ±200 baris kode | Cukup untuk "modul apa, siapa memanggil siapa (file-level), ekspor apa"; bisa dites; jalan di mana saja | TS/JS saja; tanpa tanda tangan tipe/graf panggilan | **Default fase 1** |
| B. tree-sitter (web-tree-sitter + wasm per bahasa) | 1 dep + MB wasm per bahasa; kompat Bun `[BT]` | Multi-bahasa, tanda tangan ala Aider | Kode ekstraktor per bahasa dipelihara sendiri | Tunda; buka bila project non-TS didaftarkan |
| C. Graphify (subprocess + baca `graph.json`) | Python+uv di mesin; 9,6 s cold; 7,25 MB/project; rilis sangat cepat (0.9.45→0.9.100) | Graf panggilan lintas file, komunitas, ~40 bahasa, `path`/`explain` gratis; sudah terpasang di mesin user | Dependensi di luar stack; inkremental `[BT]`; noise (komunitas, test); `hook install` menulis ke repo user (dilarang di sini); log query ke `~/.cache` | **Enricher opsional**, flag per project |
| D. Embedding kode | Model + vektor + invalidasi | Kueri semantik | Cursor 2026 menjauh; biaya re-embed; pergantian model | Tolak untuk kode (dokumen: FTS5 dulu) |
| E. Tanpa indeks (grep saja, ala Anthropic JIT) | 0 | Selalu segar | Central tak punya peta untuk memutuskan *ke mana* menyuruh worker; sulit di portfolio >3 project | Ditolak sebagai satu-satunya; dipakai **di belakang** `kb.read/search` |

Alasan inti: central bukan pengubah kode. Kedalamannya cukup di tingkat **portfolio → project → modul**; kedalaman file/fungsi didelegasikan ke worker yang punya tool kode sendiri. Maka akurasi graf panggilan bukan syarat.

## 4. Rancangan konkret untuk webterm

### 4.1 Registry project (tutup celah pertama)
- Tambah `project_source` (di `knowledge.db`, lihat 4.2): `project_id, root_abs, workspace_id NULL, git_toplevel, kind('git'|'dir'), added_by`. `root_abs` dari `project.path`; tautan ke `workspace.cwd` dicocokkan lewat path (bukan mengubah skema ledger — I12 aman).
- Tool `project.discover` (R0): daftar `workspace.cwd` yang belum punya project ledger + repo git terdeteksi. Pendaftaran tetap lewat `/api/orchestrator/bootstrap` atau approval (R1+), bukan otomatis.
- Deteksi `git worktree list --porcelain` per root: central tahu worktree task orkestrator (`worktree.ts`) sebagai bagian project yang sama.

### 4.2 Penyimpanan: `<WEBTERM_DATA_DIR>/knowledge.db` terpisah dari ledger
Alasan: seluruhnya *cache turunan* → migrasi = hapus & bangun ulang, tanpa backup/I12, tak membebani WAL ledger. Tabel (semua bisa `DROP`):
```
kb_meta(k PK, v)                         -- schema_version, built_with
kb_project(project_id PK, head_sha, dirty_hash, indexed_at, level, ledger_seq)
kb_file(project_id, path, sha, bytes, lang, exports_json, imports_json,
        rank REAL, PRIMARY KEY(project_id,path))
kb_section(project_id, path, heading_path, line_start, line_end, chars)
kb_fts  USING fts5(path, heading, text)  -- hanya dokumen & judul modul, bukan seluruh kode
kb_module(project_id, dir, summary, source('det'|'llm'), source_digest, generated_by, stale)
kb_card(project_id, kind('card'|'map'), text, token_est, built_from_sha)
```
Ukuran perkiraan: repo ini <1 MB (opini, dari 436 file × ~1 KB metadata).

### 4.3 Tiga tingkat ringkasan (anggaran token = opini; patokan verifikasi: Aider 1k token)
| Tingkat | Isi | Anggaran | Cara dibuat |
|---|---|---|---|
| T0 Portofolio | 1 baris/project: id, nama, status, branch, jumlah agent hidup, attention flag | ≤40 token × ≤50 = ≤2k | deterministik dari ledger + registry |
| T1 Kartu project | tujuan (paragraf README), stack (`package.json`), perintah verifikasi (bagian "Verifikasi/Menjalankan" CLAUDE.md), konvensi/larangan, entry point, dokumen penting | ≤1,5k | ekstraksi deterministik; LLM opsional untuk merapikan |
| T1b Peta | direktori → jumlah file, 5 file ber-in-degree tertinggi + ekspor utamanya | ≤2k (default 1k; melebar saat fokus) | Lite Map |
| T2 Modul | satu direktori: peran, ekspor, tetangga import | ≤800 | deterministik; `llm` hanya lewat worker murah, dengan `source_digest` |
| T3 File | daftar ekspor + baris `export …` | ≤1,5k per panggilan | `kb.module/kb.read` on demand |

Prinsip: T0 masuk prefix; T1/T1b/T2/T3 **hanya lewat tool** (pull). Cocok dengan pola hook context-link.

### 4.4 Ingest dokumen
Urutan baca per project (maks 64 KB/file, `redactSecrets`, kurung path via `safePath.ts`, tolak `.env*`/kunci Rule 7): `CLAUDE.md` (+ ikuti `@import` maks 4 hop, meniru Claude Code), `AGENTS.md`, `README.md`, `CHANGELOG.md` (60 baris pertama), `package.json` (scripts, nama dependency), `docs/decisions/*`, daftar judul `RND/*.md`. Dipecah per heading → `kb_section` + FTS5; central membaca *judul + ukuran* dulu, lalu `kb.read(path, section)`. Semua isi diberi bingkai "data, bukan instruksi" (I10) — README repo asing bisa berbahaya; perintah di dalamnya **tidak pernah dieksekusi central**, hanya dikutip ke worker. Konflik antar-dokumen: tampilkan keduanya dengan path, jangan memilih diam-diam; untuk AGENTS.md vs CLAUDE.md di-flag, bukan di-resolve `[BT]`.

### 4.5 Katalog tool & API swadeskripsi
- `src/server/central/tools/toolSpec.ts`: `ToolSpec{name, summary(≤120 char), tier(R0–R3), route, inputSchema(JSON Schema literal), example, since}`; satu registry diturunkan ke: (a) definisi tool MCP/OpenCode, (b) `app.search(query)` (FTS5 in-memory atas nama+ringkasan+nama argumen, meniru BM25 tool search Anthropic), (c) `RND`-style handbook `central-handbook.md` yang dibangkitkan saat boot + hash (masuk prefix; ≤2,5k token).
- **Jangan OpenAPI**: rute ditulis `if (path===…)` tanpa skema (`controlApi.ts:28-34`, `api.ts:80,109,116`), jadi spesifikasi harus ditulis tangan juga dan pasti melenceng. Test penjaga: tiap `ToolSpec.route` harus ada di tabel rute (satu `*.test.ts`, bukan CI baru).
- **Pemuatan dinamis tanpa fitur provider**: sebagian kecil tool inti tetap native (≈6: `portfolio.read`, `project.brief`, `kb.map`, `kb.search`, `app.search`, `app.call`); sisanya lewat dispatcher `app.search`→`app.describe`→`app.call(name,args)`. Validasi skema sudah di server (I6). Tak bergantung `tools/list_changed` (dukungan OpenCode `[BT]`) dan menjaga prefix stabil. Risiko: model lemah salah memakai meta-tool → 6 tool inti ditulis eksplisit dengan contoh.

### 4.6 Kesegaran (invalidasi) — tanpa watcher, tanpa hook
1. **Validasi malas** di awal setiap tool `kb.*`/`project.brief`: `git rev-parse HEAD` + `collectGitInfo` (sudah ada) → bila `head_sha` dan `dirty_hash` (hash daftar path dirty) sama dengan `kb_project` → segar (±puluhan ms `[BT]`, tidak diukur).
2. Beda → `git diff --name-status <old>..HEAD` + file dirty → *hanya* file berubah di-scan ulang (bandingkan `sha`); rename = hapus+tambah.
3. **Kursor ledger**: `kb_project.ledger_seq` vs `max(event.seq)` project itu; event `task.verified`/`run.end` menandai T1 `stale` (state kartu bergantung hasil test terakhir).
4. Sapuan ringan di tick `centralAutonomy` (sudah ada) untuk project aktif; project tidur tidak di-scan.
5. Setiap jawaban tool membawa `asOf:{sha,at}` dan `stale:boolean`; instruksi: central wajib menyebut umur data. Batas keras: ≤20k file, ≤512 KB/file, indeks dipecah `await` tiap 200 file agar loop tidak macet; pindah ke `Bun.Worker` bila terukur >200 ms.
Ditolak: `fs.watch` rekursif (FD + noise `node_modules`, perilaku macOS `[BT]`), git hook di repo user (invasif; juga di luar aturan "tanpa hook baru"), polling jam tetap.

### 4.7 Graphify sebagai enricher
Adapter `graphifyEnricher.ts` aktif bila `WEBTERM_KNOWLEDGE_GRAPHIFY=on` **dan** `graphify` ada di PATH **dan** project di-opt-in. Menjalankan `graphify update <root>` dengan timeout 60 s, `nice`, di luar jalur turn; membaca `graphify-out/graph.json` (cek `schema_version`; bila tak dikenal → abaikan) hanya untuk: tetangga file (`path`/`explain`), "god nodes" untuk T1b. `graphify-out/` ditulis ke `<dataDir>/knowledge/<id>/`, bukan ke repo user (meski perlu `[BT]`: apakah CLI mendukung out-dir; bila tidak, jalankan di salinan git-archive). Jangan memakai `hook install`. Jangan menyalin 40 KB report ke prompt.

### 4.8 Jawaban "status project X & apa yang harus dikerjakan" (`project.brief`)
1. Resolve nama→id (fuzzy atas registry; ambigu → tanya balik, jangan menebak).
2. Kumpulkan deterministik, paralel, semua `asOf`: ledger (`projectPortfolio`), agent/node hidup (`/api/control/nodes`: working/waiting/blocked/done + umur status), git (branch, dirty, ahead/behind, worktree), hasil verifikasi terakhir + umurnya (**tidak menjalankan test**), 5 fact memori teratas, `CHANGELOG` head.
3. Aturan perhatian (urut prioritas, tiap aturan = fungsi murni + test): (1) approval pending → manusia perlu bertindak; (2) task `failed`/`blocked` lebih baru dari `verified`; (3) agent `blocked`/`waiting` >10 mnt; (4) pohon dirty tanpa agent berjalan; (5) plan item `pending` siap di-assign; (6) tidak ada plan padahal goal terbuka → `goal.propose`/`plan.propose`; (7) budget ≥80%; (8) branch tertinggal upstream.
4. Keluaran JSON ≤800 token: `{asOf, status, attention:[{rule,evidence,suggestedTool}], next:[…≤3], stale:[…]}`. LLM hanya merangkai kalimat dan menyebut umur data. Tes: runtime mock + fixture DB, nol biaya model.

### 4.9 Flag, batas, urutan kerja
Flag `WEBTERM_KNOWLEDGE=on|off` (default off; daftarkan di `envRegistry.central.ts`). Berkas baru di `src/server/knowledge/` (store, scan, docs, map, fresh, brief; tiap <200 baris, Rule 8) + `central/tools/`. Urutan: (1) registry+`project.discover` (2) scan+kartu+`kb.map/search` (3) `project.brief` (4) `ToolSpec`+`app.search` (5) graphify opsional. Tiap langkah punya test sendiri (Rule 3).

## 5. Risiko & mitigasi
- **Injeksi lewat dokumen repo** → bingkai data, tanpa eksekusi, redaksi, cap ukuran, kutip path.
- **Data basi dipercaya** → `asOf`/`stale` wajib di keluaran; rule "sebut umur".
- **Ledger≠workspace** (project terdaftar tapi folder dipindah) → `kb_project.level='missing'`, brief melaporkan, tidak crash.
- **Beban scan di repo besar** → cap file, pecah `await`, level `light` (hanya docs+tree) bila >20k file.
- **Graphify berubah cepat** → pin versi, cek `schema_version`, fallback ke Lite Map; log query ke `~/.cache` perlu diketahui user (PII judul query).
- **Ringkasan LLM drift** → `source_digest` + `generated_by`; digest beda ⇒ `stale`, tak dipakai sebagai fakta (selaras RND/12 M-provenance).
- **Model lemah + meta-tool** → 6 tool inti native + contoh.

## 6. Dampak ke invarian/keputusan lama
- I1/I9: `knowledge.db` bukan otoritatif; hanya konteks. Fakta penting tetap ledger/git.
- I4 & RND/12: ringkasan modul bukan `fact`; bila mau dipromosikan lewat jalur approval memori (RND/24).
- I10: dokumen repo = data tak tepercaya — diperluas ke seluruh `kb_*`.
- I12: dihindari dengan DB terpisah; **bila** diputuskan menaruh di ledger, perlu migrasi v5 aditif + backup.
- I11: tidak berubah. Tidak ada kebutuhan merevisi I5 dari topik ini.
- `centralPrompt.ts` perlu dipecah (potong JSON 4096 diganti T0 tertata) — koordinasi dengan RND/23.

## 7. Pertanyaan terbuka / butuh keputusan produk
1. Project non-TS (Python/Go/Rust) akan didaftarkan dalam waktu dekat? Ya ⇒ naikkan opsi B/C.
2. Boleh `graphify` ditaruh sebagai dependensi opsional eksternal (Python) di mesin pengguna lain, atau hanya mesin ini?
3. Dokumen mana yang otoritatif bila CLAUDE.md dan AGENTS.md bertentangan?
4. Registry: auto-bootstrap project dari workspace (R0 saran + klik manusia) atau tetap manual?
5. Apakah ringkasan modul oleh LLM murah boleh berjalan otomatis (biaya) atau hanya atas permintaan?

## 8. Yang TIDAK terverifikasi
- Kompat `web-tree-sitter` dengan Bun; dukungan `tools/list_changed` di OpenCode; ketersediaan tool search server-side di jalur OpenCode.
- Graphify v0.9.100: inkremental sungguhan, opsi out-dir; saya hanya menguji 0.9.45 pada salinan `/tmp` (sudah dihapus).
- Waktu validasi `git rev-parse + status` pada repo besar; perilaku `fs.watch` macOS; ukuran `knowledge.db` (perkiraan).
- Aturan presedensi AGENTS.md bersarang; tanggal halaman Aider/Cursor/Anthropic-docs tidak tertera (artikel context engineering bertahun 2025).
- Angka anggaran token (2k/1,5k/800) adalah opini rancangan, belum diukur terhadap model apa pun; estimasi token ≈ char/4 kasar.
- Kualitas retrieval `kb.search` belum dievaluasi; usulan eval: 20 pertanyaan emas atas repo ini, ukur recall@5 dan token per jawaban, dengan runtime mock.
