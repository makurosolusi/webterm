# 12 — Posisi USER-FLOW ADVOCATE (wkr-debate-userflow-48)

Sumber: laporan 01–05, memory `feedback-*` (zero-config, perkaya-fitur, tiru-referensi, ambang-keputusan, worker-lifecycle), spot-check repo `main@6cf021b`. Ukuran yang saya pakai cuma satu: **berapa banyak friksi harian yang hilang bagi satu developer yang memakai webterm seharian sebagai pengganti Orca/VS Code/Cursor.** Kode lama yang harus dirombak tidak saya hitung sebagai biaya (memory `feedback-perkaya-fitur`).

## 0. Tujuh tuntutan (jadi kriteria terima tiap fitur)

1. **Nol restart.** Ubah setting, pasang kabel, tambah skill/MCP, atau update server tanpa menutup sesi agent. Kalau sesi harus dimulai ulang, sistem yang melakukannya (`--resume` transparan) dan memberi tahu.
2. **Tidak ada yang env-only.** Setiap `WEBTERM_*` yang mengubah perilaku punya sakelar UI yang berlaku seketika. Env hanya untuk bootstrap (port, data dir).
3. **State jujur dan terlihat.** UI tidak boleh menampilkan "aktif" kalau yang jalan mock, kalau induknya mati, atau kalau binary tidak ada. Tiap sakelar menampilkan *status efektif + alasannya*.
4. **Satu tempat untuk melihat "apa yang sedang terjadi".** Timeline dan Inbox yang sama di canvas, tab browser, dan Telegram.
5. **Proaktif.** Sistem menyapa lebih dulu (agent selesai, test merah, gate menunggu, ringkasan pagi), tidak menunggu ditanya.
6. **Pemaaf.** Undo/rewind untuk kode, layout, node yang tertutup, dan setting.
7. **Ingat preferensi.** Feedback user ("pakai bahasa Indonesia", "jangan suruh set env", "nama worker uniq") menjadi aturan prosedural yang dimuat ke **semua** agent, bukan hanya Central.

## 1. Day-in-the-life: flow → friksi hari ini → fitur yang dibutuhkan

### F1. Pagi: buka laptop
- **Friksi:** tidak ada ringkasan semalam. User harus klik node satu per satu. Sesi yang mati karena server restart harus dibuka ulang. Telegram dan canvas tidak berbagi cerita yang sama.
- **Butuh:**
  - **Brief pagi** dari *handoff card* (03 §4.1) dan ledger event: berisi yang selesai, yang macet, gate yang menunggu, test merah, dan biaya kemarin. Muncul di canvas dan Telegram.
  - **Auto-resume semua agent node** setelah boot (sudah ada `--session-id` dan `--resume`), dengan status "dipulihkan" yang terlihat.
  - Persist `closedHistory` ke SQLite (05 G7).
- **Selesai bila:** buka tab, dalam 5 detik tahu keadaan semua workspace tanpa klik.

### F2. Memulai tugas
- **Friksi:** buat workspace, ketik cwd, spawn agent, lalu jelaskan konteks berulang-ulang. Worktree hanya ada di jalur orkestrator.
- **Butuh:**
  - **⌘K sebagai pintu intent** (04 §4.1, 05 G8). Ketik teks bebas, lalu sistem membuat workspace/worktree, men-spawn agent, dan melampirkan konteks node terpilih.
  - **Worktree per tugas sebagai warga kelas satu** (05 G3, memakai ulang `orchestrator/worktree.ts` dan `orca.yaml`).
  - **Judul node otomatis dari tugas** (tiru Orca `first-work-branch-rename.ts`), supaya tidak ada sepuluh node bernama "claude".
- **Selesai bila:** satu kalimat sampai agent mulai bekerja, nol form.

