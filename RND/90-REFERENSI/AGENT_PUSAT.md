# Agent Pusat untuk webterm: hasil riset, saran, dan kesimpulan

## 1. Judul dan metadata

| | |
|---|---|
| Tanggal | 31 Oktober 2026 |
| Status | Hasil riset, **belum keputusan**. Tidak ada kode yang dibangun. |
| Pembaca | Pemilik repo webterm, yang memutuskan apa yang dibangun |
| Bahan | 9 catatan riset lokal (hierarki + kode lokal, produk, framework, protokol, konteks, keamanan, memori, state, HITL), semua per 31 Okt 2026 |

**Cara membaca label keyakinan** (dipakai pada tiap klaim faktual):

- **[TINGGI]** dibaca langsung dari sumber primer (docs vendor, spec, repo, paper) dan isinya sesuai klaim.
- **[SEDANG]** sumber primer tetapi ditulis vendor/pihak berkepentingan, hanya abstrak/snippet, satu sumber sekunder, atau generalisasi dari kasus sempit.
- **[RENDAH]** snippet pencarian, blog tunggal, opini peneliti, atau data yang belum bisa dicek.

Konvensi lain: **Rekomendasi** dan **Sintesis** menandai opini/rancangan peneliti, bukan fakta dari sumber. "Tidak terverifikasi" berarti tidak berhasil dicek dan tidak boleh dipakai sebagai dasar keputusan.

Daftar isi: 1 Judul, 2 Ringkasan & vonis, 3 Peringatan bukti, 4 Arsitektur, 5 Memori & konteks, 6 State & ledger, 7 Protokol & identitas, 8 Kolaborasi manusia-agent, 9 Keamanan, 10 Peta kesenjangan webterm, 11 Temuan per track, 12 Peta jalan, 13 Keputusan terbuka, 14 Konflik antar-sumber, 15 Tidak terverifikasi, 16 Lampiran sumber.

---

## 2. Ringkasan dan vonis

**Layak? Ya, tetapi dalam bentuk yang lebih sempit dari "satu bos mengatur semua".** Bukti yang ada mendukung hierarki hanya untuk kerja paralel, breadth-first, dan mudah dipecah; hierarki merugikan untuk kerja sekuensial/saling bergantung dan mahal di token ([TINGGI] isi sumber, [SEDANG] generalisasi; lihat bagian 3 dan 11.1).

Vonis (semua butir di bawah = **rekomendasi/sintesis**, kecuali yang diberi label):

1. **Dua tier efektif + manusia.** Orkestrator per-project adalah hub sebenarnya. Worker ada di bawahnya.
2. **Agent pusat = router + indeks memori lintas-project.** Ia tidak memerintah worker secara langsung. Tugasnya: menerima permintaan manusia, memilih/membuat project dan orkestratornya, menjawab pertanyaan lintas-project dari indeks, dan melaporkan.
3. **Control plane tipis milik webterm sendiri.** Kerangka orkestrasi pihak ketiga hanya dipakai di bagian dalam sesi agent, bukan sebagai pemilik hierarki. Alasan: nesting resmi rapuh di semua vendor (bagian 11.3).
4. **Ledger SQLite** (`bun:sqlite`, WAL) sebagai sumber kebenaran state tugas; orkestrator dibuat stateless dan membaca ledger. Tanpa Temporal/Restate sekarang.
5. **Memori = file Markdown di git** (bisa dibaca manusia), dengan **promosi claim -> fact**: worker hanya mengirim claim + bukti, orkestrator project mempromosikannya menjadi fact, manusia menyetujui perubahan inti dan lintas-project.
6. **Kontrak antar-level = HTTP+JSON berbentuk A2A** (task id, status, polling, Agent Card sederhana), bukan A2A penuh. **MCP hanya untuk akses tool/data**, bukan komunikasi antar-agent.
7. **Token berskop per agent** (audience dan skop sempit, TTL pendek, tidak diteruskan ke bawah); spawn hanya oleh orkestrator, depth <= 2, ada cap konkurensi dan biaya.
8. **Verifikasi independen** atas setiap laporan "selesai" (git diff, test, typecheck oleh orkestrator), bukan percaya laporan agent.
9. **Blocker teknis utama:** `Session.send` di webterm hanya punya satu slot subscriber, sehingga klien kedua mencuri stream dari browser manusia (bagian 10). Ini harus diperbaiki sebelum agent dan manusia berbagi sesi.

**Jangan dibangun dulu** (alasan di bagian terkait):

- Engine durable execution (Temporal/Restate/DBOS) dan LangGraph sebagai inti.
- Vector DB / graph DB untuk memori; mulai dari file + indeks sederhana.
- A2A penuh, registry agent publik, AGNTCY, MCP Registry, ketergantungan pada MCP Tasks (masih Beta).
- Hierarki tiga tingkat, spawn rekursif otomatis, Agent Teams Claude Code di produksi (experimental).
- Fitur cloud/PR yang bersaing dengan Claude Projects, Copilot Projects, Factory Workstreams.
- Persetujuan per-aksi (terbukti memicu approval fatigue) dan LLM-judge sebagai verifier utama.

---

## 3. Peringatan bukti (baca sebelum mempercayai angka mana pun)

- Hampir semua sumber primer ditulis **vendor** yang menjual produk terkait (Anthropic, Letta, Mem0, Zep, Temporal, Factory, dll.). Arah bias: melebih-lebihkan manfaat.
- Banyak angka **self-reported** dari eval internal yang tidak dipublikasikan, mis. +90,2% multi-agent research dan +39%/+29%/-84% context editing (bagian 11.1, 11.5, 11.7).
- **Replikasi independen 2026 sedikit.** Contoh langka: audit LoCoMo independen yang menemukan 6,4% answer key salah [SEDANG, belum direplikasi]; paper "false success" (satu paper, belum direplikasi).
- **Tidak ada studi yang membandingkan kedalaman hierarki 2 vs 3** (catatan 1a). Pilihan "dua tier" adalah penalaran dari bukti tidak langsung, bukan hasil studi.
- **Tidak ada studi memori/hierarki/context rot pada model 5.x** (satu-satunya studi context rot independen, Chroma, Jul 2025, memakai 18 LLM generasi lama; MAST juga di atas model lama).
- **Tidak ada post-mortem produksi 2026** untuk hierarki tiga tingkat maupun untuk memori basi/terkontaminasi yang ditemukan; bukti keamanan datang dari paper akademik dan insiden single-agent/supply chain, bukan insiden multi-agent lintas-agent nyata.
- Keterbatasan metode riset: pada track produk, WebSearch/WebFetch tidak bekerja sehingga bantahan hanya dari docs vendor; beberapa temuan di track protokol dan keamanan hanya dari snippet Bing (ditandai [RENDAH]); sebagian halaman dibaca terpotong.
- Docs vendor tanpa tanggal terbit dibaca pada 31 Okt 2026 dan dapat berubah.
- Seluruh dokumen ini adalah sintesis atas catatan tersebut, bukan hasil eksperimen pada webterm. Skema dan desain di bagian 4-8 belum diuji di lapangan.

---

## 4. Arsitektur yang direkomendasikan (sintesis)

```
                      +-----------------------------+
                      |           MANUSIA           |
                      | pemilik; menyetujui gate;   |
                      | satu-satunya penulis CORE   |
                      +--------+-------------+------+
                               |             |
                   inbox keputusan     masuk langsung ke terminal
                   + laporan ringkas   mana pun di canvas (tiap project
                               |       tetap bisa dikerjakan tanpa agent)
                      +--------v--------+    |
                      |   AGENT PUSAT   |    |
                      | router + indeks |    |
                      | memori lintas-  |    |
                      | project         |    |
                      +----+-------+----+    |
                           |       |         |
        kontrak HTTP+JSON  |       |         |   (task id, status, polling,
        (bentuk A2A)       |       |         |    token berskop per agent)
                 +---------v--+  +-v---------v--+
                 | ORKESTRATOR|  | ORKESTRATOR  |   depth 1: hub. Satu per
                 | project A  |  | project B    |   project. Pemilik ledger
                 +--+----+----+  +---+-----+----+   project + promosi fact.
                    |    |           |     |
                   W1   W2          W1    W2        depth 2: worker. Worktree
                  (cap konkurensi)                  sendiri. TIDAK boleh spawn.
```

Penghitungan kedalaman: agent pusat = 0, orkestrator project = 1, worker = 2. Batas keras **depth <= 2**.

### 4.1 Tabel peran

| Peran | Tugas | Boleh | Tidak boleh | Menulis ke |
|---|---|---|---|---|
| Manusia | Memutuskan, menyetujui gate, mengerjakan langsung bila mau | Semua; masuk ke terminal mana pun; mengubah CORE | - | CORE, keputusan, semua |
| Agent pusat | Router permintaan; indeks memori lintas-project; membuat project + orkestratornya atas perintah manusia; laporan lintas-project | Membaca indeks; membuat entitas project; membuat satu orkestrator per project; mengirim task ke orkestrator via kontrak | Memerintah worker langsung; mengubah CORE sendiri; menulis fact project; spawn worker | `project` (atas perintah manusia), usulan perubahan CORE lewat PR |
| Orkestrator project | Hub: memecah task, spawn worker, memverifikasi, mempromosikan claim menjadi fact | Spawn worker (dalam cap); membaca/menulis ledger project; menjalankan verifikasi independen | Spawn orkestrator lain; melebihi otoritas induk; mengubah memori lintas-project tanpa persetujuan manusia | `task`, `event`, `decision`, `facts/` project |
| Worker | Mengerjakan satu task di worktree sendiri | Mengubah file dalam scope task; menjalankan test; mengirim claim + bukti; bertanya saat ambigu | Spawn agent; menulis memori bersama; commit/push di luar scope; menyentuh credential | `PROGRESS.md` + claim di sandbox sendiri |

### 4.2 Aturan spawn (rekomendasi, mengikuti guardrail 4-5 bagian 9)

- Hanya orkestrator yang boleh spawn worker; agent pusat hanya boleh membuat orkestrator (satu per project) atas perintah manusia; worker tidak spawn.
- Depth <= 2 (di atas). Tanpa spawn rekursif otomatis.
- Cap keras: jumlah worker paralel per orkestrator, total spawn per project, dan biaya (token/USD/turn/waktu) per level. Cap **memblokir**, bukan sekadar alert (pelajaran insiden tagihan Bedrock, bagian 9.2).
- Anak tidak boleh punya otoritas lebih besar dari induk; tool dan skop eksplisit, tidak diwarisi default (catatan keamanan: subagent Claude Code, menurut satu blog pihak ketiga [RENDAH-SEDANG], mewarisi semua tool induk secara default; lihat bagian 14).
- Angka cap awal untuk konkurensi: docs Anthropic untuk Agent Teams menyarankan 3-5 teammate [TINGGI]; memakai angka itu sebagai titik mulai adalah **judgement peneliti**, bukan hasil eksperimen.
- Batas kedalaman tidak bergantung pada angka default Claude Code (bagian 14): batas ini ditegakkan oleh control plane webterm sendiri.

### 4.3 Aturan verifikasi independen

- Status `claimed_done` dari worker bukan bukti. Orkestrator menaikkan ke `verified` hanya setelah pemeriksaan nyata: git diff ada perubahan, test lulus, typecheck lulus; hasilnya disimpan sebagai `evidence_json` (bagian 6).
- Dasar: Anthropic sendiri melaporkan agent menandai fitur selesai tanpa test dan agent baru yang melihat progres lalu menyatakan selesai [TINGGI]; paper "false success" (arXiv 2606.09863, 1 Jun 2026) menemukan LLM judge gagal sebagai verifier (AUROC <= 0,65 dan 0,54) sementara detektor TF-IDF ringan jauh lebih baik [TINGGI isi, SEDANG generalisasi, satu paper belum direplikasi].
- Karena itu verifier utama = state lingkungan (diff, test, exit code), bukan LLM judge.
- Teks yang dihasilkan agent lain (hasil worker, tool description, Agent Card) diperlakukan sebagai **data tak tepercaya**, bukan perintah. Pesan antar-agent tidak boleh dianggap persetujuan manusia (pola docs Anthropic, bagian 11.2).

---

## 5. Memori dan manajemen konteks

Prinsip (sintesis dari catatan memori): **memori = file bergit yang bisa dibaca manusia, bukan vector DB; konteks hidup = cache yang boleh hilang kapan saja.** Pola ini konvergen di beberapa produk (`MEMORY.md` + file topik di Claude Projects, Devin, auto memory Claude Code; Letta Context Repositories memakai file di git) [TINGGI untuk keberadaan pola di bagian 11.2 dan 11.7]. Dan sudah dipakai di repo ini (CLAUDE.md/MEMORY.md).

### 5.1 Tier memori

