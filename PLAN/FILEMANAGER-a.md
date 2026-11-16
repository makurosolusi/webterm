# PLAN FILEMANAGER-a — Tujuan, arsitektur, keputusan produk, workstream, gelombang

Bagian: **a** (§1-4) · `FILEMANAGER-b.md` (§5-10: kontrak, tes, keamanan, rollout, risiko) · `FILEMANAGER-c.md` (§11a: spec WS-FM-00..05) · `FILEMANAGER-d.md` (§11b: spec WS-FM-06..11).
Basis: worktree `rnd-files` (HEAD `fdaf2b4`), R&D `RND/35..38`. Semua klaim kode sudah dicek ke `src/` (file:baris di RND, diverifikasi ulang untuk `FilesNode.tsx:196-208`, `fsOps.ts:211`, `api.ts:38-45`, `fsApi.ts:57-97`, `fsClient.ts:28-73`, `store.ts:13`, `shared/workspace.ts:437-438`). `[BT]` = belum terverifikasi. Tak ada kode/app dijalankan untuk dokumen ini.

## 1. Tujuan & non-tujuan

**Tujuan** (permintaan user: UI/UX detail, kesesuaian project, fitur yang dibutuhkan, tampilan file & format, kebenaran update/edit/delete/rename):

| # | Tujuan | Ukuran keberhasilan (bukti wajib) |
|---|---|---|
| T1 | Tutup 4 temuan P0 tanpa regresi: (a) New File menimpa file ada (G-01/M-01), (b) ⌘S tanpa cek konflik + membuat ulang file terhapus (M-02), (c) body POST `data += chunk` merusak multibyte + tanpa cap (M-03), (d) audio/video/zip terbuka sebagai teks yang bisa disimpan (G-03/M-05) | tes regresi nyata per P0 (§6), merah di `main`, hijau di branch |
| T2 | Kebenaran mutasi: create/write/rename/move/copy/delete(+trash, Undo) dengan error berkode dan versi/konflik | tes `bun test` per verb + tes DOM alur UI |
| T3 | Tampil & format: viewer gambar/audio/video/pdf/markdown, biner ditolak jujur, symlink/broken terlihat | tes registry viewer + tes endpoint raw (Range/ETag/CSP) |
| T4 | UI/UX detail: a11y, keyboard (F2/Delete/panah/Shift/⌘), multi-select, input inline (ganti `window.prompt`), header ikon+deskripsi, dekorasi git, natural sort | tes DOM per perilaku |
| T5 | Sinkronisasi: editor/listing tahu perubahan eksternal & rename | tes watcher + bus event |
| T6 | Rapi terhadap aturan global: file ≤ batas Rule 8, tanpa hardcode (Rule 15), flag fitur default OFF, nol dependensi baru | gate §7 |

**Non-tujuan (v1)**: tree view penuh (P-2), zip/unzip, chmod UI, compare/diff 2 file, tag Finder, preview kolom, rename massal, rename protokol ke `webterm` (ditangani terpisah), perbaikan DNS-rebinding transport (P-6, hanya ditandai), Windows, penyuntingan encoding non-UTF-8 (P-4: read-only), terminal-drop yang menyentuh `TerminalNode` (di luar kepemilikan; lihat R-09).

## 2. Rekomendasi arsitektur (satu, tegas)

**"Fondasi dulu, slot kemudian"**: satu WS integrator (WS-FM-00) memegang SEMUA hot spot dan memasang kabel (kontrak tipe, dispatcher, flag, event bus, manifest slot, stub berperilaku-legacy) dalam W0a; setelah itu tiap fitur adalah **file baru milik satu WS** yang dicolok lewat manifest slot (`filesSlots.ts`) di klien dan handler bernama-tetap di server. Tidak ada WS lain yang menyentuh `api.ts`/`index.ts`/`fsApi.ts`/`nodeTypes.tsx`/`nodeList.ts`/`envRegistry*`/`protocol.ts`/`workspace.ts`/`store.ts`/`fsClient.ts`.

Pilar teknis (semua reuse, nol dependensi baru):

