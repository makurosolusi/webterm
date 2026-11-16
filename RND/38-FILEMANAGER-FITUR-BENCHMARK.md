# 38 — File manager: benchmark fitur & prioritas (MoSCoW) + peta workstream

Topik 4 R&D file manager (2026-11-03). Bukti kode = `file:baris` di worktree `rnd-files`. `[BT]` = belum terverifikasi dari sumber primer di sesi ini; `[opini]` = penilaian penulis. UX detail → dok 35; viewer → 36; mutasi/sinkronisasi → 37 (dok ini hanya merujuk).

## 1. Titik awal: apa yang ADA di node files sekarang

| Area | Kondisi | Bukti |
|---|---|---|
| Surface server | Hanya 6 verb: `list`, `read`, `read-binary`, `exists` (GET) + `write`, `mkdir` (POST). TIDAK ada rename/delete/move/copy/stat/search/watch/upload/download | `fsApi.ts:57-97` |
| Bentuk UI | Satu level (list), bukan tree; masuk folder = ganti `dirPath` node | `FilesNode.tsx:332`, `:120` |
| Seleksi | Satu indeks (`sel: number`), tanpa multi-select | `FilesNode.tsx:68` |
| Pencarian | Filter substring nama, hanya direktori aktif, toggle lewat tombol search header | `fileBrowse.ts:165`, `FilesNode.tsx:299` |
| Sort / hidden | Sort tetap (folder dulu, `localeCompare`); semua dotfile tampil, hanya `.git` disembunyikan; tanpa toggle | `fsOps.ts:133-137` |
| `.gitignore` | Entry ignored di-dim (bukan disembunyikan); via `git check-ignore`, dilewati bila >2000 entry | `fsOps.ts:88-117`, `FilesNode.tsx:337` |
| Git | `/api/git/info` hanya per-repo (branch/dirty/ahead/behind). Tidak ada status PER FILE; tidak ditemukan konsumen di `src/client` (grep) | `shared/gitInfo.ts:30-45`, `gitInfo.ts:171` |
| Context menu | Open, Open in Integrated Terminal, New File, New Folder, Copy Path (absolut) | `FilesNode.tsx:254-281` |
| Keyboard | Panah/Home/End, Enter, Backspace/Alt+↑ naik, type-ahead. Tanpa F2/Delete/Ctrl+C/V/Ctrl+P | `filesKeys.ts:68-93` |
| Buka file | Node `editor` baru di samping + kabel penanda; dedupe per `filePath`; ekstensi OS-only (zip, db, bin…) ditolak dengan notice | `FilesNode.tsx:135-152`, `fileOpen.ts:38`, `fileBrowse.ts:177-219` |
| Terminal | "Open in Integrated Terminal" membuat node terminal baru ber-`cwd`; TIDAK bisa kirim path ke terminal yang sudah ada | `FilesNode.tsx:266-269` |
| Drag & drop | Tidak ada (grep `onDrop`/`dataTransfer`/`dragstart` di `src/client` nihil) | — |
| Favorit/recent/pin | Tidak ada; hanya `dirPath`, `title`, `color`, `collapsed`, `comments` di data node | `FilesNode.tsx:47-49` |
| Multi-root | Praktis sudah ada: tiap node files = satu root; `onAddFiles` memakai `ws.cwd` | `App.tsx:233` |
| Batas ukuran | Teks 10 MB, biner 24 MB (di atasnya sentinel too-large) | `shared/fsLimits.ts:12-13` |
| Quick Open | Sengaja TIDAK diport dari referensi eksternal | `fsOps.ts:5-6` |

Ketersediaan di mesin dev: `rg`, `git`, `zip`, `unzip`, `tar` ada; Bun 1.4.2 punya `Bun.Glob` dan `Bun.Archive` (diuji `bun -e`). Di mesin produksi pengguna `rg` belum tentu ada `[BT]` → wajib fallback.

## 2. Referensi pembanding (hanya yang relevan untuk keputusan)