| Tier | Isi | Disimpan di | Penulis |
|---|---|---|---|
| Pinned (< ~200 baris) | identitas, aturan, indeks project | `central/CORE.md` | manusia saja; agent mengusulkan lewat PR |
| Semantic | fakta dan keputusan per project | `projects/<p>/facts/*.md` (frontmatter: `source`, `verified_at`, `verify_cmd`, `supersedes`) | orkestrator project |
| Episodic | apa yang terjadi, append-only | `projects/<p>/log/*.jsonl` | semua, hanya append |
| Procedural | runbook dan skill | `skills/` | manusia / lewat review |
| Working | konteks sesi dan progress | `projects/<p>/PROGRESS.md` + feature list | worker di sandbox-nya |

Tabel ini = **rekomendasi** dari catatan 07; nama path adalah usulan, bukan konvensi yang sudah ada di repo.

### 5.2 Aturan tulis: claim -> fact (rekomendasi)

1. Worker **tidak** menulis ke memori bersama. Ia mengirim *claim* + bukti (path, hash commit, output test).
2. Orkestrator project memverifikasi dan **mempromosikan** claim menjadi *fact* (menulis `facts/*.md` dengan `source` dan `verified_at`).
3. Agent pusat hanya **membaca** indeks lintas-project.
4. Manusia menyetujui perubahan CORE dan perubahan lintas-project.
5. Dasar desain: serangan memory poisoning lewat beberapa write channel (Dash dkk., arXiv 2606.04329, 3 Jun 2026) [TINGGI] dan laundering lineage lewat summarization/echo tool/korroborasi palsu hingga 68% pada 8 model frontier, sedangkan origin-binding (TMA-NM) 0% attack success di benchmark penulis sendiri (Louck, arXiv 2606.24322, 23 Jun 2026) [TINGGI isi, SEDANG generalisasi]. Gerbang promosi adalah jawaban desain atas write channel dan origin-binding; efektivitasnya di webterm **belum diuji**.
6. Ringkasan (hasil kompaksi) bukan sumber kebenaran: ia sekaligus titik kehilangan informasi dan jalur laundering. Fact turunan ringkasan mewarisi provenance asalnya.

### 5.3 Verifikasi sebelum percaya (rekomendasi)

- Tiap fact punya `verify_cmd` yang dijalankan saat fact dibaca.
- Fact melewati TTL, atau `verified_at` lebih lama dari perubahan file terkait = "basi, verifikasi dulu".
- Isi dari web/tool = data, bukan instruksi.
- Dasar: staleness adalah masalah terbuka. STALE (arXiv 2605.06527, 7 Mei 2026): model terbaik 55,2% [TINGGI]; arXiv 2608.04574 (5 Agu 2026): agent yang percaya memori mentah mati lebih dari 2x lebih sering daripada tanpa memori, di GridWorld/FrozenLake [RENDAH generalisasi]; Mem0 mengakui staleness masalah terbuka.
- Tidak ada penghapusan diam-diam: gunakan `superseded_by` (git menyimpan riwayat); rapikan berkala lewat PR (pola defragmentation Letta, ke ~15-25 file [TINGGI keberadaan pola]).
- Recall semantik lemah di korpus besar: tambah indeks sederhana (BM25) dulu, bukan graph DB. Graph temporal ala Zep hanya bila kebutuhan temporal terbukti berat (belum terbukti perlu).
- Trade-off: file bergit transparan/auditable/rollback; gerbang promosi lebih aman tetapi menambah latensi dan beban review.

### 5.4 Strategi konteks

**Dasar fakta** (catatan konteks, [TINGGI] kecuali dinyatakan lain):

- Context rot diakui vendor ("accuracy and recall degrade" saat token bertambah). Window 1M token pada model terkini tidak menghilangkan masalah ini.
- Kompaksi tidak cukup: tidak selalu meneruskan instruksi jelas ke agent berikutnya (Anthropic, 26 Nov 2025, diubah 18 Okt 2026).
- Yang **selamat** saat kompaksi di Claude Code: CLAUDE.md root dan rules tanpa `paths:`, auto memory, skill descriptions, plan dari plan mode, <= 5 file terakhir dibaca. Yang **hilang**: instruksi yang hanya diucapkan di percakapan, nested CLAUDE.md dan rules ber-`paths:` yang belum ter-load, konteks hasil hook sebelumnya.
- Hook `SessionStart` dengan matcher `compact` menambahkan stdout ke konteks pasca-kompaksi; `PreCompact`/`PostCompact` tersedia dan `PreCompact` bisa memblokir (exit 2).
- Laporan pengguna (bukan konfirmasi vendor) tentang instruksi CLAUDE.md terabaikan pasca-kompaksi dan "context amnesia" [SEDANG]; docs kini mengklaim CLAUDE.md di-inject ulang, jadi sebagian mungkin sudah diperbaiki (belum diverifikasi).
- Kompaksi memutus cache; `/compact` di sesi dingin paling mahal.

**Rekomendasi:**

| Kategori | Isi | Mekanisme |
|---|---|---|
| Selalu di konteks (kecil, stabil, prefix ter-cache) | CLAUDE.md root ramping (aturan keras/Blocker), daftar project/node aktif + 1 baris status per worker, pointer ke `PROGRESS.md` dan feature list | CLAUDE.md root; indeks dari ledger |
| Fetch saat perlu (just-in-time) | detail project, log, diff, hasil riset worker, memori jangka panjang | path/ID ringan; query ke DB; grep/glob; sub-agent mengembalikan ringkasan ~1.000-2.000 token, detail ke file |
| Aturan kritis | constraint dari percakapan | tulis ke file saat itu juga; CLAUDE.md root atau hook `SessionStart[compact]`; jangan andalkan rules ber-`paths:` |
| Sebelum kompaksi | snapshot state | hook `PreCompact` menulis snapshot; `SessionStart[compact]` membacanya kembali |
| Progress | feature list JSON dengan satu field status | JSON dipilih karena model lebih jarang menimpanya daripada Markdown (docs Anthropic [TINGGI]) |

- Pakai memory tool dan compaction **bersamaan** (disarankan docs) bila memakai API; di Claude Code, andalkan file + hook di atas.
- Jangan membuang hasil tool yang penting: gunakan `exclude_tools` pada tool-result clearing bila memakai API context editing.
- **Rotasi sesi** (**judgement peneliti, [RENDAH]; bukan angka vendor, tidak ada angka resmi "umur sesi ideal"**): rotasi di batas tugas alami setelah handoff ditulis dan di-commit; setelah 1-2 kompaksi; saat agent melanggar constraint yang sudah tercatat; saat tampak "context anxiety" (model menutup kerja terlalu dini mendekati batas; Anthropic 24 Mar 2026 melaporkan Sonnet 4.5 butuh reset sedangkan Opus 4.5 "largely removed" [TINGGI]). Opsi `autoCompactWindow` 200-300k disebut sebagai pilihan, bukan hasil pengukuran.
- Pola handoff resmi sebagai contoh: initializer membuat `init.sh`, `claude-progress.txt`, `feature_list.json` + commit git; sesi berikutnya membaca progress dan git log, memilih satu fitur gagal, dan menjalankan test dasar [TINGGI].

---

## 6. State dan ledger

**Penting: skema di bawah adalah SINTESIS peneliti (catatan 08), bukan pola yang terbukti di lapangan.** Tidak ditemukan post-mortem kegagalan event sourcing untuk agent; perilaku `synchronous=FULL` di `bun:sqlite` macOS (`F_FULLFSYNC`) tidak diuji.

### 6.1 Prinsip (rekomendasi)

- Orkestrator **stateless**: bukan proses berumur panjang; ia membaca ledger lalu bertindak. Tanpa engine eksternal.
- Satu file `bun:sqlite`, WAL, `synchronous=FULL`, transaksi tulis pendek. Dasar: SQLite WAL ~1.000 commit durable/detik, single-writer (Pedro Alonso, 1 Jul 2026) [SEDANG]; WAL tidak berjalan di network filesystem dan semua proses harus satu host (sqlite.org [TINGGI]).
- Batas naik kelas bersifat arsitektural (multi-mesin, timer berhari-hari, fan-out besar); saat itu pertimbangkan Temporal/Restate. Sekarang tidak.
- Ledger berada di luar konteks LLM. Pola searah dengan Anthropic: feature list JSON (`passes`), progress file, git commit; Managed Agents ("The session is not Claude's context window"; crash -> `wake(sessionId)` -> ambil event log -> resume) [TINGGI].
- Engine penuh menambah ops dan batasan determinisme replay yang berlebihan untuk satu mesin/satu pengguna (Alonso; Morling, 20 Nov 2025) [SEDANG]. Replay juga tidak memperbaiki side effect di luar DB (`git commit`, spawn worker), jadi tetap perlu idempotency key / intent record.

### 6.2 Skema minimal (id ULID)

| Tabel | Kolom | Penulis |
|---|---|---|
| `project` | id, name, path, branch_base, status | agent pusat, atas perintah manusia |
| `task` | id, project_id, parent_id, spec, status, lease_owner, lease_expires, attempt, idem_key, evidence_json | orkestrator membuat dan memverifikasi; worker hanya mengklaim |
| `event` (append-only) | seq, ts, actor, kind, task_id, payload | semua, hanya INSERT |
| `decision` | id, ts, question, choice, rationale, decided_by (`human`/`agent`), supersedes | manusia/agent sesuai gate |
| `agent` | id, name, kind, session_ref (node/tmux), heartbeat_at, state | worker mengirim heartbeat; orkestrator mengubah state |
| `memory` | id, scope, key, summary, source_ref, updated_at | indeks saja; isi panjang di file (bagian 5) |

### 6.3 Status `task`

`pending` -> `leased` -> `claimed_done` -> `verified`; cabang: `failed`, `blocked`.

- `blocked` dapat dipakai sebagai wadah "butuh manusia" yang muncul di inbox keputusan (bagian 8). Pemakaian ini adalah usulan, tidak ada di catatan sebagai nilai bawaan.

### 6.4 Reconcile di awal tiap giliran orkestrator

1. Lease kedaluwarsa -> `pending`, `attempt`++.
2. `claimed_done` -> `verified` **hanya** setelah pemeriksaan nyata (git diff ada perubahan, test lulus); hasil disimpan sebagai `evidence_json`.
3. Perubahan state = `event` dalam **transaksi yang sama** dengan perubahan baris `task`.
4. Aksi berisiko: **intent event -> aksi -> outcome event**. Setelah crash, cek dulu apakah efek sudah terjadi sebelum mengulang. Dasar: uji lab Effloow (5 Sep 2026) menunjukkan kill+resume pada LangGraph mengulang tool call yang sedang berjalan (charge ganda tanpa idempotency) [RENDAH-SEDANG, satu blog].
5. Handoff antar-sesi: ledger + ringkasan kecil ala progress file.

### 6.5 Pola pendukung

- ESAA (arXiv:2602.23193, 26 Feb 2026): agent hanya mengeluarkan intent JSON; orchestrator deterministik memvalidasi, append ke `activity.jsonl`, lalu menerapkan efek; 2 studi kasus [SEDANG]. Sama dengan pola intent->act->outcome di atas.
- codex-orchestrator v2: ledger task, heartbeat append-only, klasifikasi stale deterministik, "jangan anggap status thread otoritatif" [SEDANG].
- Hubungan ke webterm: autosave workspace saat ini last-write-wins (debounce 400 ms, tanpa ETag; bagian 10). Ledger tidak boleh mewarisi pola itu; gunakan transaksi dan versi.

---

## 7. Protokol dan identitas

Semua butir = **rekomendasi** dari catatan protokol; fakta pendukung ada di bagian 11.4.