| Pilar | Keputusan | Reuse |
|---|---|---|
| Create | `open(path,'wx')` → `EEXIST` 409 (kernel yang memutuskan; benar di APFS case-insensitive) | `fs.promises.open` |
| Save | `expectedVersion` (opaque dari `stat` bigint `mtimeNs`+`size`), atomic temp+rename dgn fallback in-place (nlink>1, symlink-lintas-volume, dir tak writable) | pola `referensi eksternal fs-atomic.ts` (rujukan, tulis ulang ringkas) |
| Body | `readCappedBody` (Buffer[] + cap, sudah ada di `channels/channelHttp.ts`) menggantikan `readBody` untuk rute `/api/fs/*` saja; `readBody` lain (git/control) TIDAK diubah | `readCappedBody` |
| Error | `{ok:false, code, error[, current]}` + status HTTP bermakna; verb lama mempertahankan `ok` | `READ_FAILURES` pola `fsOps.ts:162-168` |
| Jenis file | satu `shared/fileKind.ts` dipakai server (sniff) + klien (viewer, ikon) | `editorFile.ts:39-45` (diserap) |
| Delete | trash buatan sendiri di `<WEBTERM_DATA_DIR>/trash/` + Undo; Shift+Delete permanen+konfirmasi | `fs.rename` (+copy/rm bila EXDEV) |
| Sync | `fs.watch` per direktori yang dibuka + refcount + debounce 150 ms + polling fallback, kirim petunjuk "dirty" lewat `/ws` yang ada; klien: bus `fsEvents.ts` | `ws` handler `index.ts` |
| Viewer | `GET /api/fs/raw` (Range/ETag/304/`nosniff`/CSP sandbox) + registry viewer + `ViewerHost` dipasang di `EditorNode` | `<img>/<audio>/<video>/<iframe>` native |
| Git | `git status --porcelain=v2 -z` satu proses per direktori, cap entri | `shared/gitInfo.ts` pola |
| Cari | `rg --files` → `git ls-files` → `Bun.Glob`, cap 50.000 | proses yang ada |
| Persist opsi tampilan | field kecil `viewOpts` di blob `WsNode` (NOL migration, lihat komentar `workspace.ts:419`) | blob JSON SQLite |

**Alternatif ditolak:**

| Alternatif | Ditolak karena |
|---|---|
| Rewrite ke tree (`vscode-tree` bersarang) di v1 | Ubah model `sel`, handler capture, `reveal`, semua tes; RND/35 menolak tanpa a11y benar; biaya render ribuan item `[BT]` belum diukur |
| Pecah WS per kemampuan tanpa integrator (tiap WS edit `api.ts`/`fsApi.ts`) | Tabrakan di working tree/merge; langgar aturan satu pemilik hot spot |
| Dependensi baru (react-arborist/virtual-list/multer/chokidar/archiver) | Rule 10: `<20 baris` / sudah ada; `fs.watch`+`Bun.file`+`Bun.Glob` cukup; nol dependensi |
| Hapus langsung `fs.rm` default | Tak dapat dibatalkan; agent berjalan bersamaan di FS yang sama (RND/37 §M-07); trash+Undo murah |
| ETag dari `mtimeMs` float | Presisi hilang → konflik terlewat; pakai bigint |
| Token via header untuk `<img src>` | Tidak mungkin pada elemen native; token-in-query + `Referrer-Policy: no-referrer` (P-5), ticket jangka-pendek ditunda |
| Watcher chokidar/parcel | Dependensi; `fs.watch` non-rekursif per direktori yang dibuka cukup untuk listing satu-direktori |

## 3. Keputusan produk (P-n) — default dipakai bila user diam

| P | Pertanyaan | Default (rekomendasi) | Alternatif | Dampak bila beda |
|---|---|---|---|---|
| **P-1** | Delete default | **Trash buatan sendiri + Undo toast**; `Shift+Delete` permanen + konfirmasi | permanen+konfirmasi saja | WS-FM-04 lebih kecil (−fsTrash.ts) tapi tak ada pemulihan |
| **P-2** | Bentuk tampilan v1 | **List satu direktori** (seperti sekarang) | tree in-place | tree = WS baru L + ubah `sel`; tunda sampai ukuran `vscode-tree-item` di Chrome terukur |
| **P-3** | Dependensi baru | **Nol** | — | tiap tambahan wajib laporan Rule 10 |
| **P-4** | File bukan UTF-8 | **Read-only + banner**, tak ada Save; biner murni → placeholder | deteksi+tulis balik Latin-1/UTF-16 | WS tambahan M di luar v1 |
| **P-5** | Auth endpoint `raw` | **token-in-query + `Referrer-Policy: no-referrer`** (sama pola `fsClient.url`) | ticket sekali-pakai | WS-FM-06 +S, perlu penyimpanan ticket |
| **P-6** | DNS-rebinding (M-10) | **Di luar scope, ditandai** (butuh allowlist Host di `auth.ts`, area lain) | masukkan ke WS-FM-00 | memperluas hot spot; usulkan WS terpisah |
| **P-7** | Quick Open `Ctrl/⌘+P` | **Hanya saat node files fokus** | global | bentrok shortcut browser/terminal |
| **P-8** | File baru setelah dibuat | **Dibuka di editor** | tetap di list | UX tiru Explorer |
| **P-9** | Hidden/ignored | **Hidden tetap tampil seperti sekarang + toggle**, ignored diredam (dim) | sembunyikan default | ubah perilaku yang user kenal |
| **P-10** | Sort | **Natural-numeric, folder dulu**, toggle nama/ukuran/mtime | tetap alfabet | kecil |
| **P-11** | Flag default | `WEBTERM_FILES_MUTATE/_VIEWERS/_WATCH/_GIT_STATUS/_QUICK_OPEN/_UPLOAD` **semua OFF** sampai S-gate lulus; 4 perbaikan P0 TIDAK di balik flag | P0 di balik flag | P0 harus selalu hidup |
| **P-12** | Konflik saat simpan | **Banner Reload / Overwrite** (tanpa merge UI) | diff 3-arah | diff = fitur terpisah |
| **P-13** | Write atomik | **Default untuk file reguler nlink=1**; fallback in-place otomatis | opt-in | agent membaca bersamaan → atomik lebih aman |
| **P-14** | Tabrakan nama beda-huruf | **Dianggap konflik** (EEXIST kernel); rename hanya-ganti-huruf diizinkan | izinkan keduanya | FS case-insensitive tak bisa |
| **P-15** | Persist opsi tampilan per node | **Ya** (`viewOpts`: hidden, sortKey, sortDir) | sesi saja | +field di `workspace.ts`/`store.ts` (WS-00) |