| Referensi | Status/lisensi (verifikasi) | Pelajaran bagi webterm |
|---|---|---|
| referensi eksternal `listQuickOpenFiles` + `quickOpenSearch` | Repo referensi proyek (BUSL-1.1) | `rg` → `git ls-files` → walk ber-cap 50.000 (`referensi-eksternal/src/core/fs-ops.ts:209-229`, `src/shared/quick-open-filter.ts` cap & blocklist); fuzzy murni 90 baris, limit 50 hasil (`src/renderer/lib/quickOpenSearch.ts`). Porting langsung, sesuai aturan "tiru referensi eksternal" |
| referensi eksternal `ExplorerPanel` | Idem | Ada reveal (expand ancestor + select + scroll, berkunci `nonce`), pin panel, download. Pola reveal bisa ditiru |
| VS Code Explorer | Docs: `codebasics` | Terverifikasi: Select for Compare / Compare with Selected, Find in Folder, badge jumlah file belum disimpan, `search.exclude`/`files.exclude`, ripgrep + .gitignore. Tidak diverifikasi (pengetahuan umum `[BT]`): Open Editors, Outline/Timeline, `explorer.sortOrder`/`excludeGitIgnore`/`compactFolders`/`confirmDelete`/`enableUndo`/`autoReveal`, F2/Delete/Ctrl+Z, drag upload |
| Cloud Commander | MIT, aktif (push terakhir 2026-10-25, API GitHub) | Dua panel + terminal + editor di web; pelajaran: pola dual-pane tidak perlu, canvas sudah memberi 2 node |
| Filebrowser | Apache-2.0, **diarsipkan 2026-09-01**, tanpa patch keamanan (README) | JANGAN jadi dasar/dependensi. Pelajaran negatif: command runner dan JWT tak-revokable adalah sumber CVE |
| Zed | Repo `NOASSERTION` (campuran lisensi `[BT]`) | Hanya inspirasi UX (project panel, file finder); jangan salin kode |
| Finder / Nautilus / JetBrains | Pengetahuan umum `[BT]` | Finder: Get Info, folder size, Quick Look (Space), tag. Nautilus: Properties (permission), Ctrl+L path bar. JetBrains: Scope view, Select Opened File, Compare, Local History |

## 3. Matriks fitur (✓ ada, ~ sebagian, ✗ tidak, ? `[BT]`)

| Fitur | VS Code | Finder | Nautilus | Zed | JetBrains | Web FM | webterm kini |
|---|---|---|---|---|---|---|---|
| Quick Open fuzzy nama | ✓ Ctrl+P | ~ Spotlight | ~ | ✓ | ✓ Shift×2 | ~ | ✗ |
| Cari isi (grep) | ✓ rg | ~ | ~ | ✓ | ✓ | ~ | ✗ |
| Filter nama in-place | ✓ (Ctrl+F di tree) | ✓ | ✓ type-ahead | ~ | ✓ speed search | ✓ | ~ substring, 1 dir |
| Sort/group opsi | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✗ |
| Hidden toggle | ~ (`files.exclude`) | ✓ ⌘⇧. | ✓ Ctrl+H | ✓ | ✓ | ✓ | ✗ (dotfile selalu tampil) |
| Aware `.gitignore` | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ~ dim saja |
| Dekorasi status git (M/U/A) | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| Rename F2 / Delete / Undo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Multi-select, copy/paste/move | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Copy path abs/relatif | ✓ keduanya | ~ abs | ~ | ✓ | ✓ | ~ | ~ abs saja |
| Reveal in tree | ✓ autoReveal | n/a | n/a | ✓ | ✓ | ✗ | ✗ |
| Compare/diff 2 file | ✓ | ✗ | ✗ | ~ | ✓ | ✗ | ✗ (Monaco punya diff editor, belum dipakai: grep nihil) |
| Open in terminal | ✓ | ✓ (Service) | ✓ | ✓ | ✓ | ✓ | ✓ (hanya node baru) |
| Kirim path ke terminal aktif / drag | ✓ drag ke terminal | ✓ drag ke Terminal | ✓ | ~ | ~ | ✗ | ✗ |
| Favorit/pinned/recent | ~ Open Editors | ✓ sidebar+Recents | ✓ Bookmarks/Recent | ~ | ✓ Recent Files | ~ | ✗ |
| Info/Properties/ukuran folder | ✗ | ✓ Get Info | ✓ | ✗ | ✗ | ~ | ✗ |
| Zip/unzip | ✗ (ekstensi) | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| Edit permission (chmod) | ✗ | ✓ | ✓ | ✗ | ✗ | ~ | ✗ |
| Upload/download via browser | ✓ drag masuk (web) | n/a | n/a | n/a | n/a | ✓ | ✗ |
| Multi-root | ✓ | n/a | n/a | ✓ | ✓ modul | ✗ | ✓ (multi-node) |