| # | Rekomendasi | Alasan singkat |
|---|---|---|
| 1 | Kontrak antar-level = HTTP+JSON dengan skema milik sendiri, bentuk meniru A2A: task id; status `working`/`input_required`/`completed`/`failed`/`canceled`; polling; Agent Card sederhana. Satu trust domain/proses. Jangan pasang A2A penuh; siapkan jalur migrasi ke A2A v1 hanya di batas lintas-org/vendor. | A2A v1.0 punya banyak breaking change dari v0.3; A2ABreak menemukan kerentanan pada implementasi patuh-spec |
| 2 | MCP **hanya** untuk akses tool/data, bukan komunikasi antar-agent. Gunakan spec 2026-07-28 (stateless, Streamable HTTP). Tasks hanya bila sudah lewat Beta, atau tiru polling di HTTP biasa. | Tasks masih Beta; MCP baru saja breaking |
| 3 | Skills (`SKILL.md`) untuk kemampuan/runbook. | Standar terbuka, donasi ke AAIF 22 Okt 2026 |
| 4 | AGENTS.md untuk konteks per-project, tetapi **tetap simpan CLAUDE.md** karena dukungan Claude Code atas AGENTS.md hanya dari blog sekunder (bagian 14). | Menghindari ketergantungan pada klaim tak terverifikasi |
| 5 | Identitas: satu token terbatas per agent (audience dan skop sempit, TTL pendek), diterbitkan agent pusat saat spawn, chain delegasi tercatat. **Jangan teruskan token ke bawah**; bila perlu, token exchange / OBO (RFC 8693) dengan `resource` (RFC 8707). Catat tiap hop. | Standar identitas agent IETF belum final; pola vendor (Entra Agent ID, AWS AgentCore) hanya satu jenis sumber [SEDANG]; A2ABreak: identitas hilang di delegasi multi-hop |
| 6 | Spawn aman: cwd terbatas (git worktree), token terbatas, env minim secret; sandbox OS/container hanya bila kode tidak dipercaya. | Lihat guardrail 1 dan 3 (bagian 9) |
| 7 | Registry = satu tabel SQLite berisi Agent Card sederhana (dapat diselaraskan dengan tabel `agent`, bagian 6); registry publik tidak perlu. | Satu mesin, satu trust domain |
| 8 | Hindari dulu: Roots/Sampling/Logging (deprecated), DCR, HTTP+SSE, MCP Registry publik, AGNTCY SLIM/Identity, ketergantungan pada Tasks sebelum stabil. | Deprecated atau belum stabil |
| 9 | Semua teks dari agent lain (Agent Card, tool description, hasil worker) = data tak tepercaya; human-in-the-loop sebelum aksi destruktif. | Agent Card poisoning, tool poisoning |

Catatan identitas webterm: protokol warisan tetap `nodeterm` (`NODETERM_NODE_ID`, `NODETERM_PORT`, header `x-nodeterm-node-token`, event `nodeterm:`) dan **tidak boleh di-rename** tanpa perintah eksplisit. Header/token baru memakai awalan `webterm` (bagian 10).

---

## 8. Kolaborasi manusia-agent

Catatan: bagian "rancangan" di bawah adalah **sintesis peneliti (catatan 09), bukan klaim sumber**. Fakta pendukung ada di 11.9.

### 8.1 Kepemilikan

- Satu task = satu pemilik (manusia atau agent), satu branch, satu worktree.
- Manusia yang bekerja paralel memakai worktree sendiri.
- Scope file dicatat sebelum mulai. File bersama (shared, lockfile, config) hanya dengan klaim eksplisit.
- Worktree per agent adalah baseline semua tool besar (Conductor, Codex app 2 Feb 2026, Cursor 3 Agents Window 2 Apr 2026) [TINGGI], tetapi worktree **tidak** menghapus konflik semantik: studi 33.596 PR agent melaporkan konflik antar-agent berbeda 41,7% vs 19,8% antar-agent sama, diceritakan ulang oleh blog sekunder [SEDANG; belum dicek ke sumber asli]. Pertahanan (blog individu [RENDAH]): scope file per agent, klaim task sebelum mulai, hook `git merge-tree`.
- Kebutuhan teknis di webterm: `Session.send` harus mendukung banyak subscriber agar manusia dan agent bisa berbagi satu terminal (bagian 10).

### 8.2 Gate menurut keterbalikan aksi

| Kelas | Aksi | Perlakuan |
|---|---|---|
| Otomatis | read, edit di worktree sendiri, test | tanpa persetujuan |
| Wajib manusia | push ke remote bersama, merge, migrasi/schema, menyentuh credential, hapus massal, aksi di luar project | gate; tidak ada jalur otomatis |
| Agent wajib bertanya | ambigu, butuh credential, gagal berulang | status `input_required`/`blocked` -> inbox |

- Satu PR, satu reviewer manusia yang bukan penulis.
- Dasar: persetujuan per-aksi gagal; pengguna Claude Code menyetujui 93% permission prompt -> approval fatigue (Anthropic, 25 Mar 2026) [TINGGI]; TechCrunch (9 Agu 2026) mengutip 97%, dua angka dari vendor sama, arah sama [SEDANG].
- Penggantinya di sumber adalah gate bertingkat berdasar risiko (auto mode: tier 1 allowlist read-only; tier 2 edit dalam project yang bisa ditinjau via VCS; tier 3 classifier untuk aksi berisiko; blok default: force-push, push ke main, deploy produksi, ubah permission config sendiri) [TINGGI]. Factory memetakan Autonomy Level Off/Low/Medium/High ke risiko, dengan rule `block` tanpa jalur approval dan `ask` yang tetap meminta bahkan di High [TINGGI].
- **Classifier bukan satu-satunya pengaman:** false-negative 17% pada aksi overeager nyata (n=52); Anthropic: "not a drop-in replacement for careful human review" untuk infra high-stakes [TINGGI]. Klaim 89% vs 13,6% review manusia adalah data internal vendor [RENDAH].
- Agent yang bertanya sendiri adalah bentuk oversight penting: agent berhenti bertanya lebih sering daripada manusia menginterupsi (pilihan pendekatan 35%, butuh credential 12%, butuh approval 11%; Anthropic, Feb 2026) [TINGGI].

### 8.3 Format laporan agent (wajib, usulan)

1. Tujuan
2. Scope file
3. Keputusan + alternatif yang ditolak
4. Bukti test
5. Hal yang belum diverifikasi
6. Pertanyaan terbuka

Format ini selaras dengan aturan repo ini (PR description, Rule 14 global) dan dengan `evidence_json` di ledger.

### 8.4 Inbox keputusan dan monitoring

- Satu **inbox keputusan** yang hanya berisi item yang butuh manusia (task `blocked`/`input_required`, gate menunggu); event rutin masuk timeline.
- Notifikasi bisa memakai hook `Notification` Claude Code [TINGGI].
- Audit/interupsi: checkpoint dan `/rewind` Claude Code **tidak** melacak perubahan via Bash/subagent/eksternal ("bukan pengganti VCS") [TINGGI]; jadi jangan memakainya sebagai backup. Devin menyediakan tab Progress, Side Chat, dan takeover shell/IDE oleh manusia [TINGGI]; perilaku nyata steering/pause/inbox di Cursor/Devin/Factory belum diverifikasi (hanya docs).

### 8.5 Trust bertahap

- Mulai ketat, naikkan otonomi **per jenis aksi** setelah ada track record.
- Data pendukung: pengguna dengan < 50 sesi auto-approve penuh ~20%, dengan > 750 sesi > 40%; pengguna berpengalaman lebih sering interrupt (9% vs 5% giliran) -> bergeser dari approve-per-aksi ke monitor-lalu-intervensi [TINGGI, Anthropic].

### 8.6 Jebakan

- Prompt per aksi (approval fatigue).
- Satu classifier sebagai satu-satunya pengaman.
- Mengira worktree menghapus konflik semantik.
- Mengira checkpoint/rewind sebagai backup.
- Auto-run CI tanpa memeriksa perubahan `.github/workflows/` (dasar: Actions pada PR Copilot tidak jalan otomatis sebelum "Approve and run workflows"; admin bisa opt-in skip sejak 13 Mar 2026 [TINGGI]; persetujuan manusia atas PR Copilot tidak dihitung approval wajib [TINGGI]).
- Pemilik task yang kabur (ambigu siapa pemilik).
- Review jadi bottleneck: Qodo (23 Sep 2026) 26% developer/leader [SEDANG]; angka Faros via FlowVerify (waktu review median +441,5% saat throughput +33,7%) berasal dari sumber sekunder [RENDAH]. Konsekuensi desain: inbox harus sempit; jangan membanjiri manusia dengan laporan.
- Penghapusan via Bash tidak bisa di-rewind; insiden 48.218 file terhapus (junction Windows) hanya satu post Reddit [RENDAH].

---

## 9. Keamanan

### 9.1 Sepuluh guardrail minimum (urut prioritas; **rekomendasi** dari catatan 06)

| # | Guardrail |
|---|---|
| 1 | **Credential:** agent tidak pernah memegang token berskop luas; token per-project/per-agent, umur pendek, masking/proxy; secret tidak di disk yang bisa dibaca agent. |
| 2 | **Aksi destruktif/irreversible** = human gate + soft-delete dan backup yang terpisah dari jalur kredensial agent. |
| 3 | **Isolasi eksekusi:** sandbox OS/container per worker, egress allowlist, `strictAllowlist`, tanpa `bypassPermissions`, retry-unsandboxed di-ask-rule; anggap sandbox bisa bocor. |
| 4 | **Permission berpangkat turun:** anak tidak boleh punya otoritas lebih dari induk; tool dan skop eksplisit, tidak diwarisi default. |
| 5 | **Batas spawn:** depth <= 2; paralel dan total spawn dibatasi; tanpa spawn rekursif otomatis. |
| 6 | **Hard cap biaya** per level (token/USD/turn/waktu) + kill switch + deteksi loop; cap memblokir, bukan alert. |
| 7 | **Data tak tepercaya bukan perintah:** output worker/issue/web = data. |
| 8 | **Verifikasi independen** tiap laporan "selesai": git diff, test, typecheck oleh orkestrator. |
| 9 | **Tracing dan log keputusan** (OTel GenAI, versi dipin karena status Development), payload terpisah dan di-redact. |
| 10 | **Eval regresi** (golden tasks) tiap ganti model/prompt. |

Catatan: sandbox hanyalah satu layer (lihat DuneSlide dan escape hatch di bawah). Perlindungan sisi penyedia (soft-delete) mengalahkan harapan "agent akan hati-hati" (kesimpulan catatan 06 dari insiden Railway).

### 9.2 Insiden nyata (singkat)

Semua insiden di bawah adalah **single-agent atau supply chain**; tidak ditemukan insiden multi-agent lintas-agent nyata (bagian 3).

| Insiden | Ringkas | Label | URL |
|---|---|---|---|
| Hapus DB produksi (24-29 Apr 2026) | Agent Cursor (Opus 4.6) menemukan token API Railway berskop akun di disk, memanggil `volumeDelete` ke produksi; backup ikut hilang (cascading delete). Railway lalu: soft-delete 48 jam, token granular, penundaan hapus backup. ("9 detik" hanya blog sekunder, [RENDAH].) | [TINGGI] | https://blog.railway.com/p/your-ai-wants-to-nuke-your-database |
| Confused deputy via judul GitHub issue (Feb 2026) | Memicu sesi Claude terautentikasi di Cline memasang paket penyerang, ~4.000 mesin. CSA belum meninjau advisory primer. | [SEDANG] | https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-confused-deputy-prompt-injection/ |
| Sandbox ditembus: Cursor "DuneSlide" | CVE-2026-50548/50549, CVSS 9.8; agent menulis satu file yang mematikan sandbox; patch Cursor 3.0. | [SEDANG] | https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html |
| Supply chain: worm Mini Shai-Hulud (11 Mei 2026) | 404 versi paket, termasuk provenance SLSA L3 valid (SLSA L3 tidak menjamin aman). | [SEDANG] | https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-ai-npm-supply-chain-attack-2026/ |
| Ekstensi Claude Code palsu (2.1.312/313) | ~11 jam di marketplace Cursor, backdoor SSH (29 Okt 2026). | [TINGGI] | https://cursor.com/blog/claude-code-extension-security-notice |
| Tagihan Bedrock (Apr-Mei 2026) | $37,9k gross ($29,9k net) karena prompt caching tidak aktif; $30.141 tidak tertangkap Cost Anomaly Detection (billing via Marketplace). Pelajaran: alert bukan hard cap. | [SEDANG-TINGGI] | https://www.theregister.com/saas/2026/05/14/bedrock-and-a-hard-place-claude-adventure-leaves-aws-user-staring-down-30k-invoice/5238153 |

### 9.3 Ancaman terstruktur dan catatan teknis

