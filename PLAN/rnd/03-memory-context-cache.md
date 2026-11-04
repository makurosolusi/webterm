# R&D 03: Memory, Konteks, Cache, Kontinuitas (state of the art, Nov 2026)

Worker: wkr-rnd-memory-43 (read-only). Riset web lewat ego-browser (berhasil, tanpa fallback). Kutipan angka diambil langsung dari halaman sumber pada 2026-11-04.

## 0. Posisi webterm hari ini (baseline, dibaca dari kode)

Supaya rekomendasi tidak mengulang yang sudah ada:

- **Memory**: tabel v7 di ledger SQLite + FTS ganda (unicode61 + trigram) difusikan RRF (`src/server/memory/memoryHybrid.ts`), blok memory per turn dengan budget 2500 token, label "unverified" untuk klaim agent, redaksi secret (`memoryBlock.ts`). Konsolidasi deterministik: dedupe hash + arsip klaim kedaluwarsa jadi `superseded`, tanpa LLM (`memoryConsolidate.ts`). Tabel `memory_embedding` sudah ada tapi kosong: `TODO(ca2-08)` leg ketiga RRF menunggu embed client.
- **Konteks**: checkpoint + `rollingSummarize` yang **deterministik** (ekor narasi + kepala 8 pesan terakhir, belum ada summarizer LLM), rotasi sesi di 70% window, tolak di 85% (`central/context/`).
- **Code index**: "Lite Map" `knowledge.db`: import in-degree + FTS + `kb.search`/`kb.map` (`src/server/knowledge/`). Mirip versi kecil repo-map Aider, tanpa tree-sitter/simbol.
- **Runtime**: Central menjalankan `claude -p` dengan `--resume`/`--session-id`, jadi prompt caching dikelola Claude Code, bukan oleh webterm memasang `cache_control` sendiri.
- **Cross-node**: skill `webterm-linked-context` (transcript/summary/scrollback node yang dikabel), catatan `[webterm]` ke sesi idle saat kabel berubah.

Jadi fondasinya sudah benar (ledger, FTS, RRF, provenance, redaksi). Yang kurang ada di **kecerdasan lapisan atas**: summarizer yang benar-benar merangkum, konsolidasi/refleksi saat idle, fakta bertemporal, memory yang dibagi antar node, dan disiplin prefix cache.

## 1. Agent memory