## 4. Analisis fitur per kandidat (nilai bagi pengguna webterm)

Profil pengguna: pengembang dengan banyak terminal/agent di satu canvas; file manager dipakai untuk (a) menunjuk path ke agent, (b) melihat apa yang diubah agent, (c) membuka/menyunting file kecil tanpa pindah alat.

| # | Kandidat | Nilai | Biaya | Catatan teknis |
|---|---|---|---|---|
| F1 | Quick Open fuzzy (nama, relatif ke root node) | Sangat tinggi: lompat ke file di repo besar tanpa menyusuri folder | M | Port `quickOpenSearch.ts` (murni) + endpoint `GET /api/fs/files?root=` (rg→`git ls-files`→`Bun.Glob`), cap 50.000, blocklist noise. Sumber hasil: dibuka sebagai editor via `planFileOpen` (`fileOpen.ts:38`) |
| F2 | Kirim path ke terminal/agent: aksi menu "Insert Path in Terminal…" + drag baris → node terminal | Sangat tinggi: sinergi inti webterm, nol pesaing web melakukannya | M | Tulis via WS `{t:'input', id, data}` (`protocol.ts:8`); WAJIB shell-quote path (spasi, `'`, `$`); jangan akhiri `\n` (jangan mengeksekusi). Pilih target: terminal/agent yang terhubung kabel atau yang di-hover saat drop. `dataTransfer` custom MIME `application/x-webterm-path` |
| F3 | Mutasi dasar: rename F2, delete (+konfirmasi), duplicate, move (drag antar folder), copy/paste | Tinggi: tanpa ini "file manager" hanya viewer | L | Semantik & keamanan di dok 37; di sini hanya sebagai dependensi F5/F7/F8 |
| F4 | Copy Relative Path, Copy Name, Reveal in Files (dari editor node) | Tinggi, murah: path relatif adalah yang ditempel ke prompt agent | S | `copy path` ada (`FilesNode.tsx:272`); relatif = potong prefix root node. Reveal: node editor → `updateNodeData(files, {dirPath})` + `pendingSel` (`FilesNode.tsx:57`) |
| F5 | Toggle hidden + opsi sort (nama/ukuran/mtime/tipe) + "hormati .gitignore" (sembunyikan vs dim) | Tinggi: `node_modules`/`.next` menenggelamkan listing | S–M | Sort/hidden butuh `size`/`mtime` di `DirEntry` (`fsOps.ts:59-64`) → ubah kontrak wire (additif). Simpan di data node |
| F6 | Dekorasi status git per file (M/U/A/D, warna + badge) + propagasi ke folder | Tinggi untuk alur agent: terlihat file yang baru diubah | M | Endpoint baru `git status --porcelain=v2 -z` per repo, di-cache per repo seperti `collectGitInfo` (`gitInfo.ts:171`); refresh manual `⟳` + saat sinyal watcher (dok 37) |
| F7 | Cari isi file (rg) dengan hasil klik-buka di baris | Sedang-tinggi | M–L | `rg --json`, batas hasil & timeout; `rg` tak ada → fallback `git grep` → nonaktif dengan pesan. UI hasil = mode kedua node, bukan panel baru |
| F8 | Multi-select (Shift/Ctrl-klik, Ctrl+A) + aksi massal | Sedang-tinggi | M | Ubah `sel:number` → set + anchor (`FilesNode.tsx:68`); `listKeyAction` (`filesKeys.ts:68`) perlu varian shift |
| F9 | Recent & Pinned folder (per workspace, di data node/DB) | Sedang | S–M | Recent = n folder terakhir per node; Pinned = daftar di data workspace (skema `workspace.ts:437` area) → perlu migrasi bila di DB (Rule 4) |
| F10 | Compare 2 file (Select for Compare) | Sedang | M | Monaco `createDiffEditor` sudah dalam paket `monaco-editor ^0.57.0` (`package.json:32`); node editor mode diff baru. Bergantung pada F8/F3 |
| F11 | Properties/Info (ukuran, mtime, mode, tipe, jumlah item) + ukuran folder | Sedang-rendah | S–M | Butuh verb `stat`; ukuran folder rekursif = `du`-like, WAJIB async + cap + dibatalkan; jangan hitung otomatis |
| F12 | Upload (drag dari OS) & Download file/folder | Sedang | M–L | Dok 37 (batas ukuran, traversal, streaming). Download folder = zip (F13). `Content-Disposition: attachment` |
| F13 | Zip/unzip | Rendah-sedang | M | Native dulu (Rule 10): `zip`/`unzip`/`tar` via `execFile` argv-array (bukan shell) atau `Bun.Archive` untuk tar; `fflate@0.8.3` (MIT, `[BT]` ukuran) hanya bila CLI tak bisa diandalkan. Zip-slip wajib dicek |
| F14 | Permission editor (chmod) | Rendah | S–M | Hanya di Properties, oktal + validasi; macOS/Linux saja |
| F15 | Dual-pane, grid/icon view, tag, Quick Look, share-link, user mgmt | Rendah/tidak relevan | — | Canvas sudah memberi dua node; sisanya di luar identitas webterm |