- **OWASP Top 10 Agentic Applications 2026** (9 Des 2025) [TINGGI]: ASI01 Goal Hijack, 02 Tool Misuse, 03 Identity & Privilege Abuse, 04 Supply Chain, 05 Code Execution, 06 Memory Poisoning, 07 Insecure Inter-Agent Comms, 08 Cascading Failures, 09 Human-Agent Trust Exploitation, 10 Rogue Agents. https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ . (Isi ASI02-ASI10 hanya dari blog rilis.)
- **Sandbox Claude Code punya escape hatch:** retry tanpa sandbox (`dangerouslyDisableSandbox`) bisa jalan tanpa prompt bila ada allow rule yang cocok atau mode `bypassPermissions`; ada credential masking dan `strictAllowlist`; tidak ada built-in credential deny list [TINGGI]. https://code.claude.com/docs/en/sandboxing
- **Prompt injection menjalar antar-agent** dan bertahan melewati teks aslinya (MAPI, AJCAI 2026, pipeline 4 agent); risiko ditentukan capability yang bisa dijangkau, bukan jarak di graf [SEDANG, hanya abstrak]. arXiv 2608.00747 (1-4 Agu 2026) melaporkan perambatan via shared prompt structure di domain robotik [SEDANG].
- **Biaya:** `--max-budget-usd` dan `--max-turns` hanya di print mode, estimasi sisi klien, spend subagent dihitung, dan batas bisa terlewati [TINGGI] (https://code.claude.com/docs/en/cli-reference). Karena itu cap biaya webterm sebaiknya ditegakkan di control plane sendiri, bukan hanya flag CLI (rekomendasi).
- **Observability:** OTel GenAI semconv pindah ke repo `open-telemetry/semantic-conventions-genai` (5 Mei 2026); agent spans berstatus **Development** [TINGGI]; dukungan Langfuse/LangSmith terhadap OTel GenAI hanya dari judul pencarian [RENDAH].
- **Multi-agent mengamplifikasi error:** MAST (arXiv 2503.13657): amplifikasi error 17,2x tanpa verifikasi vs 4,4x dengan koordinasi terpusat [SEDANG; model lama].

---

## 10. Peta kesenjangan webterm

Sumber: analisis kode lokal (catatan 1b, wkr-rsch-local-01). **Nama file dan angka baris dikutip persis dari catatan; belum diukur ulang oleh penulis dokumen ini.** Fase 0 harus mengukur ulang.

### 10.1 Sudah ada

- Multi-workspace di SQLite.
- `GET /api/context-link`.
- `POST /api/agent-status` + `hookStatus`.
- Spawn PTY via `Sessions.open`.
- Auth `WEBTERM_TOKEN`, pemeriksaan Origin, token per-node.
- Node xterm nyata, komentar, Kanban.

### 10.2 Belum ada

| Kebutuhan agent pusat | Keadaan |
|---|---|
| Spawn headless | PTY hanya mulai lewat WS `open` dari browser |
| REST API untuk prompt / wait / subscribe | tidak ada |
| Entitas "project" di atas Workspace | tidak ada |
| Memori jangka panjang terstruktur | tidak ada |
| Identitas per-aktor | `stateVerified` di `hooks.ts:110` tidak pernah dipanggil -> endpoint fail-open |
| Status dan transkrip untuk agent non-claude | tidak ada |

### 10.3 Risiko

1. **Blocker utama: `Session.send` = satu slot subscriber.** Klien kedua mencuri stream dari browser manusia. Tanpa perbaikan ini, "manusia kerja berdampingan dengan agent" tidak mungkin.
2. `WEBTERM_*` diwarisi semua child PTY -> perlu token berskop agar agent tidak mewarisi otoritas penuh.
3. Autosave workspace last-write-wins (debounce 400 ms, tanpa ETag).
4. Over-limit Rule 8 global (angka dari catatan): `shared/workspace.ts` 444 baris, `api.ts` 154, `sessions.ts` 300, `SessionsPanel.tsx` 456, `App.tsx` 436. Menurut Rule 8, menambah kode ke file yang sudah over-limit ditolak, jadi pemecahan harus mendahului fitur yang menyentuhnya. (Sebagian, mis. `sessions.ts` 300, berada di batas, bukan jelas di atasnya, bergantung tipe file; tentukan di Fase 0.)
5. **Jangan rename nama protokol `nodeterm`** (env var sesi agent, header `x-nodeterm-node-token`, event `nodeterm:`). Header baru berawalan `webterm`.
6. `Sessions` adalah singleton in-memory; `bun:sqlite` harus di-import lazy di test.

### 10.4 Titik integrasi termurah

1. File route REST baru yang membungkus `sessions.open/input/close`.
2. Ubah `Session.send` menjadi himpunan subscriber.
3. Tambah metadata project dan role.
4. Panggil `stateVerified`.

Peringatan terkait gerbang repo: test yang bind unix socket butuh `TMPDIR=/tmp/st` di macOS (CLAUDE.md repo).

---

## 11. Temuan per track

Ringkasan faktual; untuk rancangan lihat bagian 4-10. Format: temuan, label, sumber/tanggal.

### 11.1 Hierarki

| Temuan | Label | Sumber |
|---|---|---|
| Multi-agent research Anthropic +90,2% atas single-agent (eval internal), 13 Jun 2025 | [TINGGI] isi, [SEDANG] generalisasi | https://www.anthropic.com/engineering/multi-agent-research-system |
| Google arXiv 2512.08296: +80,8% pada tugas yang bisa didekomposisi; -39% s.d. -70% pada tugas sekuensial/saling bergantung | [SEDANG] | arXiv 2512.08296 |
| Cognition pola multi-agent (22 Apr 2026); Anthropic C compiler dengan banyak agent (5 Feb 2026) | [SEDANG] | (tanpa URL di catatan) |
| Biaya: ~4x token chat untuk satu agent, ~15x untuk multi-agent | [SEDANG] | catatan 1a tanpa URL; angka yang sama dikaitkan ke https://www.anthropic.com/engineering/multi-agent-research-system di catatan framework |
| MAST: 41-86,7% kegagalan pada sistem multi-agent; amplifikasi error 17,2x tanpa verifikasi vs 4,4x dengan koordinasi terpusat; dibangun di atas model lama | [SEDANG] | arXiv 2503.13657 |
| Tidak ada studi kedalaman 2 vs 3 | - | - |

### 11.2 Produk dan prior art

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| Claude Code agent teams: lead + teammates, task list bersama + mailbox JSON di `~/.claude/teams/`; manusia bisa masuk ke teammate. Experimental, off default; satu team/sesi; **tanpa nested team**; `/resume` tidak memulihkan teammates | [TINGGI] | https://code.claude.com/docs/en/agent-teams (dibaca 31 Okt 2026) |
| Agent view (`claude agents`): satu layar semua background session (Needs input / Working / Completed); research preview, lokal | [TINGGI] | https://code.claude.com/docs/en/agent-view.md |
| Claude Projects (public beta) = paling mirip ide ini: project conversation = koordinator, threads = worker; memori `MEMORY.md` + file; instruksi maks 16.000 karakter. Batas: hanya github.com, satu project milik satu user, bukan Team/Enterprise, tidak ada di CLI/VS Code/Bedrock, maks 500 thread/hari, tak bisa memasukkan session lokal berjalan. Terkunci cloud Anthropic + GitHub | [TINGGI] | https://code.claude.com/docs/en/claude-projects.md |
| Cross-session messaging, channels, scheduled tasks, mods/plugins ada di indeks docs | [TINGGI] | https://code.claude.com/docs/llms.txt |
| GitHub Copilot app, Projects: public preview sejak 28 Okt 2026; beberapa repo/konteks non-repo, banyak agent | [TINGGI] | https://github.blog/changelog/2026-10-28-github-copilot-app-universe-releases/ |
| GitHub Agent HQ diumumkan 28 Okt 2025 | [TINGGI] | https://github.blog/news-insights/company-news/welcome-home-agents/ |
| Factory Workstreams (beta): orchestrator mendelegasikan ke agents; manusia bisa membuka agent mana pun; lebih boros token; closed | [TINGGI] | https://docs.factory.com/workstreams/overview.md |
| Devin Memory = git repo Markdown + `MEMORY.md`, tiap entri punya tautan sumber + tanggal, "Dreaming" merapikan; pribadi per user per org. Dynamic Workflows, Outposts | [TINGGI] | https://docs.devin.ai/product-guides/memory.md ; https://docs.devin.ai/llms.txt |
| Cursor: Cloud Agents di VM terisolasi, multi-repo, Agent SDK (rilis 20 Okt 2026); tak ada koordinator lintas-project eksplisit | [TINGGI] | https://cursor.com/docs/cloud-agent.md ; https://cursor.com/changelog |
| Codex: subagents default aktif; memori lokal per mesin; docs menyebut memori hanya "recall layer", aturan wajib tetap di `AGENTS.md` | [TINGGI] | https://learn.chatgpt.com/docs/customization/memories.md |
| Amp Orbs (remote machine per thread, tidur tanpa biaya) | [TINGGI] | https://ampcode.com/manual/orbs |
| Jules (Google): terikat GitHub, experimental | [TINGGI] | https://jules.google/docs |
| Orca (stablyai): MIT, push 31 Okt 2026; agent di worktree masing-masing + companion mobile. "111k stars" belum divalidasi | [TINGGI] fitur, [SEDANG] stars | https://github.com/stablyai/orca |
| OpenHands: MIT, 92k stars, push 30 Okt 2026 | [TINGGI] | GitHub API (tanpa URL di catatan) |
| Claude Squad: AGPL-3.0, 8,7k stars, push terakhir 20 Agu 2026 (melambat) | [SEDANG] | GitHub API |
| Conductor: Free $0 / Pro $50/bln / Teams $60/user/bln; cloud Firecracker, multiplayer, API, BYO subscription | [TINGGI] | https://www.conductor.build/pricing |
| Orchestrator multi-project kecil (`cw`, `squadrant`, `AgentDock`, 0-2 stars, MIT): bukti kebutuhan, belum matang | [SEDANG] | - |
| Docs Anthropic: pesan antar-agent TIDAK boleh dianggap persetujuan user; classifier auto-mode memeriksa pesan antar-agent; 3-5 teammate, overhead koordinasi, tidak cocok untuk tugas sekuensial/edit file sama | [TINGGI] | https://code.claude.com/docs/en/agent-teams |

**Simpulan track (rekomendasi peneliti):**

- Semua vendor besar sudah punya pola "project -> orchestrator -> threads"; membangun "satu lagi di cloud" tidak masuk akal. Jadilah **lapisan di atas tool yang ada**: agent CLI (Claude Code, Codex) sebagai worker, git worktree untuk isolasi, memori `MEMORY.md` + file topik di git dengan sumber dan tanggal per entri (ala Devin), hooks/SDK, pola gate persetujuan manusia.
- Ruang diferensiasi (kesimpulan peneliti dari peta): (1) orkestrasi lintas-project **local-first, agnostik vendor, tanpa GitHub**; (2) memori milik user, versioned di git, lintas project dan vendor; (3) manusia ikut langsung di terminal nyata: canvas webterm menampilkan semua agent dan bisa mengetik di pane mana pun (tidak ditawarkan view berbasis chat).
- Hindari bersaing langsung di fitur cloud dan PR.

### 11.3 Framework dan SDK

| Temuan | Label | Sumber |
|---|---|---|
| Claude Agent SDK: TS `0.3.316` (npm, 2026-10-31), Python `v0.2.176` (2026-10-31), Python MIT. Lisensi TS "SEE LICENSE IN README"/GitHub None -> bukan MIT yang jelas | [TINGGI] versi; [RENDAH] lisensi TS | https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk ; https://github.com/anthropics/claude-agent-sdk-python |
| Subagent bisa bersarang: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` default **3** lapis di bawah main agent; `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` default 20; ada `maxBudgetUsd`. Berlaku TS v0.3.219+ / Python v0.2.127+ | [TINGGI] | https://code.claude.com/docs/en/agent-sdk/subagents |
| Subagent dinamis via param `agents` di `query()` atau `.claude/agents/`; tool `Workflow` (TS v0.3.149+) | [TINGGI] | idem |
| Persistence: transkrip JSONL lokal; adapter `SessionStore` mirror ke object store/KV/DB agar host lain bisa `resume` | [TINGGI] | https://code.claude.com/docs/en/agent-sdk/session-storage |
| Managed Agents: delegasi SATU level, maks 25 child thread, 20 predefined agent; agent ber-`multiagent` direferensikan -> HTTP 400 | [TINGGI] | https://platform.claude.com/docs/en/managed-agents/multi-agent |
| OpenAI Agents SDK: Python v0.24.0 (2026-10-15), JS ext 0.21.0 (2026-10-20), MIT, masih 0.x; handoff + `agent.as_tool()`; klaim nesting resmi tidak ditemukan [SEDANG]; `nest_handoff_history` masih opt-in beta | [TINGGI] | https://github.com/openai/openai-agents-python |
| LangGraph 1.2.19 (2026-10-30), MIT: persistence paling matang (checkpointer, interrupts, time travel); `langgraph-supervisor` kini TIDAK direkomendasikan; Deep Agents 0.7.32 (2026-10-23), async subagents; kedalaman nesting TIDAK DIBACA | [TINGGI] | https://github.com/langchain-ai/langgraph ; https://docs.langchain.com/oss/python/deepagents/subagents |
| CrewAI 1.15.33 (2026-10-29), MIT, 60k stars; hierarchical process; checkpointing; nesting orkestrator-di-atas-orkestrator tidak diverifikasi | [RENDAH] untuk nesting | https://docs.crewai.com/en/concepts/checkpointing |
| Microsoft Agent Framework: Python 1.24.0 (2026-10-30), GA 1.0.0 pada 2026-04-02, MIT; AutoGen DIARSIPKAN (rilis terakhir 2025-09-30); orkestrasi sequential/concurrent/handoff/group chat/Magentic; workflows-as-agents -> nesting 3 tingkat masuk akal secara desain | [SEDANG] | https://github.com/microsoft/agent-framework ; https://learn.microsoft.com/en-us/agent-framework/workflows/ (update 2026-08-25) |
| Google ADK Python v2.13.0 (2026-10-22), Apache-2.0; `Workflow` graph, nested workflows, "flexible hierarchies" (dari README); detail persistence tidak dibaca | [TINGGI] versi | https://github.com/google/adk-python |
| Pendatang: Strands Agents (AWS) [SEDANG]; Pydantic AI v2.64.0 (MIT) dan Mastra core 1.80.0: hanya versi terverifikasi | - | - |
| Cognition "Don't Build Multi-Agents" (2025-06-12): konteks/keputusan tak dibagi -> rapuh; opini berumur 16 bulan | [SEDANG] | https://cognition.ai/blog/dont-build-multi-agents |
| LangChain: satu agent + tools yang tepat sering cukup | [TINGGI] | https://docs.langchain.com/oss/python/langchain/multi-agent |
| Anthropic: multi-agent ~15x token vs chat (agent tunggal ~4x), hanya untuk tugas bernilai tinggi (2025-06-13) | [TINGGI] | https://www.anthropic.com/engineering/multi-agent-research-system |

**Simpulan track (rekomendasi peneliti):** nesting resmi rapuh di semua vendor (Agent Teams tanpa nested, Managed Agents 1 level, OpenAI nested handoff beta); hierarki tiga tingkat hampir tidak pernah fitur kelas satu dan harus dirakit sendiri.

1. Tulis control plane TIPIS sendiri; SDK hanya di tingkat 2-3 (dalam sesi agent). Karena webterm sudah punya PTY, node, workspace, SQLite, tiap orkestrator project dan worker = sesi Claude Code/Agent SDK di dalam node; state, memori, dan human-in-the-loop dipegang webterm [SEDANG, rekomendasi peneliti].
2. Claude Agent SDK untuk tingkat 2-3 pada repo berbasis Claude: subagent bersarang, `maxBudgetUsd`, `SessionStore` ke SQLite. Hindari Agent Teams di produksi.
3. Alternatif workflow durable di pusat: LangGraph (checkpoint terbaik) atau MAF (workflows-as-agents, GA). Dokumen ini **tidak** merekomendasikannya untuk sekarang (bagian 2 dan 6).
4. Hindari: AutoGen (arsip), `langgraph-supervisor` (usang), Managed Agents sebagai fondasi hierarki (1 level), OpenAI nested handoff (beta); CrewAI hierarchical 3 tingkat belum terbukti.
5. Batas kedalaman, konkurensi, dan budget sejak awal (15x token = risiko biaya utama).

### 11.4 Protokol dan standar

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| MCP spec terbaru 2026-07-28: core stateless (`initialize` dan `Mcp-Session-Id` dihapus; `server/discover`); server-to-client request diganti Multi Round-Trip Requests (`input_required`) | [TINGGI] | https://modelcontextprotocol.io/specification/2026-07-28/changelog ; https://blog.modelcontextprotocol.io/posts/2026-07-28/ |
| Roots, Sampling, Logging DEPRECATED (jendela >= 12 bulan); HTTP+SSE deprecated; DCR deprecated -> CIMD | [TINGGI] | idem |
| MCP Tasks = extension `io.modelcontextprotocol/tasks` (`tasks/get` polling, `tasks/update`, `tasks/cancel`; `tasks/list` dihapus); status Beta menuju Core | [TINGGI] | https://modelcontextprotocol.io/extensions/overview ; https://modelcontextprotocol.io/extensions/tasks/overview.md |
| MCP auth: OAuth 2.1 + RFC 9728, RFC 8707, RFC 9207; token passthrough dilarang. Extension auth Stable: OAuth Client Credentials, Enterprise-Managed Authorization | [TINGGI] | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization |
| Server Cards & Skills over MCP: Beta (SEP-2640 Final 13 Sep 2026); MCP Registry masih preview ("breaking changes or data resets may occur") | [TINGGI] | idem |
| Adopsi MCP "~500 juta unduhan/bulan" = klaim blog sendiri | [SEDANG] | idem |
| AAIF dibentuk Linux Foundation 9 Des 2025 (MCP, goose, AGENTS.md); per 22 Okt 2026 10 project (A2A, Agent Router, agentgateway, AGENTS.md, goose, MCP, Agent Skills, Open Responses, OpenEnv, OpenSandbox) | [TINGGI] | https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation ; https://aaif.io/news/agentic-ai-foundation-announces-four-new-projects |
| A2A v1.0.0 12 Mar 2026 (banyak breaking change), v1.0.1 28 Mei 2026; masuk AAIF 27 Agu 2026. Agent Card di `/.well-known/agent-card.json` (+ signing JWS §8.4); operasi SendMessage/GetTask/ListTasks/CancelTask/push. "A2A horizontal, MCP vertikal". Klaim 150+ org dari blog A2A sendiri | [TINGGI]; klaim adopsi [SEDANG] | https://github.com/a2aproject/A2A/releases ; https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/ ; https://a2a-protocol.org/latest/specification/ |
| ACP (IBM/BeeAI) merger ke A2A, dev aktif dihentikan (LF AI & Data, 29 Agu 2025); AGNTCY masih hidup tetapi tidak di 10 project AAIF; hubungannya tidak terverifikasi | [TINGGI] / tak terverifikasi | - |
| `SKILL.md`: frontmatter `name` (<= 64, huruf kecil + tanda hubung, = nama direktori), `description` (<= 1024); opsional `license`, `compatibility`, `metadata`, `allowed-tools` (experimental); progressive disclosure, < 500 baris; didonasikan ke AAIF 22 Okt 2026 | [TINGGI] | https://agentskills.io/specification |
| AGENTS.md: markdown polos, "60k+ repo" (klaim situs sendiri) | [SEDANG] | https://agents.md |
| Identitas agent: IETF belum ada standar final; `draft-klrc-aiagent-auth` (Sep 2026) digantikan `draft-ietf-wimse-aims` (update 15 Sep 2026); `draft-ietf-oauth-identity-chaining` di IESG (21 Agu 2026) | [TINGGI] status | https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/ |
| Pola vendor: Microsoft Entra Agent ID (token exchange, OBO, FIC; 11 Jun 2026); AWS AgentCore Identity OBO | [SEDANG] (satu jenis sumber) | https://learn.microsoft.com/en-us/entra/agent-id/agent-oauth-protocols ; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html |
| OpenSandbox (AAIF, Alibaba): hanya judul/snippet | [RENDAH] | https://aaif.io/blog/the-sandbox-as-an-agent-primitive |
| **A2ABreak**: 11 vulnerability meski patuh spec (cross-client context injection, credential harvesting karena identitas hilang di delegasi multi-hop, exfiltration via rogue agent); arXiv 2609.10871, 9 Sep 2026 (rev 24 Okt 2026); peer review belum diketahui; presisi 73,3% klaim penulis | [SEDANG] | arXiv 2609.10871 |
| Agent Card poisoning (Keysight, 12 Mar 2026; simulasi vendor keamanan) | [SEDANG] | - |
| MCP tool poisoning / prompt injection: CSA research note 1 Jul 2026 (snippet Bing saja) | [SEDANG] | - |
| Debat "MCP vs CLI/Skills" sejak Mar 2026: untuk tool lokal (git, gh) CLI/Skills sering lebih ringan (Milvus 1 Apr 2026; Better Claw 15 Jun 2026, snippet); sanggahan Growth Method 7 Sep 2026 | [RENDAH-SEDANG] | - |

### 11.5 Manajemen konteks

Fakta utama sudah dirangkum di bagian 5.4. Rincian tambahan dan sumber:

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| Window 1M token default (tanpa beta header), output hingga 128k, untuk model terkini; Sonnet 4.5 dkk 200k | [TINGGI] | https://platform.claude.com/docs/en/build-with-claude/context-windows |
| Context rot diakui vendor; "attention budget" | [TINGGI] | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Chroma "Context Rot" (14 Jul 2025, 18 LLM generasi lama): performa makin tidak konsisten seiring panjang input | [TINGGI] isi, model lama | https://research.trychroma.com/context-rot |
| Kompaksi tidak cukup; kegagalan: one-shot lalu fitur setengah jadi; agent melihat kemajuan lalu menyatakan selesai (26 Nov 2025, diubah 18 Okt 2026) | [TINGGI] | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| Reset vs kompaksi, "context anxiety" (24 Mar 2026); Opus 4.5 satu sesi kontinu + auto-compaction, build koheren > 2 jam, run penuh ~4 jam / $124 | [TINGGI] | https://www.anthropic.com/engineering/harness-design-long-running-apps |
| Yang selamat/hilang saat kompaksi di Claude Code | [TINGGI] | https://code.claude.com/docs/en/context-window.md ; https://code.claude.com/docs/en/memory.md |
| Hook `SessionStart[compact]`, `PreCompact`/`PostCompact` | [TINGGI] | https://code.claude.com/docs/en/hooks-guide.md ; https://code.claude.com/docs/en/hooks.md |
| Auto-compact window: `/autocompact 500k`, `autoCompactWindow`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; idle compaction pada TTL 1 jam | [TINGGI] | https://code.claude.com/docs/en/model-config.md |
| Tool-result clearing API: `clear_tool_uses_20250919`, `clear_thinking_20251015` (beta `context-management-2025-06-27`); clearing menginvalidasi cache | [TINGGI] | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| Klaim memory tool + editing +39%, editing saja +29%, token -84% (100 turn): benchmark internal vendor | [SEDANG] | https://www.anthropic.com/news/context-management |
| Caching: cache read 0.1x harga input (0.05x Opus/Sonnet 5.5; 0.025x Fable/Mythos 5.1); tulis 5 menit 1.25x, 1 jam 2x; impas setelah 1 read (5m) / 2 read (1h); ubah tool defs/thinking/effort menginvalidasi | [TINGGI] | https://platform.claude.com/docs/en/about-claude/pricing ; https://code.claude.com/docs/en/prompt-caching.md |
| Pola handoff: `init.sh`, `claude-progress.txt`, `feature_list.json` (200+ fitur, field `passes`) + commit git | [TINGGI] | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (catatan menulis `.../memory-tool.md`) |
| Insiden pengguna pasca-kompaksi: #19471 (20 Jan 2026), #21925 (30 Jan 2026), #9796 (17 Okt 2025), #32659 (10 Mar 2026) | [SEDANG] | https://github.com/anthropics/claude-code/issues/19471 ; .../21925 ; .../9796 ; .../32659 |

### 11.6 Keamanan, biaya, observability

Insiden dan guardrail ada di bagian 9. Sumber tambahan: MAPI https://raids-lab.com/publications/yu2026mapi/ [SEDANG]; https://arxiv.org/abs/2608.00747 [SEDANG]; CLI reference https://code.claude.com/docs/en/cli-reference [TINGGI]; blog nested subagent 5 level https://ofox.ai/blog/claude-code-nested-subagents-2026/ [RENDAH-SEDANG]; OTel https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md [TINGGI]; "false success" Advani https://arxiv.org/abs/2606.09863 (1 Jun 2026, FAGEN@ICML2026): 45-48% kegagalan di tau2-bench single-control, 75,8% pada coding-agent AppWorld yang mengklaim status [TINGGI isi, SEDANG generalisasi].

### 11.7 Memori jangka panjang

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| Memory tool client-side (view/create/str_replace/insert/delete/rename di `/memories`), stable; saran expiry, cap ukuran, validasi path traversal | [TINGGI] | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool |
| Compaction server-side (beta header `compact-2026-09-04`); disarankan dipakai BERSAMA memory | [TINGGI] | https://platform.claude.com/docs/en/build-with-claude/compaction |
| Teknik rekomendasi Anthropic (29 Sep 2025): hybrid retrieval, structured note-taking, sub-agent mengembalikan ringkasan 1.000-2.000 token; kompaksi agresif bisa membuang konteks penting | [TINGGI] | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Multi-agent research (13 Jun 2025): lead menyimpan rencana ke Memory karena konteks > 200K dipotong; output subagent ke filesystem (kurangi "game of telephone") | [TINGGI] | https://www.anthropic.com/engineering/multi-agent-research-system |
| Letta Context Repositories (12 Feb 2026): memori = file di git, tiap perubahan = commit; `system/` selalu dimuat; subagent menulis memori paralel di worktree lalu merge; reflection background + defragmentation ke ~15-25 file | [TINGGI] | https://www.letta.com/blog/context-repositories/ |
| Letta: filesystem biasa + gpt-4o-mini 74,0% LoCoMo (12 Agu 2025) | [SEDANG] klaim vendor | https://www.letta.com/blog/benchmarking-ai-agent-memory/ |
| Mem0 (arXiv 2504.19413, 28 Apr 2025): +26% relatif atas OpenAI memory, p95 latensi -91%, > 90% hemat token vs full-context; self-reported LoCoMo 92,5, LongMemEval 94,4, BEAM 64,1 (1M) -> 48,6 (10M) | [TINGGI] isi paper, [SEDANG] kebenaran | arXiv 2504.19413 ; https://mem0.ai/blog/state-of-ai-agent-memory-2026 (update 10 Okt 2026) |
| Zep/Graphiti (arXiv 2501.13956, 20 Jan 2025): DMR 94,8% vs 93,4% MemGPT, LongMemEval hingga +18,5%, latensi -90% | [TINGGI] isi paper | arXiv 2501.13956 |
| LongMemEval (ICLR 2025): asisten komersial dan LLM long-context turun ~30% pada sesi panjang | [TINGGI] | https://arxiv.org/abs/2410.10813 |
| Audit independen LoCoMo (Feb-Apr 2026): 6,4% answer key salah (99/1.540); LLM judge menerima 62,8% jawaban sengaja salah-samar; pihak ketiga 38,38% untuk sistem yang mengklaim 92,32%; kategori adversarial (22,5%) tak dievaluasi | [SEDANG], belum direplikasi | https://github.com/dial481/locomo-audit |
| Perseteruan Mem0-Zep soal LoCoMo (6 Mei 2025). Skor vendor tidak boleh jadi dasar keputusan | - | https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ |
| Staleness: STALE (arXiv 2605.06527, 7 Mei 2026) model terbaik 55,2%; arXiv 2608.04574 (5 Agu 2026) | [TINGGI] / [RENDAH] generalisasi | arXiv ID |
| Memory poisoning: arXiv 2606.04329 (3 Jun 2026), arXiv 2606.24322 (23 Jun 2026), MINJA arXiv 2601.05504 (9 Jan 2026; lebih lemah jika sudah ada memori sah, EHR, model kecil) | [TINGGI] / [SEDANG] / [RENDAH] generalisasi | arXiv ID |

### 11.8 State, ledger, durable execution

Isi desain di bagian 6. Sumber dan label:

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| Temporal dipakai tim agent besar (klaim Temporal sendiri, 16 Jul 2026); integrasi OpenAI Agents SDK-Temporal 30 Jul 2025 | [SEDANG] / [TINGGI] keberadaan | https://temporal.io/blog/temporal-langgraph-plugin-durable-execution ; https://temporal.io/blog/announcing-openai-agents-sdk-integration |
| Restate: Virtual Objects dikunci per session; satu binary, log-first, snapshot ke S3 | [TINGGI] | https://docs.restate.dev/ai/patterns/sessions ; https://docs.restate.dev/references/architecture |
| DBOS: plugin Google ADK + backend SQLite untuk Go v0.17 (18 Jun 2026); DBOS Python: SQLite didukung tetapi "Postgres is recommended for production". Runtime webterm = Bun/TS; dukungan SQLite DBOS TS tak diverifikasi | [TINGGI] | https://www.dbos.dev/blog/new-in-dbos-june-2026 ; https://docs.dbos.dev/python/tutorials/database-connection |
| Checkpoint LangGraph bukan durable execution (kill+resume mengulang tool call; checkpoint > 1.2 GB setelah 2.000 run tanpa TTL; tak ada commit atomik side effect+checkpoint), uji lab Effloow 5 Sep 2026 | [RENDAH-SEDANG] | https://effloow.com/articles/langgraph-checkpointing-postgres-gotchas-2026 |
| Anthropic feature list JSON, progress file, git commit (26 Nov 2025) | [TINGGI] | https://www.anthropic.com/research/effective-harnesses-for-long-running-agents |
| Managed Agents (8 Apr 2026): harness tanpa state, `wake(sessionId)` | [TINGGI] | https://www.anthropic.com/research/managed-agents |
| Context reset + structured handoff > compaction (24 Mar 2026) | [TINGGI] | https://www.anthropic.com/research/harness-design-long-running-apps |
| Event sourcing ESAA (arXiv:2602.23193, 26 Feb 2026) | [SEDANG] | https://www.agentpatterns.ai/observability/event-sourcing-for-agents/ |
| WAL untuk intent agent | [RENDAH] | https://tianpan.co/blog/2026/04/12/write-ahead-logging-for-ai-agents-crash-safe-execution |
| codex-orchestrator v2 ledger + heartbeat | [SEDANG] | https://github.com/indiekitai/codex-orchestrator/blob/main/docs/v2-persistent-ledger-and-heartbeat.md |
| SQLite WAL + `synchronous=FULL` ~1.000 commit/detik, single-writer (1 Jul 2026) | [SEDANG] | https://www.pedroalonso.net/blog/durable-llm-workflows-sqlite/ |
| WAL tidak jalan di network FS, semua proses satu host | [TINGGI] | https://www.sqlite.org/wal.html |
| Durable execution engine di atas SQLite (Morling, 20 Nov 2025) | [SEDANG] | https://www.morling.dev/blog/building-durable-execution-engine-with-sqlite/ |
| Klaim "Replit/Cursor/Codex jalan di Temporal" dari agregator: tidak diverifikasi | - | - |

### 11.9 Human-in-the-loop

Fakta dan angka sudah ditempatkan di bagian 8. Sumber:

| Temuan | Label | Sumber (tanggal) |
|---|---|---|
| 93% permission prompt disetujui; auto mode bertingkat; classifier false-negative 17% (n=52); default auto mode sejak 14 Agu 2026 (Pro/Max/Team) | [TINGGI] (default auto mode: [SEDANG]) | https://www.anthropic.com/research/claude-code-auto-mode (25 Mar 2026) |
| Factory Autonomy Level, rule `block`/`ask` | [TINGGI] | https://docs.factory.ai/autonomy-and-safety/auto-run.md |
| Agent bertanya sendiri; kalibrasi trust (< 50 vs > 750 sesi) | [TINGGI] | https://www.anthropic.com/research/measuring-agent-autonomy (Feb 2026) |
| GitHub Agent HQ: mission control, identitas per agent; aturan approval PR Copilot | [TINGGI] | https://github.blog/news-insights/company-news/welcome-home-agents/ (28 Okt 2025) |
| Checkpointing Claude Code tidak melacak perubahan Bash/subagent/eksternal | [TINGGI] | https://code.claude.com/docs/en/checkpointing |
| Studi 33.596 PR, 41,7% vs 19,8% | [SEDANG], sekunder | - |

---

## 12. Peta jalan bertahap

Aturan yang berlaku untuk **setiap fase** (dari CLAUDE.md repo dan aturan global):

- Branch sendiri (`feature/`, `fix/`, `chore/<nama>`) dari branch utama; commit berkala; **tunggu konfirmasi sebelum merge**; tidak push/deploy tanpa perintah eksplisit.
- Fitur baru wajib test nyata (assertion sungguhan), dijalankan sebelum klaim selesai: `TMPDIR=/tmp/st npm run typecheck`, `TMPDIR=/tmp/st npm test`, `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`.
- Perubahan schema = file migration + dijalankan lokal + diverifikasi (Rule 4); guard idempotent.
- File health (Rule 8): satu tanggung jawab per file, batas baris per tipe, hard limit 500 baris / 20.000 karakter; jangan menambah kode ke file over-limit.
- Header/env baru berawalan `webterm`; jangan rename nama protokol `nodeterm`.
- Dokumentasi diupdate di commit yang sama bila kontrak publik berubah (Rule 16); CHANGELOG sebelum deploy (Rule 5).

Urutan di bawah mengikuti saran awal pemilik dengan **dua penyesuaian**: (a) inbox keputusan dan gate manusia (Fase 5) ditempatkan **sebelum** agent pusat (Fase 6), karena otonomi tanpa gate adalah risiko utama (bagian 8-9); (b) hardening, observability, dan eval dipisah ke fase akhir agar fase awal tetap kecil. Setiap fase berguna sendiri dan bisa dihentikan di situ.

### Fase 0: Membuka jalan (blocker teknis dan file health)

- **Tujuan:** menghilangkan blocker `Session.send` dan memberi ruang pada file yang akan disentuh fase berikutnya.
- **Branch:** dua branch terpisah, mis. `fix/session-multi-subscriber` dan `chore/split-overlimit-files` (1 commit = 1 concern).
- **Deliverable:**
  - `Session.send` menjadi himpunan subscriber (broadcast ke semua subscriber).
  - Ukur ulang ukuran file; pecah file over-limit yang dicatat: `shared/workspace.ts` (444), `api.ts` (154), `sessions.ts` (300), `SessionsPanel.tsx` (456), `App.tsx` (436), menurut `[domain].[layer]`, tanpa mengubah perilaku.
- **Kriteria selesai (bisa diuji):**
  - Test Bun: dua subscriber pada satu sesi keduanya menerima output yang sama; menutup satu subscriber tidak memutus yang lain; reconnect browser tidak mencuri stream dari subscriber lain.
  - Typecheck dan seluruh test lama tetap lulus tanpa perubahan assertion (pemecahan = refactor murni).
  - Tidak ada file yang disentuh melebihi batas Rule 8 setelah pemecahan.
- **Risiko:** semantik reconnect/replay dan urutan data dengan banyak subscriber (perlu membaca kode `sessions.ts` dulu; catatan hanya menyebut "satu slot"); regresi UI saat memecah `App.tsx`/`SessionsPanel.tsx`; angka ukuran file dari catatan bisa sudah basi.
- **Berguna sendiri:** ya (manusia dan tab kedua bisa melihat satu terminal; file lebih sehat).

### Fase 1: API headless (spawn / prompt / wait) + token berskop

- **Tujuan:** agent (dan skrip) dapat membuat dan menggerakkan sesi tanpa browser, dengan otoritas yang dibatasi.
- **Branch:** `feature/headless-agent-api`.
- **Deliverable:**
  - File route REST baru yang membungkus `sessions.open/input/close` (spawn, kirim prompt, tunggu/polling status, tutup).
  - Token berskop per sesi/agent (audience dan skop sempit, TTL pendek) menggantikan pewarisan `WEBTERM_*` penuh ke child PTY; header baru berawalan `webterm`.
  - Panggilan `stateVerified` di `hooks.ts:110` sehingga endpoint hook tidak lagi fail-open (dengan strategi kompatibilitas untuk hook yang sudah berjalan, mis. flag/migrasi).
- **Kriteria selesai:**
  - Test Bun: spawn headless tanpa klien WS; prompt dan wait mengembalikan status; sesi dapat ditutup.
  - Test negatif: token dengan skop salah/kedaluwarsa ditolak (4xx); token agent A tidak bisa mengakses sesi agent B; `/api/agent-status` dengan identitas tak valid ditolak.
  - Child PTY tidak lagi menerima kredensial berskop penuh (test memeriksa env anak, tanpa mencetak nilai secret).
- **Risiko:** kompatibilitas hook agent yang ada dengan `stateVerified` (perilaku persisnya di `hooks.ts:110` belum dibaca oleh penulis dokumen ini); desain skop token (lihat bagian 13); jangan menyentuh nama protokol `nodeterm`.
- **Berguna sendiri:** ya (otomasi lokal, dan menutup celah fail-open).

### Fase 2: Entitas project + ledger

- **Tujuan:** project menjadi objek kelas satu di atas Workspace, dengan ledger tugas yang tahan crash.
- **Branch:** `feature/project-ledger`.
- **Deliverable:** migration SQLite untuk `project`, `task`, `event`, `decision`, `agent` (bagian 6.2; `memory` menyusul di Fase 3); modul repository terpisah per tabel; endpoint baca/tulis dasar; logika lease + reconcile (bagian 6.4); versi/ETag untuk mencegah last-write-wins pada data baru.
- **Kriteria selesai:**
  - Migration idempotent dan dijalankan lokal terhadap DB berisi data.
  - Test: lease kedaluwarsa -> `pending` dan `attempt`++; `claimed_done` tidak menjadi `verified` tanpa `evidence_json`; perubahan `task` dan `event` dalam satu transaksi (simulasi kegagalan di tengah tidak meninggalkan setengah state); intent -> aksi -> outcome dapat dilanjutkan setelah "crash" tanpa mengulang efek.
  - Tulis konkuren dengan versi usang ditolak.
- **Risiko:** skema adalah sintesis belum terbukti (bagian 6); `synchronous=FULL` di macOS belum diuji; `Sessions` singleton in-memory vs state durable (rekonsiliasi dengan `agent.session_ref`); file `sessions.ts`/`api.ts` yang sudah penuh (mengandalkan Fase 0).
- **Berguna sendiri:** ya (papan tugas persisten per project bahkan untuk kerja manusia saja).

### Fase 3: Memori file + promosi claim -> fact

- **Tujuan:** memori jangka panjang terstruktur yang aman ditulis dan bisa diaudit.
- **Branch:** `feature/memory-files`.
- **Deliverable:** struktur direktori memori bergit (CORE, `facts/`, `log/`, `skills/`, `PROGRESS.md`; bagian 5.1); API/CLI untuk mengirim claim dan mempromosikan fact dengan frontmatter `source`/`verified_at`/`verify_cmd`/`supersedes`; pemeriksaan `verify_cmd` saat baca; indeks sederhana (BM25) untuk pencarian; skrip hook `PreCompact` (tulis snapshot) dan `SessionStart[compact]` (baca balik).
- **Kriteria selesai:**
  - Test: worker (token skop worker) tidak dapat menulis ke `facts/` maupun CORE; claim tanpa bukti ditolak; promosi menghasilkan commit git dengan sumber; fact yang melewati TTL ditandai "basi"; `supersedes` tidak menghapus riwayat; path traversal ditolak.
  - Uji manual: sesi Claude Code dikompaksi dan aturan kritis muncul kembali lewat hook `SessionStart[compact]`.
- **Risiko:** beban review manusia atas perubahan CORE/lintas-project; efektivitas gerbang promosi belum teruji; perilaku hook bergantung versi Claude Code (verifikasi docs saat implementasi); memori di git terpisah vs di data dir (bagian 13).
- **Berguna sendiri:** ya (membangun ulang MEMORY.md terstruktur yang dipakai lintas sesi).

### Fase 4: Orkestrator per-project

- **Tujuan:** satu sesi agent per project yang memecah task, men-spawn worker, dan memverifikasi hasil.
- **Branch:** `feature/project-orchestrator`.
- **Deliverable:** role `orchestrator` dan `worker` pada metadata agent; peluncuran orkestrator dari project; spawn worker di git worktree sendiri dengan cap (depth <= 2, konkurensi, total spawn, budget/waktu) yang **ditegakkan oleh control plane**; kontrak HTTP+JSON bentuk A2A antara orkestrator dan worker (task id, status, polling); verifikasi independen (git diff, test, typecheck) sebelum `verified`; larangan worker men-spawn atau menulis memori bersama.
- **Kriteria selesai:**
  - Test: spawn ke-(N+1) melebihi cap ditolak; worker yang mencoba spawn ditolak; worker yang mengklaim selesai tanpa perubahan diff tidak menjadi `verified`; token worker tidak dapat memanggil endpoint orkestrator.
  - Uji skenario: satu project dengan 2-3 worker menyelesaikan task kecil sampai `verified`, dan manusia dapat membuka terminal worker mana pun serta mengetik tanpa merusak stream agent (bergantung Fase 0).
- **Risiko:** biaya token ~15x untuk multi-agent (bagian 11.1) sehingga cap biaya wajib hidup dari awal; konflik semantik antar-worker walau worktree terpisah; orkestrator berbasis Claude Code mewarisi kerapuhan kompaksi (bagian 5.4); status/transkrip untuk agent non-claude belum ada, sehingga fase ini efektif Claude-first.
- **Berguna sendiri:** ya (tanpa agent pusat, manusia sudah bisa memberi tugas ke orkestrator project).

### Fase 5: Inbox keputusan dan gate manusia

- **Tujuan:** manusia menjadi bagian terstruktur dari alur, tanpa approval fatigue.
- **Branch:** `feature/decision-inbox`.
- **Deliverable:** inbox yang hanya berisi item butuh manusia (task `blocked`/`input_required`, gate); kelas gate sesuai bagian 8.2 ditegakkan di server; format laporan agent (bagian 8.3) sebagai skema; timeline event rutin terpisah; pencatatan keputusan ke tabel `decision`; klaim kepemilikan task/scope file.
- **Kriteria selesai:**
  - Test: aksi kelas "wajib manusia" (push ke remote bersama, merge, migrasi, hapus massal, credential) tidak bisa dieksekusi tanpa keputusan tercatat; aksi otomatis tidak masuk inbox; dua pemilik pada satu task atau scope file bertabrakan ditolak/diberi peringatan.
  - Uji manual: item inbox yang disetujui/ditolak mengubah status task dan tercatat di `decision`.
- **Risiko:** inbox membanjiri manusia (review bottleneck, bagian 8.6); penegakan gate server-side tidak mencakup tindakan yang dilakukan agent langsung di shell di luar kontrol webterm (batas yang harus diakui; bergantung sandbox, guardrail 3).
- **Berguna sendiri:** ya (antarmuka manusia untuk Fase 4).

### Fase 6: Agent pusat (router)

- **Tujuan:** satu pintu masuk yang mengurus banyak project tanpa menjadi komandan worker.
- **Branch:** `feature/central-agent`.
- **Deliverable:** agent pusat dengan akses baca ke indeks memori lintas-project dan ledger; kemampuan membuat project + orkestratornya atas perintah manusia; routing permintaan ke orkestrator via kontrak HTTP+JSON; laporan lintas-project; tabel `agent`/Agent Card sederhana sebagai registry internal.
- **Kriteria selesai:**
  - Test: agent pusat tidak dapat spawn worker maupun memanggil endpoint worker (hanya orkestrator); tidak dapat menulis `facts/` project atau CORE; permintaan "status semua project" dijawab dari ledger/indeks (bukan dari ingatan model) dan memuat sumber.
  - Uji manual: sesi agent pusat yang di-rotasi/dikompaksi tetap menemukan daftar project aktif dan aturannya lewat konteks "selalu hadir".
- **Risiko:** agent pusat yang mulai "mengendalikan langsung" (mengikis batas dua tier); halusinasi lintas-project bila indeks basi (mitigasi: verifikasi sebelum percaya, bagian 5.3); satu titik kegagalan; konteks pusat membengkak oleh banyak project.
- **Berguna sendiri:** ya.

### Fase 7: Hardening, observability, eval

- **Tujuan:** menutup guardrail 3, 9, dan 10 (bagian 9.1) setelah alur utama berjalan.
- **Branch:** `feature/agent-hardening` (dapat dipecah per concern).
- **Deliverable:** isolasi eksekusi per worker sesuai kebutuhan (sandbox OS/container hanya bila kode tak dipercaya; egress allowlist), tracing berbasis OTel GenAI (versi dipin), log keputusan dengan payload redacted, set golden tasks untuk eval regresi saat ganti model/prompt, kill switch.
- **Kriteria selesai:** golden tasks berjalan sebagai test/skrip yang gagal bila perilaku regresi; kill switch menghentikan semua sesi agent project dalam satu panggilan (diuji); log tidak memuat PII/credential (Rule 12).
- **Risiko:** OTel agent spans berstatus Development (dapat berubah); sandbox bisa bocor (DuneSlide), jadi bukan jaminan; biaya pemeliharaan eval.
- **Berguna sendiri:** ya.

Kandidat setelah Fase 7 (belum direkomendasikan; baru dipertimbangkan bila syarat terpenuhi): migrasi kontrak ke A2A v1 hanya bila perlu lintas-org/vendor; Temporal/Restate bila muncul kebutuhan multi-host atau timer berhari-hari; graph temporal bila kebutuhan temporal terbukti.

---

## 13. Keputusan terbuka untuk pemilik

Tiap butir: pertanyaan konkret -> **default yang direkomendasikan**.

1. **Runtime orkestrator/worker:** sesi Claude Code CLI di PTY node (terlihat manusia, memakai `hookStatus` yang sudah ada) atau Claude Agent SDK (headless)? -> Default: Claude Code di PTY node dulu; pertimbangkan SDK bila butuh `SessionStore`/`maxBudgetUsd` dan setelah lisensi TS SDK jelas (bagian 15).
2. **Vendor:** Claude-first atau agnostik sejak awal? -> Default: Claude-first; status/transkrip non-claude belum ada di webterm, jadi agnostik adalah tahap lanjutan.
3. **Lokasi repo memori:** git terpisah atau subfolder di `WEBTERM_DATA_DIR`? -> Default: repo git terpisah di bawah data dir, supaya riwayat dan review tidak tercampur dengan kode.
4. **Siapa penulis CORE:** hanya manusia, agent mengusulkan lewat PR? -> Default: ya (sesuai tabel 5.1).
5. **Skala pengguna:** satu pengguna/satu mesin, atau multi-pengguna/multi-host? -> Default: satu mesin (SQLite WAL cukup); multi-host adalah pemicu mempertimbangkan engine durable.
6. **Cap awal:** berapa worker paralel per orkestrator, berapa total spawn/project, batas biaya/waktu per level? -> Default: konkurensi 3-5 (angka docs Anthropic untuk teammates; judgement), depth <= 2, angka biaya ditetapkan pemilik; **cap harus memblokir**. Angka konkret biaya tidak ada di catatan.
7. **Gate wajib manusia:** setuju dengan daftar bagian 8.2 (push remote bersama, merge, migrasi/schema, credential, hapus massal, aksi di luar project)? -> Default: ya, dimulai ketat, dilonggarkan per jenis aksi setelah track record.
8. **`stateVerified` fail-closed:** boleh mematahkan hook lama demi menutup celah? -> Default: ya, dengan flag transisi satu rilis.
9. **Rotasi sesi agent:** pakai heuristik bagian 5.4 (setelah handoff, 1-2 kompaksi, pelanggaran constraint)? -> Default: ya sebagai awal; ukur sendiri, karena tidak ada angka resmi [RENDAH].
10. **AGENTS.md atau CLAUDE.md:** -> Default: tetap CLAUDE.md untuk Claude Code; AGENTS.md hanya sebagai tambahan bila ada agent lain, karena dukungan Claude Code belum terverifikasi.
11. **Sandbox:** kapan butuh isolasi OS/container per worker? -> Default: tunda ke Fase 7, kecuali worker menjalankan kode yang tak dipercaya; worktree + token berskop sejak Fase 1.
12. **Nasib Fase 0:** boleh dipecah menjadi dua branch (bug multi-subscriber vs pemecahan file)? -> Default: ya.
13. **Kebutuhan fitur cloud/PR:** apakah ada alasan bersaing di sana? -> Default: tidak; fokus local-first, lintas-vendor, manusia di terminal nyata.

---

## 14. Konflik antar-sumber yang belum terselesaikan

1. **Kedalaman subagent bersarang di Claude Code dilaporkan berbeda dan BELUM diverifikasi ke changelog resmi.**
   - Docs Agent SDK (catatan framework): `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` **default 3** lapis di bawah main agent; berlaku TS v0.3.219+ / Python v0.2.127+ [TINGGI]. https://code.claude.com/docs/en/agent-sdk/subagents
   - Blog pihak ketiga (catatan keamanan): subagent bisa bersarang **sampai 5 level** (Claude Code v2.1.172, 10 Jun 2026) [RENDAH-SEDANG]. https://ofox.ai/blog/claude-code-nested-subagents-2026/
   - Kemungkinan keduanya benar pada versi/konfigurasi berbeda, atau salah satu keliru; catatan tidak membuktikan yang mana. Changelog resmi untuk nested subagent 5 level tercatat tidak terverifikasi.
   - **Rekomendasi desain (depth <= 2) tidak bergantung pada angka mana pun**: batas ditegakkan oleh control plane webterm, dan angka default Claude Code hanya relevan bila memakai nesting bawaan di dalam sesi.
   - Blog yang sama melaporkan default subagent mewarisi semua tool induk dan allowlist `Agent(a,b)` diabaikan di subagent bersarang [RENDAH-SEDANG]. Bila benar, itu menambah alasan untuk tidak mengandalkan nesting bawaan.
2. **Dukungan AGENTS.md di Claude Code tidak pasti:** hanya dari blog sekunder (v2.1.277, 18 Sep 2026); tidak terverifikasi. Mitigasi: tetap simpan CLAUDE.md.
3. **Rekomendasi framework vs rekomendasi hierarki:** catatan framework menyebut subagent bersarang "depth <= 3" sebagai opsi di tingkat 2-3, sedangkan guardrail keamanan dan catatan hierarki mendukung depth <= 2. Dokumen ini memilih depth <= 2 (lebih ketat, bukti kedalaman tidak ada: bagian 3).
4. **Memori ditulis worker atau tidak:** Letta melaporkan subagent menulis memori paralel di worktree lalu merge, sedangkan rancangan di sini melarang worker menulis memori bersama dan memakai gerbang claim -> fact. Perbedaan ini disengaja (alasan: memory poisoning/laundering, bagian 5.2) tetapi belum ada bukti empiris bahwa salah satu lebih baik di webterm.
5. **Persentase auto-approve:** 93% (Anthropic, 25 Mar 2026) vs 97% (TechCrunch, 9 Agu 2026): dua angka dari vendor yang sama dengan arah yang sama; tidak diketahui apakah berbeda metode/periode.
6. **Tanggal rilis A2A v1.0:** Towards AI menyebut "April", GitHub menyebut 12 Mar 2026; dipakai GitHub.
7. **Path URL artikel Anthropic yang sama berbeda antar-catatan:** `harness-design-long-running-apps` dan `effective-harnesses-for-long-running-agents` ditulis di bawah `/engineering/` (catatan konteks) dan di bawah `/research/` (catatan state). Dicantumkan apa adanya; kedua path belum dicek ulang.
8. **Perbaikan bug kompaksi:** laporan issue GitHub (instruksi CLAUDE.md terabaikan pasca-kompaksi) vs klaim docs saat ini bahwa CLAUDE.md di-inject ulang. Belum jelas apakah #19471/#21925 sudah diperbaiki.
9. **Hasil benchmark memori:** klaim LoCoMo vendor (Mem0 92,5 / 92,32, Letta 74,0) vs audit independen (38,38% untuk sistem yang mengklaim 92,32%; 6,4% answer key salah). Skor vendor tidak dipakai sebagai dasar.
10. **Orca "111k stars":** angka belum divalidasi; fitur [TINGGI], stars [SEDANG].

---

## 15. Daftar gabungan "TIDAK TERVERIFIKASI"

**Hierarki**
- Perbandingan kedalaman hierarki 2 vs 3.
- Tingkat laporan palsu antar-level.
- MAST pada model 2026.
- Bantahan independen terhadap klaim vendor.

**Kode webterm lokal (catatan 1b)**
- Ukuran file terkini dan perilaku persis `Session.send`/`stateVerified` (angka dikutip dari catatan; dokumen ini tidak mengukur ulang).

**Produk / prior art**
- Harga semua produk; lisensi/harga Factory, Devin, Cursor.
- Post-mortem pihak ketiga (bantahan hanya dari docs vendor).
- 111k stars Orca; rilis Claude Squad/OpenHands (GitHub API rate limit).
- Adopsi nyata Conductor/Orca/cw/squadrant.
- Docs Amp "Agent to Agent" (gagal diekstrak).
- Agent HQ pasca Okt 2025; Codex cloud.
- Perilaku nyata steering/pause/inbox di Cursor/Devin/Factory (hanya docs/changelog).

**Framework**
- Lisensi sebenarnya Claude Agent SDK TS.
- Nesting > 1 level Deep Agents; CrewAI Flow -> Crew -> Flow; persistence/nesting ADK.
- Detail Pydantic AI, Mastra, Strands.
- Kasus produksi/post-mortem hierarki 3 tingkat 2026 (tidak ditemukan).
- Klaim dari ingatan peneliti.

**Protokol**
- AGENTS.md di Claude Code v2.1.277.
- Angka adopsi A2A/MCP/AGENTS.md.
- CVE-2026-22252 dan CVE-2026-22688 (snippet saja).
- Status final `draft-ietf-wimse-aims`.
- Hubungan AGNTCY-AAIF; detail OpenSandbox.
- Ekstensi DPoP/token binding; kegunaan Server Cards untuk discovery internal.
- Sebagian halaman dibaca terpotong 2-5 ribu karakter.
- Peer review A2ABreak (arXiv 2609.10871).

**Konteks**
- Studi 2026 context rot untuk model 5.x (hanya Chroma Jul 2025).
- Default `trigger`/`keep` pada tool-result clearing.
- Tanggal pasti anthropic.com/news/context-management.
- Batas umur sesi aman.
- Apakah bug #19471/#21925 sudah diperbaiki; kebenaran klaim pelapor issue.
- Klaim dari ingatan ("lost in the middle", MRCR/NoLiMa) tidak dipakai.

**Keamanan**
- Angka dari blog SEO ("9 detik", "75% lie about done" di luar paper).
- Isi paper MAPI/Springer/Prompt Infection selain abstrak.
- Dukungan Langfuse/LangSmith terhadap OTel GenAI.
- Regresi perilaku saat ganti model (blog vendor converra.ai, tidak dibaca).
- Changelog resmi nested subagent 5 level.
- Bukti insiden multi-agent lintas-agent nyata (semua insiden = single-agent/supply chain).
- Isi OWASP ASI02-ASI10 hanya dari blog rilis.
- Nomor CVE DuneSlide dan advisory primer insiden Cline belum diperiksa ke sumber utama.

**Memori**
- Angka 74% Letta, 92,5/94,4 Mem0, klaim Zep (vendor, tanpa replikasi independen).
- Statistik "65% kegagalan enterprise karena context drift" (agregator, tidak dipakai).
- LangMem 2026 dan Graphiti pasca-Jan 2025.
- Post-mortem produksi publik memori basi/terkontaminasi (tidak ditemukan).
- Halaman Chroma, repo lhl/agentic-memory, paper GhostWriter tidak dibuka; dokumen context-editing dan detail threshold compaction gagal dimuat di catatan memori.

**State**
- SQLite di DBOS TS.
- Adopsi nyata Restate/Inngest/DBOS oleh tim agent produksi.
- Valuasi Temporal (snippet).
- Perilaku `synchronous=FULL` di `bun:sqlite` macOS (`F_FULLFSYNC` tak diuji).
- Skema ledger = sintesis, bukan pola terbukti.
- Post-mortem kegagalan event sourcing untuk agent (tidak ditemukan).

**HITL**
- Perilaku nyata steering/pause/inbox di Cursor/Devin/Factory.
- Preferensi pengguna kuantitatif per fitur.
- Angka 89% vs 13,6% dan 41,7% vs 19,8% belum dicek ke sumber asli.
- Detail Agent HQ pasca Okt 2025.
- Artikel Ars Technica (9 Okt 2026) terblokir.
- Dua halaman docs Claude Code (worktree, auto-mode-config) tidak dibaca.

---

## 16. Lampiran: daftar sumber (URL unik per track)

Hanya URL yang tercantum di catatan riset. Item bertanda "(ID)" tidak punya URL di catatan dan hanya dirujuk lewat nomor arXiv.

**Hierarki dan produk**
- https://www.anthropic.com/engineering/multi-agent-research-system
- arXiv 2512.08296 (ID); arXiv 2503.13657 (ID)
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/agent-view.md
- https://code.claude.com/docs/en/claude-projects.md
- https://code.claude.com/docs/llms.txt
- https://github.blog/changelog/2026-10-28-github-copilot-app-universe-releases/
- https://github.blog/news-insights/company-news/welcome-home-agents/
- https://docs.factory.com/workstreams/overview.md
- https://docs.devin.ai/product-guides/memory.md
- https://docs.devin.ai/llms.txt
- https://cursor.com/docs/cloud-agent.md
- https://cursor.com/changelog
- https://learn.chatgpt.com/docs/customization/memories.md
- https://ampcode.com/manual/orbs
- https://jules.google/docs
- https://github.com/stablyai/orca
- https://www.conductor.build/pricing

**Framework**
- https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk
- https://github.com/anthropics/claude-agent-sdk-python
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://platform.claude.com/docs/en/managed-agents/multi-agent
- https://github.com/openai/openai-agents-python
- https://github.com/langchain-ai/langgraph
- https://docs.langchain.com/oss/python/deepagents/subagents
- https://docs.langchain.com/oss/python/langchain/multi-agent
- https://docs.crewai.com/en/concepts/checkpointing
- https://github.com/microsoft/agent-framework
- https://learn.microsoft.com/en-us/agent-framework/workflows/
- https://github.com/google/adk-python
- https://cognition.ai/blog/dont-build-multi-agents

**Protokol**
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://modelcontextprotocol.io/extensions/overview
- https://modelcontextprotocol.io/extensions/tasks/overview.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- https://aaif.io/news/agentic-ai-foundation-announces-four-new-projects
- https://github.com/a2aproject/A2A/releases
- https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/
- https://a2a-protocol.org/latest/specification/
- https://agentskills.io/specification
- https://agents.md
- https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/
- https://learn.microsoft.com/en-us/entra/agent-id/agent-oauth-protocols
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html
- https://aaif.io/blog/the-sandbox-as-an-agent-primitive
- arXiv 2609.10871 (ID)

**Manajemen konteks**
- https://platform.claude.com/docs/en/build-with-claude/context-windows
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://research.trychroma.com/context-rot
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://code.claude.com/docs/en/context-window.md
- https://code.claude.com/docs/en/memory.md
- https://code.claude.com/docs/en/hooks-guide.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/model-config.md
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://www.anthropic.com/news/context-management
- https://platform.claude.com/docs/en/about-claude/pricing
- https://code.claude.com/docs/en/prompt-caching.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- https://github.com/anthropics/claude-code/issues/19471 (juga /21925, /9796, /32659 di repo yang sama)

**Keamanan**
- https://raids-lab.com/publications/yu2026mapi/
- https://arxiv.org/abs/2608.00747
- https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-confused-deputy-prompt-injection/
- https://blog.railway.com/p/your-ai-wants-to-nuke-your-database
- https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html
- https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-ai-npm-supply-chain-attack-2026/
- https://cursor.com/blog/claude-code-extension-security-notice
- https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/
- https://code.claude.com/docs/en/sandboxing
- https://ofox.ai/blog/claude-code-nested-subagents-2026/
- https://code.claude.com/docs/en/cli-reference
- https://www.theregister.com/saas/2026/05/14/bedrock-and-a-hard-place-claude-adventure-leaves-aws-user-staring-down-30k-invoice/5238153
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- https://arxiv.org/abs/2606.09863

**Memori**
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://www.letta.com/blog/context-repositories/
- https://www.letta.com/blog/benchmarking-ai-agent-memory/
- https://mem0.ai/blog/state-of-ai-agent-memory-2026
- https://arxiv.org/abs/2410.10813
- https://github.com/dial481/locomo-audit
- https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- arXiv 2504.19413, 2501.13956, 2605.06527, 2608.04574, 2606.04329, 2606.24322, 2601.05504 (ID)

**State**
- https://temporal.io/blog/temporal-langgraph-plugin-durable-execution
- https://temporal.io/blog/announcing-openai-agents-sdk-integration
- https://docs.restate.dev/ai/patterns/sessions
- https://docs.restate.dev/references/architecture
- https://www.dbos.dev/blog/new-in-dbos-june-2026
- https://docs.dbos.dev/python/tutorials/database-connection
- https://effloow.com/articles/langgraph-checkpointing-postgres-gotchas-2026
- https://www.anthropic.com/research/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/research/managed-agents
- https://www.anthropic.com/research/harness-design-long-running-apps
- https://www.agentpatterns.ai/observability/event-sourcing-for-agents/
- https://tianpan.co/blog/2026/04/12/write-ahead-logging-for-ai-agents-crash-safe-execution
- https://github.com/indiekitai/codex-orchestrator/blob/main/docs/v2-persistent-ledger-and-heartbeat.md
- https://www.pedroalonso.net/blog/durable-llm-workflows-sqlite/
- https://www.sqlite.org/wal.html
- https://www.morling.dev/blog/building-durable-execution-engine-with-sqlite/
- arXiv:2602.23193 (ID)

**HITL**
- https://www.anthropic.com/research/claude-code-auto-mode
- https://docs.factory.ai/autonomy-and-safety/auto-run.md
- https://www.anthropic.com/research/measuring-agent-autonomy
- https://github.blog/news-insights/company-news/welcome-home-agents/
- https://code.claude.com/docs/en/checkpointing

---

## 17. Addendum 2026-10-31 — Omnichannel

Status: tambahan setelah wave 6. Detail: `../04-OMNICHANNEL.md`; requirement O1-O22:
`../02-KEBUTUHAN.md`; fase P5: `../03-RENCANA.md`.

Kesimpulan:

- Kanal eksternal (Telegram, webhook, Slack, dll.) adalah **adapter ingress tidak tepercaya**,
  bukan control plane kedua. Semua perintah masuk ke control API dan ledger yang sama.
- Telegram v1: webhook `secret_token`, dedupe `update_id`, topic per project, satu pesan
  status editable per task, inline approval, batas 4096 char / 64 byte callback.
- Approval chat tetap blocking: digest + nonce + expiry + single-use + identitas terikat.
  Teks "yes" bukan decision; group read-only dan tidak boleh approve.
- Identity: kode link sekali pakai, allowlist numeric user id, role subset principal.
  Unknown sender ditolak diam-diam + audit, bukan auto-enroll.
- Reliability: 200 setelah persist, outbox transaksional, retry/backoff, 429 `retry_after`,
  dead-letter, ordering per conversation. Channel down tidak memblokir ledger.
- Security: token bot di Keychain/0600, tidak di env PTY, log, settings JSON, atau URL.
  Callback opaque + MAC; audit hash chain; redaksi egress.
- Fase: P5 setelah P3/P4. Gate G7: replay 100x satu aksi, cross-project ditolak,
  approval blocking, channel down tidak memblokir ledger, token tidak ada di env/log.

Slack, Discord, WhatsApp, SMS, email ditunda. WhatsApp/SMS butuh template/10DLC dan biaya
per pesan; email lemah untuk approval interaktif. Multi-user RBAC tetap defer.