**3 keputusan paling menentukan untuk user**: P-1 (trash vs permanen), P-2 (list vs tree), P-6 (DNS-rebinding keluar scope).

## 4. Workstream, kepemilikan, gelombang

Cabang integrasi `feature/fm-integration` dari `main` (dibuat orkestrator). Tiap WS cabang `feature/<nama>` dari integrasi; merge ke integrasi hanya atas konfirmasi orkestrator; merge ke `main` hanya atas perintah user. Worker dilarang commit/push/ganti branch (aturan orkestrasi).

| WS | Nama | Branch | Gel. | Ukuran | Bergantung pada |
|---|---|---|---|---|---|
| WS-FM-00 | Fondasi & hot spot | `feature/fm-foundation` | W0a | M | — |
| WS-FM-01 | Server inti: create/write/read/list benar | `feature/fm-server-core` | W0b | M | 00 |
| WS-FM-02 | Editor aman (konflik, biner, rename) | `feature/fm-editor-safety` | W0b, W2 | M | 00, 01 (tes int.), 06 (W2) |
| WS-FM-03 | Shell FilesNode (P0 UI → pecah → a11y/keyboard/multi-select/input inline) | `feature/fm-files-shell` | W0b, W1 | L | 00, 01 |
| WS-FM-04 | Mutasi server + trash | `feature/fm-mutate-server` | W1 | M | 00, 01 |
| WS-FM-05 | Mutasi UI (rename/delete/copy/duplicate/Undo) | `feature/fm-mutate-ui` | W2 | M | 03, 04 |
| WS-FM-06 | Viewer + endpoint raw | `feature/fm-viewers` | W1 | M | 00, 01 |
| WS-FM-07 | Watcher & sinkronisasi | `feature/fm-watch` | W2 | M | 00, 03 |
| WS-FM-08 | Dekorasi git | `feature/fm-git-status` | W2 | S | 00, 03 |
| WS-FM-09 | Quick Open, cari, DnD ke terminal | `feature/fm-quickopen-dnd` | W3 | M | 03, 05 |
| WS-FM-10 | Upload/download | `feature/fm-transfer` | W3 | M | 00, 03, 04 |
| WS-FM-11 | Dokumen, CHANGELOG, tes integrasi | `chore/fm-docs` | W4 | S | semua |

Peta ke benchmark RND/38: 38-WS-FM-00 (pecah+slot) = 00 + fase W1 di 03 (pecah ditunda ke setelah P0 agar P0 tidak menunggu refaktor); 38-WS-01..10 dipetakan ke 01/04/05/06/07/08/09/10 (diubah: P0 dipindah ke W0b).

### 4.1 Matriks kepemilikan file (satu pemilik per path per gelombang)

Aturan: sebuah path dimiliki satu WS; **handover** (stub W0a → pemilik fitur) eksplisit di kolom "serah". Tak ada dua WS menyentuh path yang sama dalam gelombang yang sama.