## 5. MoSCoW

| Kelas | Butir | Alasan singkat |
|---|---|---|
| **Must** | F1 Quick Open · F2 path→terminal/agent · F3 mutasi dasar · F4 copy relatif + reveal · F5 hidden/sort/gitignore | F1/F2/F4 = loop kerja pengguna webterm (menunjuk file ke agent); F3 = syarat "file manager" (kini hanya create+open); F5 = murah dan memperbaiki listing sehari-hari |
| **Should** | F6 status git · F7 cari isi · F8 multi-select · F9 recent/pinned · F12 upload/download | F6 penting untuk memantau agent tapi bergantung watcher/refresh (dok 37); F8 prasyarat aksi massal; F12 butuh keputusan keamanan |
| **Could** | F10 compare · F11 properties/ukuran folder · F13 zip · F14 chmod | Nilai nyata tapi ada alternatif lewat terminal webterm sendiri |
| **Won't (sekarang)** | F15 dual-pane/grid/tag/Quick Look/share-link/user mgmt/command runner; "Open with default app" | Di luar identitas; tab browser tak bisa membuka aplikasi OS server (`fileBrowse.ts:210-216`); command runner Filebrowser adalah pelajaran CVE |

`[opini]` Urutan nilai/biaya terbaik: F4 → F5 → F2 → F1 → F3 → F6.

## 6. Peta workstream implementasi (dasar `PLAN/*`)

Prinsip anti-bentrok: `FilesNode.tsx` (375 baris) adalah titik panas. WS-FM-00 memecahnya LEBIH DULU dan memasang "slot" kontribusi; WS lain hanya menyentuh file BARU miliknya + satu berkas slot yang sudah berisi impor stub. Semua file baru mengikuti batas Rule 8 (komponen/service ≤300, test ≤400).

