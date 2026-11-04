# 05 — Risiko, model keamanan, verifikasi, biaya, pertanyaan terbuka

## 1. Model keamanan

### 1.1 Batas kepercayaan yang jujur

| Lapisan | Melindungi dari | **Tidak** melindungi dari |
|---|---|---|
| Token root + same-origin `human-ui` (`approvalAuth.ts`) | Halaman web lain, agent yang patuh | Proses ber-uid sama yang membaca file secret |
| Tier, level, grant, `controlGuard` | Agent patuh yang memanggil lewat API | Agent yang dibajak lalu menulis langsung ke `ledger.db` |
| File 0600 | User lain di mesin | Proses ber-uid sama (semua agent node) |
| Trigger append-only SQLite | Bug aplikasi | Proses ber-uid sama (bisa `DROP TRIGGER`) |
| Hash chain + anchor eksternal | Manipulasi diam-diam (jadi **terdeteksi**) | Manipulasi itu sendiri (masih **bisa dilakukan**) |
| Deny `Read` di settings Claude + sandbox Claude Code | Claude yang terkena injeksi | Codex/Gemini tanpa sandbox. Ini diberi label "mitigasi" |
| Batas sesungguhnya | uid terpisah atau sandbox OS per node | Saat ini **belum ada**. Ini syarat untuk membuka grant berantai (#31) |

Konsekuensinya, F0 wajib selesai sebelum F2 memperbesar kuasa agent. Setiap layar yang menampilkan level atau grant juga menampilkan status perlindungan per jenis agent (A3).

### 1.2 Prompt injection

| Vektor | Kontrol | Fase |
|---|---|---|
| Halaman di browser node | Taint `untrusted` pada event/konten. Tidak bisa memicu tier ≥R2. Tidak bisa jadi memori prosedural/semantic global | F1, F4, F5 |
| Memory poisoning (persisten, dimuat ulang tiap sesi) | Ekstraksi hanya dari pesan user dan hasil tool berprinsipal tepercaya. Ada `source_event_id`, label `unverified`, tombstone, dan test poisoning sebagai kriteria keluar F5 | F5 |
| Output terminal atau file repo ("abaikan instruksi…") | Diperlakukan sebagai data di blok konteks (pola `memoryBlock.ts` sudah ada), dengan tag sumber | F2 |
| Classifier auto-approve ikut tertipu | Input classifier = aksi + argumen saja, tanpa konten web. `destructive` tidak bisa di-override | F4 |
| Chat Telegram disusupi | Hanya approve sekali. Pola permanen hanya dari UI (K4). Tetap R3 web saja (keputusan P6) | F3 |
| Handoff membawa secret | Filter konteks dengan redaksi sebelum diteruskan | F4 |
| Agent menerbitkan grant untuk agent lain | Ditolak (K3). Hanya atenuasi | F1 |

### 1.3 Secret broker

- `secret.use(name, purpose)` adalah capability R2. Nilainya disuntik ke env proses anak atau dipakai server, tidak pernah dikembalikan ke konteks model, dan setiap pemakaian diaudit sebagai event tanpa nilai.
- Penyimpanan: Keychain macOS **[V]** (ACL item per aplikasi, perilaku prompt untuk proses bun, akses dari proses `security` ber-uid sama).
- Log dan event tidak pernah memuat nilai secret. Redaksi diterapkan sebelum tulis (Rule 7/12).

## 2. Hal yang harus DIVERIFIKASI sebelum membangun

Laporan 02 ([`rnd/02-harness-landscape.md`](rnd/02-harness-landscape.md)) menyebut beberapa klaim protokol yang belum dicek ulang sendiri. Sesuai Rule 20, semua item berikut wajib diverifikasi di gelombang studi WP terkait. Bila hasilnya berbeda dari asumsi, rencana direvisi sebelum kode ditulis.

| # | Item | Dipakai di | Yang dicek | Sumber |
|---|---|---|---|---|
| V1 | MCP 2026-07-28: stateless, `server/discover` wajib, MRTR, sampling/roots/logging deprecated, `ttlMs`/`cacheScope`, `subscriptions/listen` | F2-a | Changelog resmi + dukungan klien di Claude Code, Codex, OpenCode, dan Gemini versi terpasang (apakah sudah bicara 2026-07-28 atau masih versi lama, perlu dual-mode?) | modelcontextprotocol.io/specification/2026-07-28/changelog |
| V2 | Claude Code channels (`claude/channel`): status research preview, allowlist, flag `--dangerously-load-development-channels`, relay izin | F2-d | Apakah channel kustom bisa jalan tanpa flag *dangerous*. Kalau tidak bisa, channel tetap adapter yang tidak aktif secara default | code.claude.com/docs/en/channels-reference |
| V3 | Format balasan `PermissionRequest` (`decision` allow/deny, `updatedInput`, `defer`) dan perilaku timeout | F3-b | Skema output hook pada versi Claude Code terpasang. Test hook nyata | code.claude.com/docs/en/hooks |
| V4 | Hook/plugin Codex, OpenCode, Gemini (event apa yang tersedia, format config MCP masing-masing) | F2-a, F2-e | Dokumen dan binary terpasang per CLI | docs masing-masing |
| V5 | Sandbox Claude Code dan `permissions.deny` untuk path di luar cwd | F0-a | Apakah deny `Read(~/.webterm-server/**)` juga berlaku untuk `Bash(cat …)`, subshell, dan loop | code.claude.com/docs/en/permissions |
| V6 | Kebocoran env token per proses ke proses ber-uid sama (`ps eww`, `KERN_PROCARGS2` di macOS) | F0-a | Apakah sibling agent bisa membaca env proses agent lain. Kalau bisa, pakai fd/pipe atau token sekali pakai yang ditukar saat start | uji lokal |
| V7 | `bun:sqlite`: `ATTACH` dengan URI `mode=ro`, trigger, WAL lintas file attach | F1-f, F1-c | Uji lokal | docs Bun |
| V8 | Keychain dari proses Bun (`security` CLI vs API), ACL, perilaku tanpa GUI | F0-a, F2-f | Uji lokal | Apple docs |
| V9 | `monaco-languageclient` 11.x + `@codingame/monaco-vscode-api` vs versi `monaco-editor` terpasang | F6 | npm + README | 05 G9 |
| V10 | ACP v2 (`session/update` state, `$/cancel_request`) dan dukungan per agent | F6 | agentclientprotocol.com | 02 §7 |
| V11 | Skills over MCP (SEP-2640 Final), MCP Apps Stable, Tasks extension | F5, F6 | Status spesifikasi | 02 §10 |
| V12 | Codex app-server: stdio stabil, WS eksperimental, skema `generate-json-schema` | F6 | Rilis Codex terpasang | 02 §4 |
| V13 | Batas prompt cache (lookback 20 blok, minimum 512 token, harga hit/write 1 jam) untuk model yang dipakai Central | F5-d | Docs prompt caching | 03 §3 |
| V14 | Web Notifications dan Web Push saat diakses via non-loopback/HTTP (butuh secure context) | F0-b, F6 | Perilaku browser saat akses dari LAN | MDN |

## 3. Risiko teknis

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Banjir event (`bun install`, fsWatch) | CPU dan wake berlebihan | Debounce per sumber, `dedupe_key`, filter `.git`/`node_modules` (sudah ada di fsWatch), abaikan path yang di-lease |
| Migrasi ledger V10+ di DB berisi data | Kehilangan data | Migration idempotent, backup file sebelum migrasi, `channels.json.bak`, test migrasi dari snapshot V9 |
| Checkpoint tidak menangkap repo non-git atau file ignored (`.env`) | Rewind tidak lengkap | Peringatan eksplisit di timeline, jangan diam-diam (A3) |
| Kelelahan approval | Approve tanpa membaca | Batch item sejenis, ringkasan diff dan dampak, eskalasi otomatis untuk aksi tak terpulihkan, "izinkan pola" dari UI |
| Supervisor PTY (F1-g) menambah proses | Kompleksitas lifecycle | Tiru pola tmux socket nodeterm yang terbukti. Uji kill/restart HTTP |
| Big-bang refactor F1 | Lama tanpa fitur | Setiap WP F1 mengirim hal yang terlihat (timeline, catatan instan, sakelar live) + track I1 paralel |
| Test drift terlalu ketat | Menghambat | Drift hanya untuk proyeksi yang sudah ada di fase itu |
| Handoff/summarizer mengarang "selesai" | Laporan fiktif | Evidence hanya dari sistem, verifier menulis `done` |

## 4. Kendali biaya

| Sumber biaya | Kendali | Ukuran |
|---|---|---|
| Multi-agent (≈15× token menurut Anthropic) | Estimasi biaya di plan sebelum approve, budget harian yang sudah ada (keputusan P11), cap 3/5 worker, aturan skala usaha di planner | ledger `usage` per DAG |
| Routine | Precheck shell sebelum LLM (nol token bila tidak ada kerjaan), budget per routine, oracle ROI + auto-pause dengan notify | `routine_run` + usage |
| Consolidator / summarizer | Model kecil, hanya saat idle, cap harian | usage per job |
| Prompt cache | Prefix stabil, metrik hit-rate, TTL 1 jam hanya bila terbukti | `cache_read/write` |
| Classifier | Hanya di `act_gated`, input ringkas | usage per keputusan |
| CPU idle | Poll 1 dtk dihapus (F1) | profil CPU idle sebelum/sesudah |
| Embedding | Hanya teks memori, `embed_cache` per hash + model | jumlah panggilan embed |

## 5. Pertanyaan terbuka untuk kamu

Sesuai memory `feedback-ambang-keputusan`, hal teknis sudah diputuskan di dokumen ini. Yang tersisa hanya hal yang menyentuh mesin di luar project, data, atau preferensi produk:

| # | Pertanyaan | Default bila tidak dijawab |
|---|---|---|
| Q1 | F0-a menyimpan secret server di **Keychain macOS**. Itu menyentuh layanan di luar project. Boleh? | Kalau tidak boleh, secret hanya di memori proses dan dibangkitkan ulang tiap boot (token node lama menjadi tidak berlaku setelah restart, tapi grant tetap ada) |
| Q2 | ~~`cookies.txt` di root checkout utama~~ **Selesai:** sudah masuk `.gitignore` di `main` (commit `c1a970a`). Isinya tidak dibuka dan file tidak dihapus. F0-d tetap membangun guard otomatis untuk file sensitif lain | — |
| Q3 | Pola branch: satu branch integrasi `feature/cp` dari `main` (seperti `feature/ca2`), branch per WP `feature/cp-<wp>`, dan merge ke `main` hanya atas perintahmu. Setuju? | Ya, pola ini dipakai |
| Q4 | Default level otonomi tetap `propose` (K8). Mau `act_gated` untuk workspace tertentu setelah F3? | `propose` |
| Q5 | Bahasa catatan `[webterm]` dan Telegram: Indonesia penuh? | Indonesia |
| Q6 | Untuk Codex/Gemini tanpa sandbox: cukup label "mitigasi", atau kamu mau grant mereka dibatasi ke R0/R1 sampai ada sandbox? | Label + R0/R1 untuk mutasi di luar cwd |
