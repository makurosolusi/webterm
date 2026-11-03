# 24 - CA2: MEMORI PENDEK & PANJANG CENTRAL (ringan, terstruktur, tahan perubahan)

Tanggal: 2026-11-03. Status: **R&D, tidak ada kode diubah**. Melengkapi `RND/12` (jangan diulang; baca dulu).
Label: `[kode]` dibaca dari repo; `[probe]` dijalankan di /tmp; `[terverifikasi]` sumber primer dibaca 2026-11-03; `[belum terverifikasi]` sisanya. WebFetch/WebSearch error (HTTP 400) di sesi ini; sumber web dibaca via `curl` GET read-only, tanpa login.

## 1. Ringkasan rekomendasi (tegas)

1. **Satu tabel `memory` yang ada diperluas (migrasi v5 aditif), bukan sistem memori kedua.** Tambah scope `central`,
   `user`, `global`; kolom `kind`, `stale_after`, `verified_at`, `last_used_at`, `use_count`, `content_hash`, `trust`.
   Tidak ada vector DB, graph DB, atau daemon baru.
2. **Kebenaran = file Markdown berversi (git) untuk fact/preferensi/prosedur; SQLite = indeks + episode + audit yang
   boleh dibuang dan dibangun ulang.** Embedding disimpan per `model_id` di tabel terpisah, sehingga ganti model =
   tambah baris, bukan migrasi data.
3. **Retrieval MVP = FTS5 dua tokenizer (`unicode61` + `trigram`) + query yang disusun oleh agent sendiri via tool
   `memory.search`.** Bukti `[probe]`: `unicode61` tidak menemukan "suka" dari "menyukai" (0 hasil); `trigram` menemukan
   substring. Bahasa Indonesia berimbuhan = alasan utama, bukan parafrase umum. Embedding: opsional, brute-force
   cosine di JS (10.000 vektor x 384 dim = **16 ms** `[probe]`), bukan `sqlite-vec` dulu.
4. **Revisi I4 (central tidak menulis fact):** central boleh (a) menulis `claim` di scope `central`, (b) menulis
   `fact` scope `user` **hanya** dengan atestasi kutipan-verbatim dari pesan manusia ter-autentikasi (server cek
   substring di `central_message`), (c) **mengusulkan** promosi lainnya lewat approval manusia. Fact project tetap
   manusia/orchestrator dengan bukti server.
5. **Konsolidasi harian deterministik (dedupe hash, dekay, TTL, deteksi key-bentrok); LLM hanya mengusulkan**
   (merge/kontradiksi) ke antrean approval. Maks 1 panggilan LLM konsolidasi / project / hari.

## 2. Temuan + bukti

### 2.1 Kondisi kode (fakta)
- Skema: `memory(... UNIQUE(project_id,scope,key))`, scope bebas-teks tanpa CHECK, `memory_fts` unicode61 external-content
  `[kode: ledgerSchemaV1.ts:126-152]`. Migrasi terakhir v4; v5 berikutnya `[kode: ledgerSchema.ts:16-23]`.
- **Bug unik-NULL:** `project_id` NULL membuat UNIQUE tidak menolak duplikat `[probe: 2 baris (NULL,'user','a') masuk]`.
  Scope `user`/`central` tanpa project akan bocor duplikat kecuali ditambah indeks unik ekspresi
  `(COALESCE(project_id,''),scope,key)`. Hari ini aman hanya karena `claimMemory` mewajibkan projectId
  `[kode: memoryWrite.ts:88]`.
- Aktor: `human|orchestrator|worker` `[kode: memoryModel.ts:31]`; scope `project|scratch|core` `[kode: memoryModel.ts:26]`.
- Pencarian: query diubah jadi `"t1" OR "t2"...`, `status='fact'`, `superseded_at IS NULL`, `bm25`
  `[kode: memoryCore.ts:222-232, memorySearch.ts:31-52]`. Satu tokenizer, tanpa stemming; tidak ada recency/importance.