| WS | Isi | Memiliki (tulis) | Dependensi | Ukuran |
|---|---|---|---|---|
| WS-FM-00 Fondasi | Pecah `FilesNode.tsx`: `useFilesListing.ts` (efek load, `pendingSel`), `filesMenu.tsx` (penggabung slot `[...open, ...path, ...terminal, ...mutation, ...info]`), `FilesRow.tsx`; sisakan `FilesNode.tsx` ≤200 baris. Tambah `DirEntry.size?/mtime?` (additif) di `fileBrowse.ts` + `fsOps.ts`. Router rute fs: `fsApi.ts` mendelegasikan verb ke `fsApi.*.ts` (stub kosong per WS). Test regresi `FilesNode.test.tsx` tetap hijau | `FilesNode.tsx`, `FilesNode.test.tsx`, `useFilesListing.ts`, `filesMenu.tsx`, `FilesRow.tsx`, `fsApi.ts`, `fileBrowse.ts` (hanya tipe `DirEntry`), `fsOps.ts` (hanya tipe+listDir) | — (gelombang 0) | M |
| WS-FM-01 Server mutasi | `rename/remove/copy/move/stat` + error contract sesuai dok 37 | `fsOps.mutate.ts`, `fsApi.mutate.ts`, `fsOps.mutate.bun.test.ts`, `fsClient.mutate.ts` | 00 | L |
| WS-FM-02 Client mutasi | Inline rename (F2), Delete + konfirmasi, duplicate, drag move antar folder, paste; kunci F2/Delete/Ctrl+C/X/V; rename memperbarui editor node terbuka | `filesMenu.mutation.tsx`, `filesKeys.mutate.ts`, `filesActions.ts`, `FilesRename.tsx`, tes terkait | 01 | L |
| WS-FM-03 Quick Open | Port `quickOpenSearch.ts` → `quickOpenSearch.ts` (client, murni) + server `fsFiles.ts` (rg→git→`Bun.Glob`, cap 50.000, blocklist) + rute `fsApi.files.ts` + UI `QuickOpen.tsx` (VscodeMenu/input, Ctrl+P saat node files fokus) | file-file baru tsb + tesnya | 00 | M |
| WS-FM-04 Path & terminal | Copy Relative Path/Name; "Insert Path in Terminal"; drag row → terminal (MIME khusus + handler `onDrop` di `TerminalNode.tsx`); `shellQuote.ts`; Reveal in Files dari `EditorNode.tsx` | `filesMenu.path.tsx`, `filesMenu.terminal.tsx`, `filesDrag.ts`, `shellQuote.ts`, `TerminalNode.tsx` (hanya handler drop), `EditorNode.tsx` (hanya tombol/menu reveal), tes | 00 | M |
| WS-FM-05 View options | Toggle hidden, sort, mode gitignore (dim/sembunyi), tersimpan di data node; menu "View" di header | `filesView.ts`, `FilesViewMenu.tsx`, `filesMenu.view.tsx`, tes (sort dilakukan di sisi client di `filesView.ts`; `fsOps.ts` tidak disentuh) | 00 | S–M |
| WS-FM-06 Git decoration | `GET/POST /api/git/status` (porcelain v2, cache per repo) + dekorasi baris + propagasi folder | `gitStatus.ts`, `gitStatus.bun.test.ts`, `shared/gitStatus.ts`, `filesGit.ts`, `files.git.css` | 00 (watcher/refresh: dok 37) | M |
| WS-FM-07 Multi-select | Set seleksi + anchor, Shift/Ctrl-klik, Ctrl+A, aksi massal (hook ke 02) | `filesSelection.ts`, `filesKeys.select.ts`, tes; integrasi ke `FilesNode.tsx` hanya via titik-sambung yang dipasang 00 | 02 | M |
| WS-FM-08 Cari isi | rg/git grep, hasil klik→editor pada baris | `fsGrep.ts`, `fsApi.grep.ts`, `FilesSearch.tsx`, tes | 03 (bagi pola lister) | M–L |
| WS-FM-09 Recent/Pinned | Daftar recent & pinned per workspace + UI | `filesPins.ts`, `FilesPins.tsx`, migrasi bila di SQLite | 00 | S–M |
| WS-FM-10 Transfer | Upload (drop OS) / download / zip-unzip / properties+chmod | `fsTransfer.ts`, `fsArchive.ts`, `fsApi.transfer.ts`, `FilesProps.tsx`, tes | 01, keputusan keamanan dok 37 | L |