### Yang terbukti
- **Claude Code memory** ([docs](https://code.claude.com/docs/en/memory)): dua lapis, CLAUDE.md (aturan, ditulis manusia) dan auto memory (`~/.claude/projects/<p>/memory/`, `MEMORY.md` index satu baris per memory + satu file per topik). Yang dimuat tiap sesi cuma **200 baris pertama atau 25KB** dari index; isi topik dibaca on-demand. Saran resmi: CLAUDE.md < 200 baris, aturan per-path di `.claude/rules/` yang hanya dimuat saat menyentuh file cocok. Catatan penting: `@import` **tidak** menghemat konteks.
- **Claude memory tool** ([docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/memory-tool)): client-side, Claude hanya *meminta* operasi file di `/memories`, aplikasi yang mengeksekusi ke storage miliknya; wajib proteksi path traversal; dirancang dipasangkan dengan context editing dan compaction.
- **Letta/MemGPT** ([memory blocks](https://docs.letta.com/guides/agents/memory-blocks)): blok berlabel dengan `description` + `limit` karakter, selalu ada di konteks, bisa **dibagi beberapa agent** ("update once, visible everywhere") dan bisa `read_only`. **Sleep-time compute** ([blog](https://www.letta.com/blog/sleep-time-compute)): agent utama *tidak* diberi tool edit core memory; agent terpisah yang mengelola memory saat downtime. Ini memisahkan percakapan dari pemeliharaan memory.
- **Mem0** ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)): ekstraksi + update fakta (ADD/UPDATE/DELETE/NOOP), varian graph. Di LOCOMO: p95 latency **91% lebih rendah** dan **>90% hemat token** dibanding full-context. Ini angka vendor, tapi arahnya konsisten dengan riset lain.
- **Zep/Graphiti** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956), [repo](https://github.com/getzep/graphiti)): knowledge graph **bi-temporal**. Tiap fakta punya jendela validitas; saat info berubah, fakta lama di-*invalidate*, tidak dihapus. Tiap fakta bisa dilacak ke episode sumbernya. Retrieval hibrid: embedding + BM25 + traversal graph, sub-detik, tanpa summarization LLM saat query. DMR 94,8% vs MemGPT 93,4%; LongMemEval akurasi naik hingga 18,5%, latency turun 90%.
- **LangGraph/LangMem** ([konsep](https://langchain-ai.github.io/langgraph/concepts/memory/)): taksonomi CoALA. **Semantic** (fakta: profil/koleksi), **episodic** (pengalaman/contoh few-shot), **procedural** (aturan/prompt yang bisa direvisi sendiri). Dua mode tulis: **hot path** (agent memutuskan sebelum menjawab, langsung tapi menambah latency) vs **background** (async, tidak mengganggu, risiko telat).
- **ChatGPT memory** ([FAQ](https://help.openai.com/en/articles/8590148-memory-faq)): saved memories eksplisit + "reference chat history" implisit, ringkasan memory yang bisa dikoreksi user, tombol "Don't mention this again", **temporary chat** yang tidak membaca/menulis memory.
- **Cursor**: halaman "memories" kini mengarah ke **Rules** (`.cursor/rules`, AGENTS.md). Fitur memory otomatis tidak lagi tampil sebagai fitur tersendiri. Pelajaran: memory implisit tanpa kurasi sulit dipertahankan; rules eksplisit yang bertahan.

### Tiru di webterm
1. **Tiga jenis memory sebagai kolom `kind`**: `semantic` (fakta user/proyek), `episodic` (ringkasan sesi/tugas selesai + hasil), `procedural` (aturan "lakukan/jangan" dari feedback). Dipisah karena retrieval-nya beda: procedural selalu dimuat (seperti CLAUDE.md), semantic lewat RRF, episodic dicari saat tugas mirip.
2. **Validitas temporal ala Graphiti, di SQLite, tanpa graph DB**: tambah `valid_from`, `valid_to`, `superseded_by`, `source_event_id`. "Kontradiksi" menutup `valid_to` fakta lama. `superseded` yang sudah ada tinggal diangkat jadi model ini. Query default "yang berlaku sekarang", dan bisa "per tanggal X".
3. **Sleep-time consolidator**: job idle (Central sedang tidak sibuk / malam) yang membaca event ledger + transcript node, lalu mengusulkan ADD/UPDATE/INVALIDATE ala Mem0. Hasil masuk sebagai `unverified` sampai disentuh lagi atau diterima user. Agent percakapan tidak perlu menulis memory di hot path, kecuali `remember` eksplisit.
4. **Shared memory blocks untuk node**: blok ber-label (mis. `project:webterm/conventions`, `goal:current`) yang di-render ke tiap node agent saat spawn/kabel berubah; read-only untuk node, read-write untuk Central. Ini setara blok shared Letta, memakai mekanisme catatan `[webterm]` yang sudah ada.
5. **Kontrol ala ChatGPT di UI dan Telegram**: "lupakan ini", "jangan sebut lagi" (supresi tanpa hapus), mode sesi *incognito* (tidak baca/tulis memory), panel "apa yang kamu ingat" yang bisa dikoreksi.

### Pitfall
- Memory implisit yang menumpuk jadi noise dan bisa terasa menyeramkan. Wajibkan provenance + label "unverified" (sudah ada, pertahankan).
- **Memory poisoning**: isi web/terminal yang memuat "ingat bahwa…" bisa ditanam lewat browser node. Konsolidator hanya boleh mengekstrak dari pesan user atau hasil tool yang ditandai trusted; konten browser masuk sebagai episodic dengan sumber, bukan semantic/procedural.
- Hot-path write menambah latency dan sering salah; serahkan ke background kecuali perintah eksplisit.

## 2. Context engineering

### Yang terbukti
- **Anthropic, effective context engineering** ([artikel](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)): tiga tuas untuk horizon panjang: **compaction**, **structured note-taking**, **sub-agent** (sub-agent eksplorasi mengembalikan ringkasan 1.000–2.000 token). Pendekatan **just-in-time**: simpan *identifier* ringan (path, query tersimpan, URL), muat isinya lewat tool saat perlu. Untuk prompt compaction: maksimalkan recall dulu, baru pangkas.
- **Context editing API** ([docs](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)): `clear_tool_uses_20250919` (trigger default 100k input token, `keep` N tool use terakhir, `clear_at_least` supaya tidak membuang cache untuk keuntungan kecil, `exclude_tools`), `clear_thinking_20251015`. Server-side **compaction** ([docs](https://docs.anthropic.com/en/docs/build-with-claude/compaction)) kini direkomendasikan di atas compaction client-side.
- **Code context**: Aider [repo map](https://aider.chat/docs/repomap.html): tree-sitter, simbol, graph rank file berdasar dependensi, budget default `--map-tokens` 1k yang membesar saat chat belum punya file. **Cursor** ([indexing](https://cursor.com/docs/context/codebase-indexing)) kini mengandalkan **Instant Grep** lokal (regex, index di mesin) dan **Explore subagent**. Halaman resminya menyatakan Cursor *tidak* menyimpan embedding codebase untuk search. Pergeseran industri 2025–2026: agentic search (grep + baca file + subagent) mengalahkan RAG embedding untuk kode. Embedding tetap berguna untuk teks bebas (memory, docs, percakapan).
- LSP sebagai sumber konteks (definisi/referensi/diagnostik) kini tersedia sebagai tool di Claude Code, dan lebih presisi daripada FTS untuk "siapa memanggil X".

### Tiru di webterm
1. **Summarizer checkpoint sungguhan**: ganti `rollingSummarize` deterministik dengan summarizer LLM (model kecil, background) memakai template terstruktur: tujuan, keputusan + alasan, file yang disentuh, status task, pertanyaan terbuka, langkah berikut. Fallback ke deterministik saat gagal. Ini celah terbesar yang menahan kualitas rotasi 70%.
2. **Kartu identifier, bukan dump**: blok konteks Central berisi daftar referensi (node id, path, goal id, ledger event id, URL tab browser) + satu baris status; isi diambil on-demand via tool. Ini sejalan dengan budget 2500 token yang sudah ada.
3. **Upgrade Lite Map → repo-map Aider-style**: tambah simbol (tree-sitter, atau `tsc`/LSP untuk TS) dan PageRank personal yang di-bias ke file yang sedang disentuh node aktif. In-degree sudah ada, jadi ini langkah naik yang wajar.
4. **Explore sub-agent untuk Central**: pencarian lebar dilakukan sesi terpisah yang hanya mengembalikan ringkasan, supaya konteks Central bersih.
5. **Awareness feed**: event kanvas (node spawn/exit, kabel, status agent, error terminal) masuk sebagai baris ringkas berstempel waktu ke "situational block" yang dibatasi N terakhir. Ini kesadaran, bukan memory: TTL pendek.

### Pitfall
- Compaction agresif menghilangkan detail kecil yang belakangan penting. Simpan transcript asli di ledger dan beri tool "buka detail checkpoint X".
- Embedding untuk kode: mahal di-maintain, bocor privasi, dan kalah dari grep+LSP. Jangan bangun vector index kode.
- Instruksi kontradiktif di blok yang dimuat otomatis membuat model memilih secara acak (catatan docs Claude Code). Konsolidator harus mendeteksi dan menutup fakta yang bertentangan.

## 3. Caching

### Yang terbukti ([prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching))
- Cache menyimpan **seluruh prefix** dengan urutan tools → system → messages. Ada **automatic caching** (satu `cache_control` top-level, breakpoint berjalan maju) dan maksimal **4 breakpoint** eksplisit.
- TTL default 5 menit, **1 jam** dengan `"ttl":"1h"` (write 2x harga input dasar). Contoh Opus 5.5: input $4, write 5m $5, write 1h $8, **hit $0.20/MTok** (sekitar 20x lebih murah dari input).
- **Lookback 20 blok**: sistem hanya memeriksa 20 posisi ke belakang dari breakpoint. Satu turn yang menambah >20 blok akan miss. Konten yang berubah (timestamp, konteks per-request) harus diletakkan **setelah** breakpoint.
- Minimum cacheable 512 token untuk model generasi 5.
- Context editing bisa membatalkan cache; karena itu ada `clear_at_least`.

### Semantic/tool/embedding cache
- **Semantic cache** (GPTCache, cache gateway) cocok untuk FAQ berulang, tapi berisiko untuk agent: pertanyaan mirip dengan state berbeda menghasilkan jawaban basi. Untuk webterm, yang aman adalah cache **deterministik** berbasis hash input.
- **Tool-result cache**: kunci = (tool, argumen ternormalisasi, versi sumber: mtime/git HEAD/ledger seq). Hasil mahal (scan knowledge, ringkasan transcript node, snapshot halaman) dipakai ulang sampai sumbernya berubah.
- **Embedding cache**: kunci = sha256(teks ternormalisasi + model id). Tidak pernah dihitung ulang untuk teks yang sama. Ini menyelesaikan biaya `memory_embedding` saat TODO ca2-08 dikerjakan.
- **Incremental indexing**: re-index hanya file yang hash/mtime-nya berubah (Cursor memakai pola Merkle di generasi sebelumnya). `knowledgeFresh.ts` sudah mengarah ke sini; pastikan granularitas per file.

### Tiru di webterm
1. **Disiplin prefix stabil** untuk prompt Central: urutan tetap = aturan/persona → procedural memory → shared blocks → (breakpoint) → semantic memory hasil retrieval → situational feed → pesan. Jangan menaruh jam/timestamp di system prompt. Karena runtime-nya `claude -p --resume`, yang dikendalikan webterm adalah *isi dan urutan* yang disuntikkan. Ukur dari `cache_read_input_tokens` di ledger usage (`ledgerUsage.ts` sudah mencatat usage; tambahkan rasio hit di dashboard).
2. **Keep-warm 1 jam hanya untuk Central** saat ada sesi Telegram aktif (jeda chat manusia sering >5 menit). Node agent biasa tetap 5 menit.
3. **Tabel `tool_cache` dan `embed_cache` di SQLite** dengan kunci hash + versi sumber, TTL, dan batas ukuran (LRU by `last_used`).

### Pitfall
- Satu karakter berubah di awal prefix membuang seluruh cache. Sort deterministik untuk semua daftar (memory, node) di blok yang di-cache.
- Cache 1h tidak sepadan bila hit rate rendah. Putuskan berdasar metrik, jangan menyalakannya global.

## 4. Kontinuitas lintas sesi dan multi-agent

### Yang terbukti
- **Anthropic, harness long-running** ([artikel](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)): agent *initializer* membuat `init.sh`, `claude-progress.txt`, feature list JSON (>200 fitur di contoh mereka), dan commit awal. Tiap sesi berikut membaca progress + git log, mengerjakan **satu** fitur, lalu meninggalkan artefak terstruktur. Masalah yang diatasi: agent "menyatakan menang" terlalu cepat, dan lingkungan ditinggal dalam keadaan rusak.
- Letta shared blocks + sleep-time agent (lihat §1) untuk memory antar agent.
- Sub-agent yang mengembalikan ringkasan terkondensasi (§2).

### Tiru di webterm
1. **Handoff card di ledger** (bukan file bebas): tiap sesi node/Central yang berakhir, dirotasi, atau idle lama menulis kartu: tujuan, selesai, belum, blocker, file, perintah verifikasi, next step. Kartu ini dipakai oleh (a) seed rotasi checkpoint, (b) `webterm-linked-context` mode summary, (c) laporan pagi Telegram.
2. **Resumable plan = goal + task ledger yang sudah ada**, ditambah field `next_action` dan `verify_cmd` per task, ala feature list JSON. Node baru yang dikabel ke goal langsung mendapat "kerjakan satu task berikutnya".
3. **Shared blackboard**: blok `goal:<id>/status` yang ditulis Central dan dibaca semua node yang terhubung (read-only), diperbarui lewat event kabel/status yang sudah ada. Ini mengurangi kebutuhan node membaca transcript node lain.
4. **"Lanjutkan dari kemarin"** di Telegram: Central menyusun ringkasan dari handoff card + episodic memory, bukan dari transcript mentah.

### Pitfall
- Banyak penulis ke satu memory menghasilkan race dan kontradiksi. Satu penulis (Central/konsolidator), node hanya mengusulkan.
- Handoff yang ditulis model bisa mengarang "selesai". Laporan worker fiktif sudah pernah terjadi (memory `worker-laporan-fiktif`). Kartu harus menyertakan bukti yang bisa dicek (`git diff --stat`, exit code test) yang diisi oleh **sistem**, bukan klaim model.

## 5. Privasi, staleness, forgetting

- **Proven**: Graphiti invalidasi tanpa hapus; ChatGPT temporary chat + supresi + hapus dengan propagasi; Claude Code memory machine-local dan transcript dihapus setelah `cleanupPeriodDays`, sementara memory file dikecualikan.
- **Tiru**:
  - Skor kesegaran = recency × frekuensi pakai (`touchMemoryUse` sudah ada) × validitas. Memory yang tidak dipakai N hari turun peringkat, lalu diarsip (bukan dihapus).
  - **Re-verifikasi saat dipakai**: memory yang menyebut path/fungsi/flag dicek keberadaannya (fs/grep) sebelum disuntikkan; kalau hilang, beri label `stale`. Ini pola yang sama dengan system prompt auto-memory Claude Code ("verify before recommending").
  - Redaksi secret sebelum tulis (sudah ada) + kelas PII (email/HP) disimpan ter-mask.
  - Retensi transcript berbeda dari retensi memory; hard-delete hanya atas perintah user, dengan tombstone agar konsolidator tidak menghidupkannya lagi dari transcript lama.
  - Scope ketat project/global/user (sudah di SQL `memoryHybrid`); konten browser tidak boleh naik ke scope global otomatis.
- **Pitfall**: "lupa" yang hanya menghapus baris memory tapi tidak menghapus sumber transcript akan muncul lagi pada konsolidasi berikutnya. Wajib tombstone.

## 6. Rekomendasi berperingkat

Peringkat menimbang dampak ke "asisten yang punya tempat" dibagi biaya; semua memakai fondasi yang sudah ada.

1. **Summarizer checkpoint LLM + handoff card terstruktur di ledger** (§2.1, §4.1). Celah terbesar: rotasi 70% saat ini diberi seed ringkasan deterministik yang hampir tidak merangkum. Satu artefak dipakai di tiga tempat (rotasi, linked-context, Telegram). Bukti hasil (diff/test) diisi sistem.
2. **Sleep-time consolidator ala Mem0/Letta** (§1.3): background, mengusulkan ADD/UPDATE/INVALIDATE dari ledger + transcript, output `unverified`. Mengubah memory dari "diisi manual" menjadi "belajar sendiri" tanpa menambah latency turn.
3. **Validitas temporal + provenance** (`valid_from/valid_to/superseded_by/source_event_id`) (§1.2): murah karena hanya migration kecil di atas `superseded`, dan membuat kontradiksi serta "apa yang berlaku sekarang" bisa dijawab.
4. **Disiplin prefix cache + metrik hit rate + 1h TTL bersyarat untuk Central/Telegram** (§3): penghematan langsung (hit sekitar 20x lebih murah dari input) dan latency turun. Mulai dengan mengukur.
5. **Shared memory blocks / blackboard goal untuk node** (§1.4, §4.3): kesadaran lintas node tanpa membaca transcript mentah; memanfaatkan mekanisme catatan `[webterm]` yang sudah ada.
6. **Tiga jenis memory (`kind`) + procedural selalu dimuat** (§1.1): feedback user ("jangan X") menjadi aturan yang konsisten, bukan sekadar hasil pencarian yang kebetulan muncul.
7. **Embedding leg ketiga untuk memory/percakapan saja + `embed_cache`** (selesaikan TODO ca2-08), **bukan** untuk kode.
8. **Repo-map Aider-style (simbol + PageRank personal) dan Explore sub-agent** untuk Central (§2.3–2.4); LSP bila tersedia.
9. **Kontrol privasi ala ChatGPT** (lupakan / jangan sebut lagi / incognito / panel memory) di UI dan Telegram, dengan tombstone (§5).
10. **Tool-result cache berkunci versi sumber** (§3): kecil, aman, bisa dikerjakan kapan saja.

Jangan: semantic cache untuk jawaban agent (jawaban basi pada state berbeda); vector index codebase (tren industri sudah meninggalkannya); hot-path memory write otomatis di setiap turn.