- **Titik pasang central:** `buildMemoryContext` dipanggil di `turnService.ts:179-180` di balik
  `WEBTERM_CENTRAL_MEMORY`. Ia **return '' untuk conversation global** `[kode: contextBuilder.ts:22]`, jadi
  `central:global` tidak pernah dapat memori; query = teks mentah pesan; batas 6 fakta/2048 char/300 char per body
  (~500 token, jauh di bawah usulan RND/12 4.000 token). Blok `catch { return '' }` `[kode: contextBuilder.ts:41-43]`
  menelan error diam-diam (pelanggaran Rule 11; kegagalan memori tak terlihat). Central tidak punya tool memori sama sekali.
- File: frontmatter JSON **tanpa field versi format** `[kode: memoryFileRender.ts:60-100, grep version/schema kosong]`;
  path `<project>/<scope>/<key>.md` `[kode: memoryFilePath.ts:55]`; `core` tidak file-backed
  `[kode: memoryFileRender.ts:73-75]`. Perubahan format kelak tidak bisa dideteksi, ini risiko "tahan perubahan" nomor 1.
- Transkrip sudah ada di `central_message/turn/event` `[kode: ledgerSchemaV4.ts:21-45]`; memori tidak menyalinnya.

### 2.2 Probe lingkungan (SQLite di Bun macOS)
- Bun 1.4.2 arm64: SQLite bawaan sistem macOS **3.43.2, compile option `OMIT_LOAD_EXTENSION`**; `db.loadExtension()` error
  "does not support dynamic extension loading". FTS5 + tokenizer `trigram` + `porter` tersedia `[probe]`.
- `Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib')` -> SQLite 3.53.4 tanpa OMIT_LOAD_EXTENSION;
  `loadExtension` lalu mencoba `dlopen` (gagal hanya karena path palsu) `[probe]`. Docs Bun: panggil **sebelum
  membuat `Database` apa pun**, hanya berefek di macOS, di OS lain statis/no-op `[terverifikasi]`
  https://bun.sh/docs/api/sqlite (diakses 2026-11-03). Konsekuensi: harus dipanggil di entry server sebelum
  `db.ts`/ledger membuka DB, dan butuh Homebrew sqlite di mesin user (dependensi eksternal, tidak ada di repo
  `[kode: grep setCustomSQLite = 0]`). **Memuat `vec0` sungguhan TIDAK diuji** (tak boleh install).
- `sqlite-vec`: rilis stabil terakhir **v0.1.9 (2026-03-31)**; alpha 0.1.10-alpha.4 (2026-05-18); repo terakhir
  di-push 2026-05-18; Apache-2.0; paket npm punya binari `darwin-arm64` `[terverifikasi]` GitHub API + registry npm,
  2026-11-03. Masih 0.x (breaking change mungkin).

### 2.3 Survei sistem memori (2026)
| Sistem | Fakta yang relevan | Diambil / ditolak |
|---|---|---|
| Mem0 (v2.2.1, 2026-09-25; Apache-2.0; push 2026-10-30) | Algoritma April 2026: **ADD-only extraction** (tanpa UPDATE/DELETE), entity linking, retrieval semantic+BM25+entity; skor benchmark dari **platform terkelola dengan optimasi proprietari** `[terverifikasi]` https://github.com/mem0ai/mem0 | Ambil: tidak menimpa (= supersede kita), fusi sinyal. Tolak: LLM tiap tulis, benchmark vendor |
| Letta (0.16.8, 2026-05-14; Letta Code) | Agent menulis ulang memori/skill sendiri, "dreaming" periodik, channel Telegram/Slack/Discord `[terverifikasi sebagian]` README letta-code; detail dreaming/MemFS `[belum terverifikasi]` | Ambil: konsolidasi periodik di luar chat. Tolak: edit memori inti tanpa gerbang |
| Zep/Graphiti (v0.31.2, 2026-10-20) | Graf temporal + provenance; backend Neo4j/FalkorDB/Kuzu/Neptune `[terverifikasi]` README | Tolak: server graf. Ambil: validitas temporal + provenance sebagai kolom biasa |
| Cognee (v1.6.6, 2026-10-29) | Memori graf self-host, lokal tanpa API key `[terverifikasi]` README | Tolak: Python, besar |
| A-MEM / FlexA-Mem | Catatan tertaut; FlexA-Mem (Okt 2026) memakai catatan tertaut sebagai riwayat terkompresi `[terverifikasi README]`; klaim hasil `[belum terverifikasi]` | Ambil: kolom `links` ringan |
| Anthropic memory tool | Direktori `/memories` client-side, baca saat mulai tugas; app wajib tolak path traversal, batasi ukuran, saring data sensitif `[terverifikasi]` https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool | Ambil pola file+JIT; tak dipakai langsung (runtime OpenCode) |
| Claude Code auto memory | `MEMORY.md` indeks (satu baris/memori, 200 baris/25KB pertama dimuat) + file topik; dibagi antar worktree `[terverifikasi]` https://code.claude.com/docs/en/memory | **Ambil**: indeks kecil tetap + topik di-pull = blok pinned |