| Path | Pemilik | Gelombang aktif | Serah |
|---|---|---|---|
| `src/shared/fsContract.ts`, `shared/fileKind.ts`(+test), `shared/fsLimits.ts`, `shared/protocol.ts`, `shared/workspace.ts` | WS-00 | W0a saja | read-only bagi lain |
| `src/client/store.ts`, `fsClient.ts`(+test), `fsEvents.ts`(+test), `filesSlots.ts`(+test), `nodeTypes.tsx`, `nodeList.ts` | WS-00 | W0a | read-only |
| `src/server/api.ts`, `index.ts`, `fsApi.ts`(+`fsApi.dispatch.test.ts`), `envRegistry.ts`, `envRegistry.files.ts`(+test) | WS-00 | W0a | read-only |
| `src/server/fsOps.ts` | WS-00 (wrapper ≤30 baris) → WS-01 | W0a → W0b | 00→01 di awal W0b |
| `src/server/fsOps.write.ts`, `fsAtomic.ts`, `fsOps.test.ts`, `fsOps.bun.test.ts`, `fsOps.write.bun.test.ts`, `fsApi.bun.test.ts` | WS-01 (stub write: WS-00) | W0b | stub 00→01 |
| `src/client/EditorNode.tsx`, `editorFile.ts`(+test), `EditorNode.test.tsx`, `editor.css`, `fileOpen.ts`(+test), `fileOpenEdge.test.tsx`, `EditorConflictBar.tsx`(+test) | WS-02 | W0b, W2 | — |
| `src/client/FilesNode.tsx`, `FilesList.tsx`, `FilesRow.tsx`, `FilesInput.tsx`, `FilesMenu.tsx`, `filesSelection.ts`, `filesKeys.ts`(+test), `fileBrowse.ts`(+test), `fileIcon.ts`(+test), `files.css`, `FilesNode.test.tsx`, `files.shell.test.tsx`, `canvasHarness.tsx` | WS-03 | W0b, W1 | — |
| `src/server/fsOps.mutate.ts`, `fsTrash.ts`, `fsOps.mutate.bun.test.ts`, `fsTrash.bun.test.ts` | WS-04 (stub: WS-00) | W1 | stub 00→04 |
| `src/client/filesSlot.mutate.tsx`, `filesName.ts`, tes | WS-05 (stub: WS-00) | W2 | stub 00→05 |
| `src/server/fsRaw.ts`, `fsRaw.bun.test.ts`, `src/client/viewers/*` | WS-06 (stub: WS-00) | W1 | stub 00→06 |
| `src/server/fsWatch.ts`, tes, `src/client/filesSlot.watch.ts`, tes | WS-07 (stub: WS-00) | W2 | stub 00→07 |
| `src/server/fsGit.ts`, tes, `src/client/filesSlot.git.tsx`, tes | WS-08 (stub: WS-00) | W2 | stub 00→08 |
| `src/server/fsSearch.ts`, tes, `src/client/filesSlot.search.tsx`, `filesSlot.dnd.ts`, `QuickOpen.tsx`, tes | WS-09 (stub: WS-00) | W3 | stub 00→09 |
| `src/server/fsUpload.ts`, tes, `src/client/filesSlot.upload.tsx`, tes | WS-10 (stub: WS-00) | W3 | stub 00→10 |
| `CHANGELOG.md`, `README.md` (terbatas), `docs/decisions/files-manager.md`, `src/server/fileManager.integration.bun.test.ts` | WS-11 | W4 | — |

Batas Rule 8 diterapkan per tipe: route/dispatcher ≤150, service ≤300, komponen ≤300, utility ≤200, config ≤100, types ≤300, tes ≤400; hard 500 baris/20.000 karakter. `FilesNode.tsx` (375 baris sekarang) wajib dipecah di W1 (WS-03); `fsOps.ts` (238) tidak boleh bertambah >300 → fungsi tulis pindah ke `fsOps.write.ts`.

### 4.2 Gelombang

| Gel. | Isi | Masuk | Keluar |
|---|---|---|---|
| **W0a** | WS-00 sendirian (±½-1 hari) | cabang integrasi ada | typecheck+vitest+bun hijau; tes dispatcher; body-fix lulus tes multibyte; flag terdaftar OFF; semua stub ada (perilaku legacy atau 501 `EDISABLED`); `fsContract.ts` ter-commit |
| **W0b** | 01 ‖ 02(fase 1) ‖ 03(fase 1) paralel — **4 P0 tuntas** | W0a merge | tes regresi 4 P0 hijau; tak ada file di luar kepemilikan berubah |
| **W1** | 03(fase 2) ‖ 04 ‖ 06 | W0b merge | shell terpecah (tiap file ≤300); verb mutasi + trash teruji; raw + registry viewer teruji |
| **W2** | 05 ‖ 02(fase 2) ‖ 07 ‖ 08 | W1 merge | mutasi UI end-to-end (tes DOM); editor ikut rename; watcher+git di balik flag |
| **W3** | 09 ‖ 10 | W2 merge | Quick Open, DnD, upload/download di balik flag |
| **W4** | 11 | W3 merge | CHANGELOG+docs+tes integrasi; pre-deploy checklist (Rule 6) dapat ditampilkan |

Konflik tak terduga (worker butuh file milik lain) → STOP, lapor ke orkestrator; bukan edit sendiri.