### F3. Mendelegasikan ke beberapa agent
- **Friksi:** agent tidak tahu browser sudah dikabel sampai sesi dibuka ulang. Codex/Gemini/OpenCode buta sama sekali (01 D7). Agent menolak tugas karena aturan global ("tunggu konfirmasi", "jangan push") walaupun user sudah setuju lewat UI. Banyak worker berwujud identik, dan zombie tidak bisa dimatikan.
- **Butuh:**
  - **MCP server webterm yang di-auto-configure ke setiap agent yang di-spawn**, plus Claude channel untuk push event (02 #3–4, 01 gap 1). Kabel dipasang langsung menjadi kemampuan baru tanpa restart. Jalur ketik `[webterm]` tetap sebagai fallback.
  - **Jembatan izin (consent bridge):** klik user di UI ("izinkan push branch ini", "approve plan") dicatat di ledger dan disuntikkan sebagai fakta terverifikasi ke agent. Agent tidak perlu menolak, dan izinnya tetap datang dari manusia (approvalAuth same-origin), bukan klaim agent.
  - **Identitas worker:** nama uniq dan warna per node, bisa dimatikan per nama, dan reaper otomatis untuk worker `completed` (memory `worker-lifecycle`).
  - **Lease file + gelombang berurutan** (04 §2.2) supaya worker tidak saling menimpa.
- **Selesai bila:** memasang kabel langsung terlihat di layar dan dipakai agent pada giliran berikutnya, untuk semua jenis agent.

### F4. Mereview perubahan agent
- **Friksi:** tidak ada diff (05 G1 = nol `DiffEditor`). User tetap membuka VS Code. Laporan worker bisa fiktif.
- **Butuh:**
  - **Diff node + anotasi per baris → kirim batch ke agent** (05 G1, tiru Orca Annotate AI Diff).
  - **Keep/Undo per hunk.**
  - **Checkpoint workspace sebelum setiap aksi agent dan tombol Rewind di timeline** (04 §3.1). Ini lebih kuat dari Claude/Cursor karena perubahan lewat Bash juga ikut tertangkap.
  - **Bukti diisi sistem:** `git diff --stat` dan exit code test ditempel ke kartu "selesai" (03 §4 pitfall).
- **Selesai bila:** review dan revisi berjalan tanpa keluar dari webterm, dan setiap klaim "selesai" punya bukti.

### F5. Ship
- **Friksi:** commit/push lewat terminal. Rule 6/18 harus diketik ulang oleh agent setiap kali.
- **Butuh:**
  - **Panel SCM** (05 G2): stage, commit dengan pesan AI berformat Rule 9, push human-only, dan `gh pr create`.
  - **Laporan Rule 18 dibangkitkan otomatis** dari hasil test/typecheck/lint yang benar-benar dijalankan, ditampilkan sebelum tombol Push bisa ditekan.
  - **Tombol "Fix with agent"** saat hook gagal.
- **Selesai bila:** dari diff ke PR dalam tiga klik, dengan gerbang yang ditegakkan sistem dan tidak mengandalkan ingatan agent (memory `aturan-sudah-ada`).

### F6. Mengecek dari HP lewat Telegram
- **Friksi:** pairing ribet, markdown rusak, jumlah project di Telegram berbeda dari canvas, dan approve izin tool agent terminal tidak bisa (01 D3: `PermissionRequest` cuma jadi badge).
- **Butuh:**
  - **Pairing satu ketuk** lewat deep link `t.me/<bot>?start=<kode>` atau QR di Settings.
  - **Satu renderer pesan** (HTML Telegram sudah ada di `telegramSend.ts`, tapi `channelAdapter.ts` mengirim tanpa `parse_mode`). Satukan dan tambahkan split otomatis untuk pesan panjang dan blok kode.
  - **Satu sumber hitungan:** project count harus berasal dari satu world model. Tiga DB tanpa JOIN (01 gap 10) adalah akar mismatch ini.
  - **Relay `PermissionRequest` → tombol Telegram/Inbox** dengan opsi "izinkan pola ini selamanya" (02 #6).
  - **Aturan perhatian ala Orca:** jangan kirim push kalau user sedang menatap node itu, plus digest.
  - Opsional: **PWA `/m`** (05 G12).
- **Selesai bila:** semua yang bisa dilakukan di Inbox desktop bisa dilakukan dari HP, dan angkanya sama.

### F7. Melanjutkan besok
- **Friksi:** konteks hilang, ringkasan checkpoint deterministik nyaris tidak merangkum (03 §0).
- **Butuh:**
  - **Summarizer LLM + handoff card** (03 #1).
  - **"Lanjutkan dari kemarin"** sebagai satu tombol per workspace.
  - **Memori prosedural preferensi user dimuat ke semua agent node** (03 #6 diperluas dari Central ke node).
  - **Sleep-time consolidator** (03 #2), dengan hasil yang terlihat dan bisa dikoreksi di panel "yang kuingat" (03 #9).

## 2. Prioritas berdasarkan friksi yang hilang

| # | Fitur | Flow | Sumber | Alasan peringkat |
|---|---|---|---|---|
| P0-1 | **Panel Control "status efektif"**: semua flag rilis dan knob (01 §5: ~8 flag CA2 dan 15+ knob env-only) dipindah ke UI dan berlaku live. Tiap baris menampilkan *efektif / alasan / sumber*. Badge **MOCK** merah di mana pun mesin simulasi aktif. | semua | 01 gap 11, memory zero-config | Akar tiga keluhan minggu ini: env tersembunyi, setting menyesatkan, dan fitur yang tampak menyala padahal mock. Fondasinya sudah ada (`featureCapabilities.*`, `envSettings.api`). |
| P0-2 | **Event bus + Activity timeline + Inbox seragam + notifikasi OS/title/Telegram** | F1, F3, F6 | 04 #1, #3, #8; 05 G4 | Menjawab "satu tempat melihat apa yang terjadi" dan sisi proaktif. Waker dan Inbox sudah ada, tinggal produsen dan tampilan. |
| P0-3 | **Nol restart:** awareness untuk semua agent lewat MCP/channel yang auto-configured, live reconfig, auto-resume setelah boot, dan hot-swap server tanpa membunuh PTY | F1, F3 | 02 #3–4, 01 D7 | Keluhan "agent tidak sadar browser" dan "harus restart" hilang sekaligus. |
| P0-4 | **Diff + anotasi + Keep/Undo + checkpoint/Rewind** | F4 | 05 G1, 04 #4 | Alasan utama user masih membuka IDE lain. Sekaligus jaring pengaman untuk otonomi tinggi. |
| P1-1 | **Consent bridge dan relay `PermissionRequest`** (UI/Telegram → agent) | F3, F6 | 02 #6, 01 D3 | Menghapus penolakan agent karena aturan global tanpa melemahkan aturannya. |
| P1-2 | **Identitas worker + reaper + judul otomatis** | F2, F3 | Orca rename, memory lifecycle | Murah, dan keluhannya nyata minggu ini. |
| P1-3 | **SCM + laporan Rule 18 otomatis** | F5 | 05 G2 | Menutup loop kerja harian. |
| P1-4 | **Telegram parity:** deep-link pairing, satu renderer, satu sumber hitungan, digest | F6 | 01 gap 10 | Keluhan langsung minggu ini. |
| P1-5 | **Handoff card + brief pagi + memori preferensi untuk semua agent** | F1, F7 | 03 #1, #6 | Kontinuitas, dan "ingat preferensi saya". |
| P2 | Worktree per tugas, ⌘K intent dan registry perintah, global search, port detect, riwayat sesi, rutinitas terjadwal, sleep-time consolidator, DAG + gate | F2, F7 | 04/05 | Tetap masuk roadmap, tidak ada yang dibuang. Urutannya mengikuti P0/P1 karena bergantung pada bus dan registry. |

Catatan untuk debat arsitektur: **registry kemampuan tunggal** (01 §6, 02 #1) adalah *enabler* P0-1, P0-3, dan P1-1, bukan tujuan akhirnya. Saya mendukungnya dengan satu syarat: setiap gelombang harus mengirim sesuatu yang **terlihat oleh user**. Jangan ada fase "refactor dulu tiga minggu baru ada fitur".

## 3. Friksi yang TIDAK dibahas laporan 01–05

1. **Setting yang berbohong.** Laporan 01 mencatat flag sprawl tapi tidak menuntut *status efektif + alasan*. Contohnya mock runtime: `runtimeDetect.ts` memang tidak pernah otomatis jatuh ke mock, tapi kalau dipilih eksplisit lewat env, UI harus berteriak.
2. **Restart server untuk edit server** (`CLAUDE.md`: "edit server perlu restart"). Kalau user sendiri yang membangun webterm sambil memakainya, setiap restart memutus semua sesi. Dibutuhkan supervisor yang mempertahankan PTY (pola tmux socket `-L node-terminal` di nodeterm) sementara proses HTTP di-reload.
3. **Agent menolak karena aturan global.** Tidak ada laporan yang menyentuh benturan antara aturan `~/.claude/CLAUDE.md` dan perintah user lewat UI. Solusinya consent bridge (P1-1), bukan melonggarkan aturan.
4. **Worker identik dan zombie.** Tidak dibahas. Panel agent webterm harus menampilkan nama, tugas, umur, dan tombol kill.
5. **Latensi browser node.** Tidak ada laporan yang mengukurnya. Tuntutannya: anggaran latensi (input→frame) ditampilkan di chip node, dan pendekatan screencast/input ditiru dari Orca atau nodeterm yang terbukti, bukan ditambal (memory `tiru-referensi`).
6. **Mismatch angka lintas permukaan** (project count Telegram vs canvas). Akarnya tiga DB tanpa JOIN. Laporan 01 menyebut gap ini secara teknis tapi tidak sebagai keluhan user.
7. **Health check yang memperbaiki sendiri ("Doctor")**: skill terpasang, hook terpasang, `claude auth`, socket, bot Telegram hidup. Sistem mendeteksi lalu memperbaiki dengan satu klik, bukan menyuruh user mengecek.
8. **Undo setting dan undo tutup node lintas reload.** `layoutHistory` sudah ada, tapi setting dan node yang ditutup tidak bisa dikembalikan.
9. **Bahasa.** UI campur Indonesia/Inggris, dan catatan `[webterm]` berbahasa Inggris. Preferensi bahasa harus jadi memori yang diterapkan ke UI, Telegram, dan agent.
10. **Keamanan kebersihan repo.** `git status` menunjukkan `cookies.txt` tak terlacak di root repo. Risikonya ter-`git add .` oleh agent. Perlu guard sistem: daftar file sensitif otomatis ditambahkan ke `.gitignore`, dan SCM panel menolak men-stage file tersebut (Rule 7). Isi file tidak saya buka.

## 4. Posisi tegas untuk debat

- **Tolak** setiap usulan yang menyelesaikan masalah dengan "set env X lalu restart", dengan "user cukup cek Y", atau dengan "fitur ditunda karena kode lama".
- **Tolak** urutan yang menaruh P0-4 (diff/rewind) setelah otonomi tingkat tinggi. Otonomi tanpa rewind hanya memindahkan risiko ke user.
- **Dukung** registry tunggal dan event bus sebagai fondasi, dengan syarat setiap gelombang mengirim perubahan yang terlihat di UI.
- **Kriteria terima universal** untuk setiap fitur: (a) bisa dipakai tanpa membaca docs, (b) tidak butuh restart, (c) perubahan state tampil di timeline, (d) bisa di-undo atau dijelaskan kenapa tidak bisa, (e) angkanya sama di canvas dan Telegram.