## 3. Arsitektur final

### 3.1 Lapisan
| Lapisan | Isi | Penyimpanan | Umur |
|---|---|---|---|
| L0 Working (per turn) | prompt rakitan + hasil `memory.search` turn ini | memori proses; `central_turn.partial_text` | 1 turn |
| L1 Session | ringkasan bergulir per conversation (format di RND/23) | claim `scope=central`, key `session.<convId>.summary`, 1 baris di-supersede tiap kompaksi | 30-90 hari |
| L2 Episodik | pelajaran dari run/task/keputusan ("X gagal karena Y") berisi **penunjuk** ke ledger (`run:<id>`), bukan salinan | claim, `kind=episode` | TTL 90 hari kecuali dipromosikan |
| L3 Semantik | fakta stabil: keputusan, state-tak-terturunkan, preferensi, topologi | fact + file Markdown | sampai diganti |
| L4 Prosedural | runbook, perintah test, konvensi | fact `kind=procedure` + penunjuk ke `CLAUDE.md`/skill | versi git |
Jangan simpan yang bisa diturunkan (RND/12 §3); prosedural proyek hanya penunjuk + hash ke `CLAUDE.md` agar stale terdeteksi.

### 3.2 Skema v5 (aditif, idempoten, `IF NOT EXISTS`/guard ALTER seperti `applyV4`)
```
ALTER TABLE memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';       -- fact|preference|decision|procedure|episode|summary
ALTER TABLE memory ADD COLUMN trust TEXT NOT NULL DEFAULT 'agent';     -- human|attested|agent|external
ALTER TABLE memory ADD COLUMN content_hash TEXT;                       -- sha256(norm(title+body)); backfill saat rebuild
ALTER TABLE memory ADD COLUMN stale_after INTEGER;                     -- epoch-ms, NULL = tak kedaluwarsa
ALTER TABLE memory ADD COLUMN verified_at INTEGER;
ALTER TABLE memory ADD COLUMN last_used_at INTEGER;                    -- diupdate batch, bukan per baca
ALTER TABLE memory ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory ADD COLUMN links_json TEXT CHECK (links_json IS NULL OR json_valid(links_json)); -- [{id,rel}]
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_key ON memory(COALESCE(project_id,''), scope, key);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(title, body, content='memory', content_rowid='rowid', tokenize='trigram');
-- trigger ai/ad/au sama seperti memory_fts
CREATE TABLE IF NOT EXISTS memory_embedding(
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, dim INTEGER NOT NULL, content_hash TEXT NOT NULL, vec BLOB NOT NULL,
  PRIMARY KEY (memory_id, model_id));
```
`scope` diperluas di kode (`MEMORY_SCOPES` + `central|user|global`); `core` tetap human-only. Backfill: baris `fact` lama -> `trust='human'`, sisanya default `agent`. Backup sebelum migrasi (I12).

### 3.3 File sebagai sumber kebenaran (tahan perubahan)
- Root `WEBTERM_MEMORY_DIR` `[kode: envRegistry.platform.ts:15]`; tambah `FORMAT` dan `formatVersion` di frontmatter. Parser baca v1 (tanpa field) dan v2; penulis selalu v2; migrasi file = skrip idempoten satu commit.
- Layout: `projects/<id>/<kind>/<key>.md`, `user/<key>.md`, `global/<key>.md`, `INDEX.md` per scope (dibangkitkan, satu baris
  per memori, ~200 baris maks, meniru `MEMORY.md` Claude Code). `INDEX.md` adalah blok **pinned** prompt (<=2.000 token).
