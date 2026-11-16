# 35a — Audit UI/UX node `files` (bagian A: ringkasan, peta, audit per dimensi)

Tanggal 2026-11-03. Worktree `rnd-files` (dari `main` @ fdaf2b4). Metode: baca kode penuh, tanpa menjalankan app/browser. Klaim visual (piksel, perilaku browser nyata) yang tidak bisa dibuktikan dari kode ditandai `[BT]`; opini `[opini]`. Cakupan tetangga: viewer/format -> dok 36, mutasi/sinkronisasi server -> dok 37, benchmark fitur -> dok 38.

## 1. Ringkasan eksekutif

Node `files` hari ini adalah **daftar satu direktori (flat list) read-mostly**, bukan tree: satu `cwd`, navigasi masuk/naik mengganti isi, bukan expand in-place. Port ramping dari referensi eksternal; yang hilang dibanding referensi eksternal: download & reveal (`FilesNode.tsx:12-13` header komentar; referensi eksternal `FilesNode.tsx:351-372`). Yang tidak pernah ada di kedua sisi: rename, delete, move, copy, multi-select, drag-drop.

Tiga temuan terpenting:
1. **P0 kehilangan data**: "New File…" memanggil `write(target, '')` tanpa cek eksistensi (`FilesNode.tsx:204`; `fsOps.ts:211` `writeFile` default flag `w` = truncate). Memberi nama file yang sudah ada menimpanya dengan nol byte, tanpa konfirmasi.
2. **P0 fungsi inti hilang**: tidak ada rename/delete/move/copy/duplicate di UI maupun `fsClient.ts:30-110` (hanya `list/read/readBinary/exists/write/mkdir`) dan `fsApi.ts:81` (POST hanya `write|mkdir`). Tujuan user eksplisit menyebut update/edit/delete/rename.
3. **P0/P1 a11y + keyboard**: fokus nyata ada di `<div tabIndex=0>` tanpa role (`FilesNode.tsx:326`), baris dipilih lewat state React `sel` bukan fokus DOM, tanpa `aria-activedescendant`; pembaca layar tidak diberi tahu baris aktif. Tidak ada F2/Delete/Left/Right/PageUp/PageDown/Shift-select.

## 2. Peta komponen saat ini

| Lapisan | File | Peran |
|---|---|---|
| Node UI | `src/client/FilesNode.tsx` (375 baris) | state, handler, render |
| Keputusan murni | `fileBrowse.ts` (234), `filesKeys.ts` (111), `fileOpen.ts` (54), `fileIcon.ts` (27) | path, breadcrumb, filter, type-ahead, rencana open, ikon |
| Chrome | `NodeChrome.tsx`, `NodeToolbar.tsx`, `NodeContextMenu.tsx` -> `VscodeMenu` | header, toolbar, menu (portal ke body) |
| Baris | `@vscode-elements/elements` 2.5.1 `vscode-tree`/`vscode-tree-item` (terpasang di `node_modules`) | role `tree`/`treeitem`, hover/selected |
| Stylesheet | `files.css` (69 baris) | hanya tata letak + isi slot, token `--vscode-*` dengan fallback |
| Client fs | `fsClient.ts` | 4 GET + 2 POST, kontrak error ganda (fail-open traversal, throw read) |
| Server | `fsApi.ts`, `fsOps.ts` | `/api/fs/{list,read,read-binary,exists,write,mkdir}` |
| Tes | `FilesNode.test.tsx` (2 tes DOM), `fileBrowse.test.ts`, `filesKeys.test.ts`, `fileOpen.test.ts`, `fileIcon.test.ts` | logika murni bagus; DOM nyaris kosong |

Alur buka file: dblclick/Enter -> `open()` (`FilesNode.tsx:135`) -> `fileOpenTarget` (`fileBrowse.ts:216`) -> `planFileOpen` -> node `editor` baru 660x460 di kanan + kabel `context` kind `file`. Dedup per `filePath` (`fileOpen.ts:19`). Desain ini bagus dan harus dipertahankan.

## 3. Audit per dimensi

### 3.1 Tata letak & tree vs list

