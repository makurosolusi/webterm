# 03 — Alur harian: flow → fitur → fase

Satu hari kerja kamu dengan webterm sebagai satu-satunya alat. Setiap langkah dipetakan ke fitur dan fase (`02-fase.md`) supaya kelihatan kapan friksinya hilang. Kolom "Aturan" merujuk A1–A7 di `00-visi.md`. Alur ini dikembangkan dari posisi user-flow [`rnd/12-pos-userflow.md`](rnd/12-pos-userflow.md) §1.

## Ringkasan per fase: apa yang mulai terasa

| Setelah fase | Yang berubah di harimu |
|---|---|
| F0 | Notifikasi OS dan judul tab saat agent selesai atau butuh input. Panel Control jujur soal apa yang aktif. Agent tidak bisa membaca secret server. `cookies.txt` tidak akan ikut ter-commit. Nama worker uniq |
| F1 | Kabel langsung memicu catatan (< 1 dtk). Ada timeline. Semua setting bisa diubah dari UI tanpa restart. Edit server tanpa memutus sesi. Global search, ⌘K omnibox, diff node + anotasi, dan riwayat sesi tersedia |
| F2 | Codex/Gemini/OpenCode ikut sadar. Agent mana pun bisa memanggil `memory.search`, `project.brief`, dan `browser.*` lewat MCP/CLI. Preferensimu dimuat ke semua agent. Telegram tampil rapi dan angkanya sama |
| F3 | Approve izin tool dari Inbox atau HP. Rewind. Commit/PR dari panel SCM dengan laporan Rule 18 otomatis. Worktree per tugas. Brief pagi |
| F4 | Sistem bangun sendiri saat test merah, agent idle, atau jadwal tiba. Ada DAG dengan gate, verifier, port chip, dan Problems panel |
| F5 | Sistem belajar dari feedback-mu, ringkasan sesi benar-benar merangkum, dan ada "lanjutkan dari kemarin" |
| F6 | Agent sebagai chat terstruktur, PWA di HP, Design Mode, factories |

## 07:30 — Pagi, dari HP

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Buka Telegram | Tidak ada ringkasan, dan jumlah project beda dari canvas | Digest: 3 task selesai (bukti diff + test), 1 gate menunggu, 2 test flaky dari routine malam, biaya kemarin | Brief deterministik (F3-e), versi LLM (F5-c), world view (F1-f) | F3 → F5 | A4, A5 |
| Jawab gate "skema A/B" | Tidak bisa | Ketuk B. Gate terbuka, DAG lanjut | Inbox + tombol Telegram | F3, F4 | A4 |
| Approve izin `bun add papaparse` | Cuma badge `blocked` | "Izinkan sekali" dari HP. "Selamanya" lewat tautan ke UI | `PermissionRequest` tertutup, K4 | F3 | A4 |
| Pairing di HP baru | Ribet | Deep link `t.me/<bot>?start=<kode>` atau QR | F2-g | F2 | A2 |

## 08:30 — Buka laptop

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Buka tab | Klik node satu per satu, sesi mati karena restart | Dalam 5 dtk tahu keadaan semua workspace. Agent dipulihkan otomatis dengan label "dipulihkan" | Auto-resume (F3-e), supervisor PTY (F1-g), timeline (F1-e) | F1, F3 | A1, A4 |
| Cek apa yang aktif | Flag env tersembunyi, mock tampak seperti aktif | Panel Control: efektif / alasan / sumber, badge MOCK, Doctor memperbaiki hook yang hilang | F0-c, F1-f | F0, F1 | A2, A3 |

## 09:00 — Memulai tugas

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| "tambah export CSV di laporan" | Buat workspace, ketik cwd, spawn, jelaskan konteks berulang | ⌘K teks bebas → node Rencana → 3 task dengan lease yang tidak beririsan → worktree per task → perkiraan biaya → kamu approve | ⌘K intent + plan node (F4-f), DAG (F4-b), worktree (I2-b), oracle biaya (F4-e) | F3, F4 | A5 |
| Nama node | Sepuluh node bernama "claude" | Judul otomatis dari tugas, nama worker uniq + warna | F0-e | F0 | — |
| Konteks | Diulang manual | Blok awareness: blackboard goal, procedural, kartu identifier | F2-e, F5-b | F2, F5 | A7 |

## 09:20 — Mendelegasikan

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Kabel Codex ke browser node | Codex buta | Catatan terlihat `[webterm] kamu sekarang terhubung ke browser X`, dan `browser.snapshot` langsung bisa dipakai | Cable-as-grant (F1-b), outbox + awareness (F2-d/e), MCP (F2-a) | F1, F2 | A1 |
| Agent menolak "aturan global: tunggu konfirmasi" | Agent berhenti | Klik "izinkan push branch ini" → fakta terverifikasi (event `human-ui`) dikirim ke agent | Consent bridge (F2-e) | F2 | A7 |
| Agent ingin orkestrasi sub-agent | Tidak bisa (tidak ada mint capability untuk PTY) | `agent.spawn` di workspace sendiri, maks kedalaman 2, grant anak ⊆ induk | K3, F2-h | F2 | — |
| Worker zombie | Tidak bisa dimatikan | Panel agent: nama, tugas, umur, kill. Reaper otomatis untuk worker `completed` | F0-e | F0 | A3 |