- Yang **bukan** di file: claim/episode/summary (SQLite saja; hilang = tidak apa), `memory_event` (audit; backup DB).
- Outbox ekspor, tombstone supersede, rebuild terkunci: **RND/12 §6** (belum ada; prasyarat sebelum central menulis fact). Konten lewat `redactSecrets` sebelum tulis.

### 3.4 Retrieval
1. Filter keras: scope diizinkan konteks, `status='fact'` (atau `claim` scope `central` berlabel `unverified` hanya untuk
   central, tidak pernah ke worker), `superseded_at IS NULL`, belum `stale_after`.
2. Kandidat: `memory_fts` (unicode61, query AND dulu lalu OR bila <3 hasil; ganti OR-saja saat ini yang over-recall
   `[kode: memoryCore.ts:231]`) UNION `memory_fts_tri` (query >=3 huruf) top 30 masing-masing; bila embedding aktif +50.
3. Fusi RRF (k=60), lalu `score = 0.55*rrf + 0.20*recency + 0.15*importance + 0.10*scope_boost - 0.20*stale` (bobot RND/12 §4.2;
   konstanta bernama). `importance` dari `kind` (decision/preference > episode), bukan nilai LLM.
4. **Agent menyusun query sendiri** lewat `memory.search({query, scope?, kind?, limit<=8})`; prompt mengajarkan 2-3 variasi
   kata (akar kata + sinonim). Ini menutup celah morfologi tanpa infrastruktur dan jalan di model murah.
5. Pack: pinned `INDEX.md` <=2.000 token + hasil <=4.000 token; tiap hasil `id|scope|kind|trust|updated|source` + body <=300 char
   + "ambil penuh dengan `memory.get(id)`". Dibungkus label data-bukan-instruksi (I10) `[kode: centralPrompt.ts:5,18]`.
6. Global tanpa project: hapus `return ''` untuk global; ambil `scope in (user, global, central)` + ringkasan portfolio.
   Conversation `central:project:<id>`: tambah scope user/global ke fakta project.
7. `last_used_at/use_count` ditulis batch di akhir turn.

### 3.5 Embedding (opsional, tahap 2)
- Sumber: endpoint OpenAI-compatible `POST /v1/embeddings` yang dikonfigurasi (`WEBTERM_EMBED_URL/MODEL` - nama usulan);
  kompatibel Ollama/OpenRouter dll `[belum terverifikasi per provider]`. Tanpa konfigurasi = mati; FTS saja.
- Simpan `Float32Array` BLOB di `memory_embedding` per `model_id`; kueri = scan brute-force (16 ms/10k `[probe]`, data acak,
  mesin dev). Ganti model: set `active_embedding_model`, backfill pelan (batch 50, hanya `content_hash` yang berubah),
  hapus model lama setelah evaluasi lulus. **Tidak ada kehilangan data**; seluruh tabel dapat dibuang & dibangun dari teks.
- `sqlite-vec` ditunda: pra-1.0, butuh `setCustomSQLite` + Homebrew di macOS, tidak diuji di sini. Naik kelas bila >50k
  vektor atau scan >100 ms.

## 4. Kebijakan tulis (revisi I4)
| Jalur | Siapa | Syarat server | Hasil |
|---|---|---|---|
| `memory.remember` | central | key kanonik `<domain>.<subjek>.<predikat>`, body <=1.200 char, scan secret/PII, rate <=20/jam | `claim` scope `central`, trust `agent` |
| `memory.remember_user` | central | argumen `quote` harus **substring verbatim** dari pesan `role=human` di conversation aktif (atau pesan Telegram dari pengirim ter-pairing); `source_ref=messageId` | `fact` scope `user`, trust `attested`, undo 1 klik |
| `memory.propose` | central | menunjuk `memory.id` claim + alasan | item approval (R2); setuju -> `promoteMemory` oleh `human:api` |
| `memory.forget` | central/human | central hanya mengusulkan; human menghapus | lihat §5.4 |
| promosi project fact | human/orchestrator | bukti server `evidence_id` (RND/12 §5.2) | tidak berubah |
Trust: `external` (web/tool/pesan pihak ketiga) tidak boleh jadi `fact` tanpa manusia. Isi memori tidak pernah memicu tool
(I10). Kutipan-verbatim murah (satu `includes`) dan menutup kasus central mengarang preferensi.
Kelemahan: tak menangkap preferensi tersirat (tetap claim).