- Header: `NodeChrome` dipanggil **tanpa `icon` dan `description`** (`FilesNode.tsx:290-303`), padahal `TerminalNode.tsx:184` memakai `icon="terminal" description={d.cwd}`. Node files tak punya ikon tipe dan path penuh hanya ada di breadcrumb. Inkonsisten dengan node lain.
- Breadcrumb di dalam body (`:306-315`), bukan header. Dipotong manual oleh `breadcrumbs(cwd, 3)` (`fileBrowse.ts:93`) menjadi crumb "…" yang melompat ke direktori tersembunyi terdalam. Komponen `VscodeBreadcrumbs` sudah punya `maxVisible` + menu overflow `role="menu"` (`vscodeBreadcrumbs.tsx:17-40`) yang tak dipakai: pengguna tak bisa memilih leluhur tersembunyi.
- Bukan tree: `Tree hideArrows indentGuides="none"` (`:332`) dipakai sebagai list datar; fitur tree bawaan komponen (branch/expand, `ArrowLeft/Right`, indent guides, slot `decoration`/`description`/`actions`) tak terpakai. Konsekuensi: tidak bisa melihat dua level sekaligus, tidak bisa drag antar folder, tidak ada konteks "di mana saya".
- Footer `"N of M"` (`:366`) hanya hitungan; tak ada ukuran/mtime/jumlah terpilih. Tak ada kolom ukuran/tanggal (list view Finder) [opini: untuk node 240-600px, kolom opsional saat lebar cukup].
- Sort: folder dulu lalu `localeCompare` (`fsOps.ts:136-138`) tanpa opsi `numeric`: `file10` sebelum `file2`; VS Code memakai urutan natural by default [BT]. Tak ada kontrol sort/group.
- File dot ditampilkan semua kecuali `.git` (`fsOps.ts:133`); tak ada toggle hidden. `.DS_Store` ikut tampil di macOS.

### 3.2 Ikon

- Set yang dipakai: **codicon saja** (`fileIcon.ts:5-17`), ~40 ekstensi dipetakan ke 8 glyph: `file-code` dipakai untuk ts/js/py/go/rs/css/html/yml dst. (tak dapat dibedakan sekilas), `markdown`, `json`, `file-media`, `file-pdf`, `file-zip`, `terminal`, sisanya `file`. Dites di `FilesNode.test.tsx:25-40`.
- Tidak ada pemetaan nama khusus (`package.json`, `Dockerfile`, `.gitignore`, `.env`, lockfile, `README`), tidak ada ikon folder khusus (`node_modules`, `src`, `.github`), dan **folder tidak pernah memakai ikon terbuka** (`folderIconClass(false)` di `FilesNode.tsx:339`; varian `open=true` di `fileIcon.ts:25` tak terpakai).
- Warna: monokrom `--vscode-icon-foreground` (`files.css:42`). VS Code default (tema ikon Seti) berwarna per bahasa [BT]; tema "Minimal" memang monokrom, jadi ini konsisten dengan Minimal bukan default. Mencolok untuk agen/pengembang yang memindai 50+ file.
- Kandidat set penuh (lisensi/pemeliharaan diverifikasi 2026-11-03 lewat GitHub API & registry npm): `vscode-material-icon-theme` MIT, push 2026-10-31, npm `material-icon-theme` 5.40.0 (1,68 MB unpacked); `vscode-icons` MIT, push 2026-11-02, npm `vscode-icons-js` 11.6.1 (421 KB); `seti-ui` MIT, push 2025-10-28. `@vscode/codicons` 0.0.46 berlisensi **CC-BY-4.0** (atribusi; sudah dipakai). Pilihan -> dok 38/plan; Rule 10: pemetaan nama file + warna CSS di `fileIcon.ts` bisa dulu tanpa dependensi baru (S).

### 3.3 Baris, hover, selected, focus

| Aspek | Kondisi | Bukti |
|---|---|---|
| Tinggi baris | 22px dari `vscode-tree-item` (sesuai ukuran VS Code Open Editors 22px, `RND/vscode-measured/workbench.md:66`; kanvas-sidebar mode "card" 22px + margin 4 radius 4) | `files.css:30` |
| Hover/selected | dimiliki komponen; selected = state `sel` index tunggal | `FilesNode.tsx:334` |
| Fokus terlihat | outline 1px `focusBorder` pada **div list**, bukan pada baris; tidak ada penanda baris "aktif tapi list tak terfokus" | `files.css:28` |
| Selected saat list blur | tidak dites; warna `selected` vs `selected-inactive` bawaan komponen `[BT]` |
| Ignored | `opacity: .45` seluruh baris (`files.css:47`) vs VS Code `gitDecoration.ignoredResourceForeground` (warna teks) [BT]; opasitas ikut meredam ikon+nama dan gagal kontras WCAG di tema terang [opini, hitung kontras belum dilakukan] |
| Tooltip nama panjang | tak ada `title` pada baris; `.files-name` ellipsis (`files.css:49`); node min lebar 240 (`:285`) sehingga nama terpotong tak terbaca |
| Dekorasi git | hanya `ignored`; tak ada M/A/U/D, tak ada badge folder (slot `decoration` tersedia, tak dipakai) |

