# 35b — Audit UI/UX node `files` (bagian B: tabel celah, yang dipertahankan, Implikasi)

Lanjutan dari `35-FILEMANAGER-UIUX-AUDIT-a.md` (bukti file:baris ada di bagian A, ID celah G-nn dirujuk di sini).

## 4. Tabel celah (prioritas)

P0 = kehilangan data / fungsi inti yang diminta user tak ada. P1 = merusak alur harian/a11y/kebenaran. P2 = polish.

| ID | P | Celah | Bukti | Ukuran |
|---|---|---|---|---|
| G-01 | P0 | New File menimpa file yang ada (truncate) tanpa cek | `FilesNode.tsx:204`, `fsOps.ts:211` | S |
| G-02 | P0 | Tak ada rename/delete/move/copy/duplicate (UI+client+server) | `fsClient.ts:30-110`, `fsApi.ts:81`, `:259-279` | L (lintas dok 37) |
| G-03 | P0 | Media (mp4/mp3 dst.) diarahkan `canvas` tetapi `editorFileKind` hanya image/pdf/text -> dibuka sebagai teks UTF-8 yang bisa disimpan (korupsi) | `fileBrowse.ts:216`, `editorFile.ts:39-44` (detail dok 36) | M |
| G-04 | P1 | Race: entri lama dapat diklik selama loading -> path salah | `:93,136,348` | S |
| G-05 | P1 | A11y: tanpa role/aria-label/activedescendant, dua model keyboard | `:326-334`, `vscode-tree.js:138` | M |
| G-06 | P1 | Keyboard: F2, Delete, Left/Right, PageUp/Down, Shift/⌘ multi-select, Menu key | `filesKeys.ts:68-93` | M |
| G-07 | P1 | Multi-select tidak ada (`sel` skalar) | `:68` | M |
| G-08 | P1 | `window.prompt` untuk buat; tak ada inline input; file baru tidak dibuka | `:199-207` | M |
| G-09 | P1 | Tak ada drag-drop (OS->upload, entri->terminal, antar folder) | grep kosong | L |
| G-10 | P1 | Touch: tanpa gestur buka/menu | `:172,178` | M |
| G-11 | P1 | Tak ada virtualisasi/paginasi; ribuan custom element | `:333`, `fsOps.ts:124` | M |
| G-12 | P1 | Dekorasi git hanya `ignored` (tanpa M/A/U) | `fsOps.ts:59-64` | M |
| G-13 | P1 | Tooltip/`title` nama terpotong tak ada; node sempit | `files.css:49`, `:285` | S |
| G-14 | P2 | Header tanpa `icon`/`description`; inkonsisten dengan Terminal | `:290-303` | S |
| G-15 | P2 | Ikon: 8 glyph, tanpa nama khusus, folder tak pernah terbuka, monokrom | `fileIcon.ts:5-27`, `:339` | S-M |
| G-16 | P2 | Breadcrumb manual 3 segmen vs menu overflow komponen | `fileBrowse.ts:93`, `vscodeBreadcrumbs.tsx:17` | S |
| G-17 | P2 | Seleksi indeks; hilang saat refresh/filter | `:68,105,114` | S |
| G-18 | P2 | Notice footer abadi, tanpa `aria-live`; error tanpa Retry; 401 terbaca "unreachable" | `:71,112,366`, `fsClient.ts:77` | S |
| G-19 | P2 | Sort tanpa natural-numeric; tanpa toggle hidden/sort/group | `fsOps.ts:136-138` | S |
| G-20 | P2 | Re-bind listener tiap render | `:114,194` | S |
| G-21 | P2 | Context menu tanpa pemisah/shortcut/Relative Path/Reveal/Refresh/Download | `:259-279` | S |
| G-22 | P2 | Ignored memakai opacity .45; kontras tema terang belum diukur | `files.css:47` | S |
| G-23 | P2 | Cakupan tes DOM minim: seleksi, dblclick, menu, race, error state tak dites | `FilesNode.test.tsx` (2 tes) | M |
| G-24 | P2 | Maximize vs Full Screen membingungkan; zoom rendah tanpa LOD | `:300-301` | S |

## 5. Hal yang sudah benar dan harus dipertahankan