## 5. Konsolidasi, dekay, konflik, penghapusan
1. **Dedupe**: `content_hash` sama -> tolak/merge ke yang lama; key sama beda isi -> alur supersede (rantai `supersedes`
   sudah ada); hampir-duplikat (Jaccard trigram >=0.8) -> diusulkan merge, bukan otomatis.
2. **Dekay (tanpa menghapus fact)**: recency half-life 14 hari state / 90 hari pelajaran / tak hingga untuk
   `preference|decision`; claim `episode`/`summary` yang kedaluwarsa -> `status='superseded'`, `archived` (event dicatat).
   Fact tidak pernah dihapus otomatis, hanya `stale_after` lewat -> skor turun + penanda "perlu verifikasi".
3. **Stale**: `kind=procedure`/penunjuk menyimpan hash file sumber; job harian bandingkan -> set `stale_after=now`.
4. **Kontradiksi**: deteksi deterministik (key sama; atau `links rel=contradicts` dari agent). Hasil: kedua baris tampil
   dengan label `konflik`, central wajib menanyakan manusia; tidak pernah diselesaikan diam-diam.
5. **Penghapusan/PII**: `memory.forget` = hapus file + baris + embedding + FTS (trigger) dalam satu transaksi, tulis
   event `forgotten` **tanpa isi**. **Git menyimpan riwayat**: scope `user` karena itu ditaruh di direktori yang
   di-`.gitignore` (tetap file, ikut backup snapshot, tidak masuk git) agar hapus sungguh hilang; fact project di git
   (hapus = commit; pembersihan riwayat manual). Keputusan produk terbuka di §7.
6. **Konsolidasi LLM** (opsional, flag): input claim `episode` 7 hari (<=3.000 token) -> JSON usulan `{merge[],lesson[],contradiction[]}` ke approval yang ada; tak menulis fact. Pemicu: >=10 episode baru atau idle malam; 1 panggilan/project/hari (cost guard RND/23).
7. **Rebuild**: `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` untuk kedua FTS `[kode: ledgerSchemaV1.ts:145]`;
   embedding dibangun ulang dari `content_hash`; file adalah sumber saat konflik (files-win, RND/12 §6).

## 6. Anggaran ukuran & evaluasi
- Batas keras: body <=1.200 char; project <=500 fact aktif (lewat -> konsolidasi/usul arsip); user+global <=200;
  episode <=2.000 baris/project (TTL). Estimasi 10.000 baris: body ~1 KB + dua FTS ~3 KB + vektor 384 dim 1,5 KB = **~55 MB**
  `[estimasi, belum diukur]`; DB ledger/WAL tetap kecil. File fact ~1,5 KB/berkas.
- **Evaluasi** (harness pertama, sebelum embedding): `RND/12 §7` + tambahan: (a) set 60 query Indonesia/Inggris campuran dari
  keputusan nyata, termasuk 20 varian morfologi ("menyukai/suka", "dipush/push"); gate: recall@10 trigram+unicode61 >=0.80,
  paraphrase >=0.60 sebelum embedding dipertimbangkan; (b) uji migrasi: DB v4 -> v5 -> rebuild dari file -> hash isi identik;
  (c) uji format: file v1 dan v2 dibaca sama; (d) uji ganti model: isi `memory_embedding` model A, tambah B, hasil A tetap
  utuh; (e) kutipan palsu ditolak; (f) canary secret/PII tak ke file/prompt; (g) `central:global` dapat memori. DB in-memory +
  runtime mock (tanpa model berbayar). Metrik (jumlah hasil, token, p95 ms) dicatat di log/`memory_event`.