### 3.4 Interaksi pointer

- Klik = pilih, dblclick = buka (`:166-177`), klik kanan = menu. Handler native di fase capture karena komponen menelan event di shadow DOM (`:154-157`, alasan sah; tes DOM hanya memverifikasi render, bukan alur ini).
- Effect pemasangan handler bergantung pada `[shown]` (`:194`) padahal `shown = filterEntries(...)` selalu array baru tiap render (`:114`, `fileBrowse.ts:167` `[...entries]`): listener dicabut/dipasang ulang **setiap render**. Kecil tapi tak perlu; `useMemo` atau ref.
- Klik area kosong list tak membatalkan seleksi (hanya baris yang di-hit, `:166-171`). Klik kanan area kosong memberi menu level folder (`:327`), bagus.
- Touch/web channel: `dblclick` untuk membuka dan `contextmenu` untuk menu; di iOS Safari long-press tak memicu `contextmenu` dan double-tap memicu zoom [BT]. Tidak ada gestur tap-untuk-buka maupun tombol "…" per baris -> node files nyaris tak bisa dipakai di ponsel [opini: karena produk adalah "web channel", ini P1].
- **Race loading** (P1): `navigate` mengubah `cwd` seketika, tetapi `entries` lama dipertahankan sampai fetch selesai (`:93` `setEntries` hanya setelah `await`; `loading` hanya menambah teks "Loading…" di bawah, `:348`). Selama jendela itu daftar lama masih bisa diklik dan `open()` menyusun `childPath(cwd_baru, nama_lama)` (`:136`) -> membuka path yang tak ada. Perbaikan: kosongkan `entries` / disable baris saat `loading`, atau simpan `dirOfEntries`.
- Refresh/`version++` menjatuhkan seleksi (`:105`, `want === null ? -1`): menekan Refresh memindahkan fokus logis ke "tidak ada". Seleksi sebaiknya disimpan per nama.
- `sel` adalah **indeks** ke `shown`; mengetik di filter menggeser isi `shown` sehingga seleksi berpindah ke entri lain tanpa disadari (`:68`, `:114`). Simpan nama.
- Buat file/folder membuka `window.prompt` (`:199`): dialog native browser, bukan gaya VS Code, terblokir di konteks tertentu (iframe tanpa `allow-modals`, mode kiosk/PWA) [BT], tak bisa validasi inline, memblokir thread. Sesudah buat, file baru **tidak dibuka** (Explorer VS Code membuka file baru di editor) dan tidak ada inline-input di tempat.

### 3.5 Context menu

Lima aksi (`:259-279`): Open, Open in Integrated Terminal, New File…, New Folder…, Copy Path. Tanpa pemisah, tanpa shortcut yang ditampilkan, tanpa Rename/Delete/Duplicate/Copy Relative Path/Reveal/Download/Refresh. Menu dirender lewat `VscodeMenu` (portal ke `document.body`, roving focus, type-ahead - `NodeContextMenu.tsx:36-43`), jadi posisi di bawah zoom canvas aman. Tak ada pembuka dari keyboard (tombol Menu / Shift+F10): `contextmenu` event dari keyboard memberi `clientX/Y` = 0 atau pusat elemen, dan handler capture menyaring lewat `rowIndexFrom(event.target)` sehingga baris terpilih via keyboard tak punya jalan ke menu [BT].
"Copy Path" hanya path absolut dan galat clipboard hanya jadi notice (`:277`).

### 3.6 Keyboard: perbandingan

Handler: `onListKeyDown` (`:231-250`) + `listKeyAction` (`filesKeys.ts:68-93`). Klaim keymap pembanding diambil dari pengetahuan umum `[BT: tidak diverifikasi ulang sesi ini]`.