- Logika murni terpisah dan bertes (`fileBrowse`, `filesKeys`, `fileOpen`); klasifikasi empty-listing berhati-hati; type-ahead berkualitas; scroll-reveal manual (tidak menyeret canvas); dedup node editor per path + kabel penanda; invariant `stopPropagation` untuk Backspace; token VS Code murni (tanpa literal warna); menu di-portal; guard path `..` (`fileBrowse.ts:59-67`).
- Kontrak read throws vs list fail-open (`fsClient.ts:8-23`) beralasan kuat (cegah ⌘S menimpa file dengan buffer kosong); jangan diubah saat menambah verbs - tambahkan verbs yang melempar galat berkode.

## Implikasi untuk webterm

**Rekomendasi tegas** (urut): (1) tutup G-01 dan G-04 dulu karena kecil dan menghentikan kehilangan data/salah path; (2) bangun lapisan mutasi (G-02) bersama dok 37 sebelum menambah UI rename/delete; (3) pertahankan model "list satu direktori" sebagai default tetapi pindah ke tree bawaan (expand in-place, multi-select) hanya bila G-05/G-06/G-07 ditangani bersamaan - mengubah ke tree tanpa a11y yang benar memperburuk keadaan; (4) jangan menambah dependensi tree/virtual-list sebelum mengukur biaya `vscode-tree-item` di Chrome.

| # | Perubahan konkret | File disentuh | Ukuran |
|---|---|---|---|
| 1 | Cek eksistensi sebelum buat (`exists` lalu notice, atau flag exclusive di server `wx`) | `FilesNode.tsx`, `fsClient.ts`, (`fsOps.ts`) | S |
| 2 | Kosongkan/nonaktifkan daftar saat `loading`; simpan seleksi per nama | `FilesNode.tsx` | S |
| 3 | Inline rename + Delete (dengan konfirmasi) + F2/Delete + menu: UI | `FilesNode.tsx`, `filesKeys.ts`, komponen baru `FilesRow`/`FilesInput` | L |
| 4 | Role/aria: `role="tree"`/`aria-label` di wadah fokus, `aria-activedescendant` atau roving tabindex pada item; hilangkan model ganda | `FilesNode.tsx`, `files.css` | M |
| 5 | Multi-select (Set nama + anchor) + Shift/⌘, PageUp/Down | `filesKeys.ts`, `FilesNode.tsx` | M |
| 6 | Ganti `window.prompt` dengan input inline/QuickInput VS Code; buka file baru setelah dibuat | `FilesNode.tsx`, komponen input | M |
| 7 | Drag path entri ke terminal/agent (dataTransfer `text/plain` + tipe kustom) dan drop file OS -> upload | `FilesNode.tsx`, terminal node, endpoint upload (dok 37) | L |
| 8 | Header `icon="folder"` + `description={cwd}`; `maxVisible` breadcrumb; `title` pada nama baris | `FilesNode.tsx`, `fileBrowse.ts` | S |
| 9 | Ikon: peta nama khusus + warna per bahasa + folder terbuka; set penuh hanya bila disetujui (lisensi MIT terverifikasi) | `fileIcon.ts`, `files.css` | S-M |
| 10 | Dekorasi git M/A/U via slot `decoration` dari `git status --porcelain` (satu proses per list, batas entri) | `fsOps.ts`, `fileBrowse.ts` DirEntry, `FilesNode.tsx` | M |
| 11 | Performa: `content-visibility:auto` dulu, ukur 5k entri di Chrome, baru putuskan virtualisasi; paginasi/batas `listDir` | `files.css`, `fsOps.ts` | S, lalu M |
| 12 | Tes DOM: seleksi, dblclick, menu, race loading, error/retry | `FilesNode.test.tsx` (+ harness) | M |

**Risiko**: refaktor ke tree besar mengubah model `sel`, handler capture, `reveal`, dan semua tes; handler native fase-capture bergantung pada perilaku shadow DOM komponen 2.5.1 (upgrade versi bisa memutusnya). Menambah tombol keyboard harus mempertahankan `stopPropagation` (Backspace menghapus node). Delete tanpa trash = tak dapat dibatalkan (dok 37). Upload/DnD menambah permukaan serangan (ukuran, path, tipe).

**Belum terverifikasi** (`[BT]`): biaya render ribuan `vscode-tree-item`; perilaku long-press/double-tap di iOS; dukungan `content-visibility`; kontras `ignored` di tema terang; keymap Explorer/Finder yang dikutip dari pengetahuan umum; apakah komponen 2.5.1 punya mode render virtual; perilaku `contextmenu` dari keyboard; warna `selected-inactive` komponen. Tidak ada app/browser yang dijalankan (aturan keras).