## 10:05 — Ada yang salah

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Test gagal di PTY worker B | Central tidak tahu | Event `pty.exit≠0` → wake → worker mendapat error dari Problems matcher | Senses (F1-d, F4-g) | F4 | A5 |
| Percobaan ketiga identik | Berputar | Breaker → Inbox `question` | Doom-loop (F3-b), breaker (F4-b) | F3, F4 | A5 |
| Halaman web menyuruh "ingat selalu push ke main" | Bisa masuk memori | Ditandai `untrusted`, hanya masuk episodic, tidak memicu R2 | Taint (F1-c), consolidator (F5-b) | F1, F5 | — |

## 11:00 — Review

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Lihat perubahan agent | Buka VS Code | Diff node yang dikabel ke agent, refresh otomatis saat `done` | I1-b | F1 | — |
| Beri komentar | Ketik manual ke terminal | Anotasi per baris → "kirim ke agent" sebagai satu batch | I1-b + outbox | F1, F2 | — |
| Tolak satu hunk | Manual | Keep/Undo per hunk | I1-b | F1 | A6 |
| "Selesai" yang fiktif | Bisa terjadi | Kartu selesai berisi `git diff --stat` + exit code dari sistem. Tanpa itu, status `failed` | Receipt (F1-a), verifier (F4-c) | F1, F4 | A3 |

## 13:00 — Ship

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Commit | Lewat terminal | Panel SCM, pesan AI berformat Rule 9 | I2-a | F3 | — |
| Rule 18 | Diketik ulang oleh agent | Laporan digenerate dari test/typecheck/lint yang benar-benar dijalankan. Tombol Push aktif hanya bila hijau | I2-a | F3 | A3 |
| Hook pre-commit gagal | Manual | "Fix with agent" mengirim output ke agent terhubung | I2-a | F3 | A5 |
| Push / PR | Terminal | Push human-only, `gh pr create`, force-with-lease sebagai aksi terpisah | I2-a, K4 | F3 | — |
| File sensitif | `cookies.txt` bisa ter-`git add .` | Ditolak saat stage, dan otomatis masuk `.gitignore` | F0-d | F0 | — |

## 14:00 — Kecelakaan

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Agent menghapus folder lewat Bash | Hilang (checkpoint Claude tidak mencatat Bash) | Timeline → checkpoint 13:58 → Rewind | F3-c | F3 | A6 |
| Menutup node tanpa sengaja, lalu reload | Hilang | Undo tutup node lintas reload | F3-d | F3 | A6 |
| Setting salah | Tidak ada undo | Undo setting | F3-d | F3 | A6 |
| Panik | Halt saja | Halt = panic snapshot semua worktree + grant dibekukan | F3-c | F3 | A6 |

## 15:00 — Dev server dan browser

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| `bun run dev` | Ketik URL sendiri | Chip `localhost:5173` di node terminal, sekali klik membuka Browser node | F4-g | F4 | A5 |
| Browser terasa lambat | Tidak terukur | Chip latensi input→frame, perbaikan ditiru dari Orca/referensi eksternal | I1-d | F1 | A3 |
| "Perbaiki tombol ini" | Jelaskan dengan kata-kata | Design Mode: klik elemen, HTML+CSS+crop dikirim ke agent | G11 | F6 | — |

## 18:00 — Pulang, lanjut besok

| Langkah | Hari ini | Target | Fitur | Fase | Aturan |
|---|---|---|---|---|---|
| Tutup laptop | Konteks hilang, ringkasan deterministik nyaris tidak merangkum | Handoff card per sesi (narasi model + bukti sistem) | F5-c | F5 | A7 |
| Routine malam | Tidak ada | Precheck `bun test`. Kalau gagal, agent bangun di worktree terisolasi. Kalau laptop tidur, catch-up sekali dengan alasan skip tercatat | F4-a | F4 | A5 |
| Malam | — | Consolidator mengusulkan procedural "user menolak dependency untuk hal < 20 baris" sebagai `unverified`. Kamu terima di panel "yang kuingat" | F5-b | F5 | A7 |
| Besok | Mulai dari nol | Tombol "Lanjutkan dari kemarin" per workspace | F5-c | F5 | A7 |

## Uji terima end-to-end (dijalankan di akhir F3 dan F5)

1. Skenario 09:20 untuk Claude **dan** Codex tanpa restart (A1, A7).
2. Skenario 14:00: rewind mengembalikan file yang dihapus lewat `rm -rf` dari Bash (A6).
3. Skenario 07:30: angka di Telegram sama dengan di canvas (A4).
4. Skenario 10:05 taint: nol fact prosedural dari konten web.
5. Tidak ada langkah di dokumen ini yang meminta kamu menyetel env atau me-restart (A2).