| Fungsi | webterm | VS Code Explorer | Finder |
|---|---|---|---|
| Naik/turun | ArrowUp/Down | sama | sama |
| Awal/akhir | Home/End | Home/End | ⌘↑↓ beda arti |
| Halaman | **tidak ada** PageUp/PageDown | ada | Fn↑↓ |
| Buka | Enter, ⌘↓ | Enter (Win/Linux), ⌘↓ (mac) | ⌘↓ |
| Naik folder | Backspace, Alt+↑, ⌘↑ | tree: ArrowLeft ke induk | ⌘↑ |
| Expand/collapse | **tidak ada** (bukan tree) | Left/Right | Left/Right (list) |
| Rename | **tidak ada** | F2 (Win/Linux), Enter (mac) | Enter |
| Delete | **tidak ada** | Delete / ⌘⌫ | ⌘⌫ |
| Copy/Cut/Paste | **tidak ada** | ⌘C/⌘X/⌘V | ⌘C/⌘V, ⌘D duplikat |
| Multi-select | **tidak ada** (`sel` skalar) | Shift/⌘ + klik/panah | sama |
| Type-ahead | ya, prefix + siklus (`filesKeys.ts:25-36`, sangat baik) | ya | ya |
| Filter | tombol toolbar "Search"; Esc menutup; Ctrl+F **tidak** membuka | Ctrl+F di tree [BT] | ⌘F |
| Quick Open | tidak ada | ⌘P | - |

Catatan desain: Backspace = "naik" konflik semantik dengan Delete saat Rename/Delete ditambahkan; bila Delete kelak, Backspace tetap "naik" (gaya Windows Explorer) tapi ⌘⌫ harus = delete [opini]. Sebuah klaim bagus dari kode: semua tombol yang ditangani di-`stopPropagation` karena Backspace pada canvas React Flow menghapus node (`:232-234`) - invariant ini harus dijaga saat menambah tombol baru, dan **printable-char claim** (`:244`) menelan semua karakter (termasuk `?`, `/`) sehingga shortcut global node-level tak pernah lewat saat list fokus.

### 3.7 Empty / loading / error

Empat keadaan terpisah dengan benar (`:346-363`; `classifyEmptyListing` `fileBrowse.ts:131`): missing, unreachable, empty (welcome + tombol New File…), no-match filter. Kelebihan: tidak berbohong "folder hilang" saat tak yakin. Celah:
- Loading hanya teks "Loading…" tanpa spinner/skeleton dan tanpa mengosongkan daftar lama (lihat race 3.4).
- Error `unreachable`/`missing` tanpa tombol Retry/"Go up"; pengguna harus ke breadcrumb.
- Karena `fsClient.list` fail-open (`fsClient.ts:77`) error HTTP 401 (token salah) tampil identik "tidak terjangkau" - pesan menyesatkan, tidak menyebut auth [opini; kontrak sengaja, tapi bedakan 401/403 dari kosong].
- `notice` di footer (`:71`, `:366`) hanya dibersihkan saat ganti `cwd` (`:112`), tidak memiliki timeout, tidak `aria-live`; notice "Could not create" bertahan selamanya. Footer juga bukan `role="status"`.
- Welcome view hanya "New File…" (tidak ada "New Folder", "Open Terminal here").

### 3.8 Drag & drop

Tidak ada sama sekali (`grep dragstart|onDrop|dataTransfer` di `src/client` hanya cocok di `dockMerge.test.tsx`, tidak terkait). Konsekuensi: tak bisa seret file dari OS untuk upload (server juga tak punya endpoint upload), tak bisa seret entri ke node terminal untuk menempel path, tak bisa seret antar folder untuk move, tak bisa seret ke node editor. Catatan teknis: list ber-kelas `nodrag` (benar untuk React Flow); event drag HTML5 asli tidak bentrok dengan pan/drag node asalkan `draggable` dipasang di baris dan `onDrop` di list/terminal. Sinergi webterm (seret path ke terminal/agent) adalah nilai tertinggi untuk produk ini -> dok 38.

### 3.9 A11y

