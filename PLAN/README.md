# Rencana control plane webterm

Hasil sintesis R&D (`01`–`05`) dan debat tiga posisi (visioner, systems engineer, user-flow; `10`–`12`). Semua dokumen sumber disimpan di [`PLAN/rnd/`](rnd/). Tanggal 2026-11-04, basis `main@6cf021b`. Ditulis untuk satu pengguna: kamu, yang memakai webterm seharian sebagai pengganti Orca, VS Code, dan Cursor.

## Ringkasan

webterm sudah punya mesin yang kuat: PTY nyata, Central dengan guard dan level, ledger memori dengan FTS + RRF, browser node, dan Telegram. Masalahnya, kemampuan-kemampuan itu tidak saling terhubung. Ada tujuh daftar kemampuan, lima adapter approval, delapan sumber event tanpa bus, dan tiga DB yang tidak bisa di-JOIN. Hanya Claude yang sadar akan lingkungannya, dan agent ber-uid sama bisa membaca token root. Rencana ini menyatukan semuanya menjadi satu sistem saraf:

- **Capability Registry** yang diproyeksikan ke MCP, CLI, HTTP, Central, dan ⌘K.
- **Policy** dengan principal dan grant. Kabel di canvas berfungsi sebagai grant.
- **Event log** berantai-hash dengan taint.
- **Inbox** yang benar-benar menjawab `PermissionRequest`.
- **Memory** dan **Context engine** yang dipakai semua agent.
- **Agency**: routine, DAG, worktree, checkpoint/rewind, dan verifier berbasis bukti sistem.
- **Awareness** untuk semua CLI.

Urutannya F0 (hardening same-uid + quick win terlihat) → F1 spine (∥ diff/search/riwayat) → F2 proyeksi ke agent → F3 HITL + rewind (∥ SCM/worktree) → F4 otonomi → F5 kecerdasan memori → F6 ekstensi. Setiap fase wajib lulus tujuh aturan terima: nol restart, tidak ada yang env-only, status jujur, satu timeline, proaktif, undo, dan preferensi diingat. Tidak ada ide yang dibuang demi kode lama. Ide yang ditunda atau ditolak tercatat beralasan di buku ide.

## Indeks

| File | Isi |
|---|---|
| [00-visi.md](00-visi.md) | Visi, 7 aturan terima, arti "god mode", glosarium |
| [01-arsitektur.md](01-arsitektur.md) | Keputusan debat K1–K10, subsistem S1–S8, antarmuka, data store, kode yang diganti, referensi |
| [02-fase.md](02-fase.md) | F0–F6 dan track IDE I1/I2: tujuan, paket kerja + kepemilikan file, kriteria keluar, test, dependensi, ukuran |
| [03-alur-harian.md](03-alur-harian.md) | Satu hari kerja dipetakan ke fitur dan fase, plus uji terima end-to-end |
| [04-buku-ide.md](04-buku-ide.md) | 170 ide: status (Fx / Tunda / Tolak), alasan, syarat tinjau ulang |
| [rnd/](rnd/) | 8 dokumen sumber: R&D `01`–`05` dan posisi debat `10`–`12` |
| [05-risiko-dan-verifikasi.md](05-risiko-dan-verifikasi.md) | Model keamanan same-uid, prompt injection, secret broker, 14 item verifikasi, biaya, pertanyaan untukmu |

## Keputusan utama atas perselisihan

Detailnya ada di `01-arsitektur.md` §0.

- **K1:** F0 hardening datang lebih dulu, tetapi tetap mengirim quick win yang terlihat.
- **K2:** Channel Claude hanya menjadi adapter di belakang outbox. Ketik ke PTY tetap transport kelas satu.
- **K3:** Grant node bekerja lewat atenuasi. Agent tidak bisa menerbitkan grant.
- **K4:** "Izinkan selamanya" hanya dari UI. Telegram hanya untuk approve sekali.
- **K5:** `ATTACH` world view dipakai, tanpa menggabung file DB.
- **K6:** Diff mulai di F1, rewind sebelum otonomi.
- **K7:** Parser proposal teks dihapus setelah MCP lulus.
- **K8:** Mutasi default `propose`.
- **K9:** Hash chain diberi anchor eksternal.
- **K10:** ACP di F6.

## Tiga aksi berikutnya

1. **Jawab Q1** (`05` §5): apakah secret boleh disimpan di Keychain macOS. Ini menyentuh hal di luar keputusan teknis. Q2 sudah selesai. Lalu buat branch integrasi `feature/cp` dari `main`.
2. **Dispatch gelombang studi F0 + verifikasi V3, V5, V6, V8** (read-only, paralel). Hasilnya: bukti apakah deny `Read`/sandbox Claude menahan `cat auth.json`, apakah env proses bocor ke sibling, dan format balasan `PermissionRequest`. Spec implementasi F0-a ditulis dari hasil itu.
3. **Dispatch implementasi F0-b, F0-c, F0-d, F0-e paralel** (notifikasi OS, panel status efektif, guard file sensitif, identitas worker). Semuanya tidak bergantung pada hasil studi keamanan, langsung terasa di harimu, dan memenuhi syarat "setiap gelombang terlihat".