Gelombang: **W0** = 00 → **W1 (paralel)** = 01, 03, 04, 05, 06, 09 → **W2** = 02 (butuh 01), 08 → **W3** = 07, 10. Berkas bersama yang TIDAK boleh disentuh siapa pun kecuali pemilik: `FilesNode.tsx`/`fsApi.ts` (00), `filesMenu.tsx` (00, hanya impor slot). Test integrasi lintas-WS (menu muncul lengkap) ditulis sekali di akhir oleh satu worker.

## 7. Implikasi untuk webterm

**Rekomendasi tegas:** jangan menambah fitur ke `FilesNode.tsx` apa adanya. Lakukan WS-FM-00 dulu, lalu Must (01–05) paralel; Should/Could menyusul per nilai. Kejar loop kerja webterm (F1, F2, F4) ketimbang meniru kelengkapan Finder.

| Butir | File yang disentuh | Ukuran |
|---|---|---|
| Fondasi + slot (WS-FM-00) | `FilesNode.tsx`, `useFilesListing.ts`, `filesMenu.tsx`, `FilesRow.tsx`, `fsApi.ts`, `fileBrowse.ts`, `fsOps.ts` | M |
| Quick Open (F1) | `quickOpenSearch.ts`, `fsFiles.ts`, `fsApi.files.ts`, `QuickOpen.tsx` | M |
| Path→terminal/agent + drag (F2) | `filesDrag.ts`, `shellQuote.ts`, `TerminalNode.tsx`, `filesMenu.terminal.tsx` | M |
| Copy relatif + reveal (F4) | `filesMenu.path.tsx`, `EditorNode.tsx` | S |
| Hidden/sort/gitignore (F5) | `filesView.ts`, `FilesViewMenu.tsx`, `DirEntry` (size/mtime) | S–M |
| Mutasi (F3) | lihat dok 37; `fsOps.mutate.ts`, `filesActions.ts` | L |
| Status git (F6) | `gitStatus.ts`, `shared/gitStatus.ts`, `filesGit.ts` | M |
| Sisanya (F7–F14) | per tabel §6 | S–L |

**Risiko:**
- **Eksekusi tak sengaja lewat F2:** path tanpa quoting atau berakhir `\n` bisa menjalankan perintah; wajib `shellQuote` + tanpa newline + tes dengan nama `a b'$(x)`.
- **Kontrak wire `DirEntry`:** menambah `size/mtime` memengaruhi dua deklarasi kembar client/server (`fileBrowse.ts:21`, `fsOps.ts:59`); buat additif/opsional.
- **Beban `rg`/`git status` pada repo besar:** wajib cap, timeout, dan pembatalan; indeks Quick Open per root di-cache dengan invalidasi manual/watcher.
- **Lisensi:** kode referensi eksternal di-port boleh (repo referensi proyek); Zed/Filebrowser jangan disalin (Zed campuran lisensi, Filebrowser diarsipkan).
- **Rule 13/8:** endpoint file index dan grep harus ber-cap/stream; `FilesNode.tsx` sudah 375 baris, penambahan fitur tanpa 00 melanggar batas.
- **Rule 10:** tidak ada dependensi baru yang disarankan di Must; kandidat opsional (diverifikasi registry npm 2026-11): `fuzzysort@4.0.2` MIT (hanya bila port referensi eksternal kurang), `fflate@0.8.3` MIT, `@parcel/watcher@2.6.0` MIT, `@tanstack/react-virtual@3.14.25` MIT — semuanya ditunda sampai terbukti perlu.

**Belum terverifikasi:** perilaku Finder/Nautilus/JetBrains/Zed (pengetahuan umum); nama setting `explorer.*` VS Code (halaman default-settings tak terbaca via curl); ketersediaan `rg` di lingkungan produksi pengguna; ukuran bundle `fflate`; apakah ada command palette/hotkey global webterm yang bentrok dengan Ctrl+P (grep "palette" hanya menunjukkan `App.tsx`/`CanvasToolbar.tsx`, tidak dibaca penuh); perilaku `Bun.Archive` untuk zip (hanya terdeteksi ada, tidak diuji).