| # | Temuan | Bukti |
|---|---|---|
| a | Fokus DOM ada di `div.files-list tabIndex=0` tanpa `role`/`aria-label`; `vscode-tree` (role `tree`, `vscode-tree.js:178`) dan `treeitem` (`vscode-tree-item.js:163`) memang ada, tetapi fokus tak pernah berada di item. Seleksi hanya atribut `selected` -> `aria-selected` | `FilesNode.tsx:326,334` |
| b | Tidak ada `aria-activedescendant`; panah tidak mengumumkan baris | `:231-250` |
| c | Dua model seleksi/keyboard hidup bersamaan: milik komponen (`ArrowDown` di `vscode-tree.js:138`) dan milik node. Aman sekarang karena fokus di div, tapi rapuh bila fokus dipindah ke item (tab) - pilih satu | `:231` vs komponen |
| d | Ikon `aria-hidden` (benar); dekorasi `ignored` hanya opasitas, tidak ada teks "ignored" untuk AT | `files.css:47` |
| e | Footer/notice tanpa `aria-live`; hasil filter tanpa pengumuman | `:366` |
| f | Breadcrumb sudah `nav`/`ol`/`aria-label` (baik), tapi crumb "…" bukan menu | `vscodeBreadcrumbs.tsx:87-93` |
| g | Target sentuh 22px < 24px WCAG 2.2 AA target size minimum (2.5.8) [BT, tapi baris VS Code memang 22px; kompensasi: spacing] | - |

### 3.10 Responsif, zoom, tema

- Ukuran: min 240x160 (`:285`), collapsed 40px (`:38`), `files-node` flex column. Pada 240px: breadcrumb + filter + footer memakan ~70-90px [BT] sisanya ~70px untuk daftar; tidak ada mode compact.
- Zoom canvas: layout px mengikuti transform; tidak ada LOD. Pada zoom < ~0.5 teks 13px menjadi ~6px; node tidak menyederhanakan diri [opini: cukup untuk MVP, bukan prioritas]. Menu di-portal ke body sehingga tidak ikut zoom (`NodeContextMenu.tsx:36-43`) - tepat. Scroll roda: `nowheel` pada list benar (`:326`) - roda menggulir list, bukan zoom canvas; konsekuensi: saat list tak punya overflow, roda tidak menembus ke canvas [BT].
- Maximize memakai `fitView` (`:301`) - tidak mengubah ukuran node; Full Screen dari `NodeChrome` terpisah (`useNodeFullscreen`). Dua tombol sering membingungkan [opini].
- Tema: `files.css` 100% token `--vscode-*` dengan fallback `var(--text|muted|border)`; komentar header menyatakan tanpa literal warna - bersih. Satu pengecualian rasa: `.files-empty--error` jatuh ke `--state-warning` (amber) bila `errorForeground` tak ada (`:52`). Tema terang/gelap otomatis; kontras ignored belum diukur.

### 3.11 Performa daftar besar

- Semua entri dirender sekaligus: `shown.map` -> satu `vscode-tree-item` (Lit custom element + shadow DOM) per entri (`:333`). Tanpa virtualisasi, tanpa batas, tanpa paginasi di `listDir` (`fsOps.ts:124-139`; Rule 13 global). Direktori `node_modules` atau cache dengan ribuan entri -> ribuan shadow root; biaya per item belum diukur `[BT]` (perlu benchmark jsdom tak berguna; ukur di Chrome).
- Server: `flagIgnored` melewati direktori >2000 entri sehingga **tidak ada yang diredam** tanpa tanda (`fsOps.ts:88,93`, `ponytail:` comment). Satu proses `git check-ignore` per list tiap kali refresh - tidak di-cache.
- `reveal()` memakai `treeRef.children[idx]` (`:220`) - mengandalkan urutan DOM = indeks; aman selama tak ada grup/header baris.
- Virtualisasi memerlukan baris custom (bukan `vscode-tree-item`) atau mode `data` komponen [BT: tidak diperiksa apakah 2.5.1 menyediakan render virtual]. Opsi native lain: `content-visibility: auto` + `contain-intrinsic-size: 22px` pada `vscode-tree-item` (S) [BT dukungan di Chromium/Safari/Firefox per 2026].

### 3.12 Konsistensi dengan node lain

| Aspek | files | terminal/editor |
|---|---|---|
| Ikon tipe di header | tidak ada | terminal `icon`, `description=cwd` (`TerminalNode.tsx:184`) |
| Refresh | ada di menu "More actions", bukan tombol primer (`NodeToolbar.tsx` `moreItems`) | - |
| Judul auto-ikut folder | ya, hingga diganti manual (`:116-121`) - bagus | - |
| Dirty/unsaved | n/a | editor punya titik dirty (`EditorNode.tsx:309`) |
| Prompt native | `window.prompt` (`:199`) | komponen VS Code (Textfield/Menu/Dialog) |
| Tes DOM | 2 | lebih banyak |


Lanjutan (tabel celah, yang dipertahankan, Implikasi): `35-FILEMANAGER-UIUX-AUDIT-b.md`.