## 7. Opsi ditolak
- Vector/graph DB, Mem0, Cognee, Graphiti: server/Python tambahan tanpa keunggulan terukur di <=10k memori (Rule 10).
- `sqlite-vec` sekarang: pra-1.0 + beban `setCustomSQLite`/Homebrew; scan JS cukup. Transkrip sebagai memori: duplikasi ledger, context rot.
- Agent mengedit file memori langsung: melewati redaksi, atestasi, audit. LLM menilai "penting": tak deterministik (pakai `kind` + `use_count`).

## 8. Dampak ke invarian
- **I4 direvisi** jadi: central menulis `claim` (central/scratch) dan `fact` scope `user` hanya dengan atestasi kutipan; tidak
  menulis fact project/`core`. **I10** tetap (memori = data). **I12** berlaku untuk v5. Perlu `MemoryActorKind='central'` (RND/12 §5).
- Rule 8: `memoryWrite.ts` 284 dan `memoryCore.ts` 249 baris `[kode: wc -l]` mendekati batas 300; tambahan = modul baru (`memoryRetrieve.ts`, `memoryConsolidate.ts`, `memoryEmbed.ts`).

## 9. Risiko & mitigasi
Poisoning kanal/web: trust `external` tak jadi fact, kutipan hanya dari manusia ter-pairing. Central mengarang preferensi: atestasi verbatim + undo + tampilkan "diingat: ...". Format berubah diam-diam: `formatVersion` + uji migrasi. Ukuran meledak: batas §6 + TTL. Hapus tak tuntas di git: `user` di luar git. Kegagalan tak terlihat: log `warn` tanpa isi, bukan `catch { return '' }`. Query Indonesia gagal: trigram + gate evaluasi.

## 10. Urutan implementasi
M0: perbaiki `central:global`, OR-saja, log error builder, tool `memory.search/get` read-only. M1: migrasi v5 + scope/aktor `central` + `memory.remember` + `formatVersion`. M2: atestasi `remember_user` + `INDEX.md` + harness eval. M3: outbox/rebuild terkunci (RND/12 §6) + konsolidasi deterministik. M4 (bila gate lulus): embedding brute-force, lalu konsolidasi LLM. Tiap tahap branch sendiri + test.

## 11. Pertanyaan terbuka (butuh keputusan produk)
1. Scope `user` di luar git (hapus sungguh hilang, tanpa riwayat) atau di git (riwayat, hapus tak tuntas)? Rekomendasi: di luar git.
2. Boleh central menulis `fact` scope `user` dengan atestasi, atau semua tetap lewat approval? Rekomendasi: boleh, dengan undo.
3. Provider embedding apa yang user punya/izinkan (gratis/lokal/berbayar)? Menentukan apakah tahap M4 dikerjakan.
4. Memori `user` dibagi lintas channel (web + Telegram)? Rekomendasi: ya, per user.

## 12. Yang TIDAK terverifikasi
- Memuat `sqlite-vec` (`vec0`) di Bun/macOS: **belum diuji** (hanya terbukti SQLite sistem melarang, Homebrew mengizinkan).
- Angka 16 ms = data acak, satu mesin dev; ukuran 55 MB = estimasi; ambang recall/precision = usulan.
- Perilaku Letta "dreaming"/MemFS, hasil FlexA-Mem, cap harga/detail ChatGPT & Gemini memory: tidak dibaca dari sumber primer.
- Kompatibilitas `/v1/embeddings` provider (Ollama/OpenRouter) tidak diuji.
- Benchmark Mem0 = klaim vendor. Test repo tidak dijalankan; klaim kode = hasil membaca file.

## Sumber tambahan (diakses 2026-11-03)
bun.sh/docs/api/sqlite; api.github.com/repos/{asg017/sqlite-vec,mem0ai/mem0,getzep/graphiti,topoteretes/cognee,letta-ai/letta}/releases; registry.npmjs.org/sqlite-vec; raw README graphiti/cognee/letta-code/WujiangXu/A-mem; URL lain di tabel §2.3.
