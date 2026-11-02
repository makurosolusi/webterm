# Audit visual build saat ini (feature/vscode-fidelity, http://127.0.0.1:8791)

Metode: ego-browser (TaskSpace `webterm-vsc-cur-01`), viewport 1440x900 (layar efektif sering 764 px tinggi) dan 1024 untuk toolbar.
Deteksi otomatis: `elementFromPoint` COVERED_BY (clip-aware), scrollWidth>clientWidth tanpa ellipsis, inventaris radius >5px, shadow, SVG, emoji, switch, font.
Semua screenshot: `RND/vscode-measured/shots/cur-*.png`. Tidak ada kode proyek yang diubah.

## Catatan lingkungan (artefak, bukan bug proyek)

- Font codicon dilayani 403 oleh Vite karena `node_modules` di worktree adalah symlink (di luar `/@fs/` allow-list). Tanpa perbaikan, SEMUA ikon codicon menjadi kotak tofu (`cur-00-initial.png`). Semua screenshot lain memakai `@font-face` data-URL yang saya suntik ke halaman (tidak menyentuh file). Layak diketahui: di dev worktree ikon akan rusak sampai `server.fs.allow` mencakup repo utama atau `node_modules` bukan symlink.
- Inbox menampilkan `GET /api/inbox failed (503 ledger_off)` dan Chat "Central chat is not enabled": ledger off di data dir uji, bukan bug UI. Tetapi lihat gap G-17 (kontradiksi "Loading..." vs "No conversations yet").
- Nilai env/secret di Settings > Environment tidak disalin (hanya status `Kosong`/write-only yang terlihat).

## Status keluhan A-F

| # | Keluhan | Status di build ini | Bukti |
|---|---|---|---|
| A | Chip ⌘K menimpa ikon sebelahnya | **MASIH ADA** | `cur-04-A-toolbar-zoom.png`, `cur-05-A-w1024.png`, juga terlihat di `cur-36-light-canvas.png` |
| B | Border atas tebal hijau, sudut membulat, ikon header aneh, tombol close merah | **SEBAGIAN**: border atas 2px berwarna swatch MASIH ADA; close tidak merah, radius 3px | `cur-08-node-unselected.png`, `cur-10-files-node.png`, `cur-12-editor-node.png`, `cur-14-editor-node-zoom.png`, `cur-13-all-nodes-fit.png` |
| C | FolderPicker footer menimpa list, ikon emoji, tombol/radius bukan VS Code | **SUDAH BERES** untuk overlap/emoji/tombol; sisa bug path | `cur-02-folderpicker-open.png`, `cur-43-create-workspace-dialog.png` |
| D | Activity bar kiri bawah: tombol lock tampak aktif, slot kosong di bawah "+" | **SEBAGIAN**: slot kosong tidak ada; lock `aria-pressed` meniru marker aktif nav, warna idle tidak seragam | `cur-15-D-activitybar-default.png`, `cur-16-D-activitybar-locked.png`, `cur-17-D-activitybar-focus.png`, `cur-18-D-activitybar-hover-tooltip.png` |
| E | Dialog "Add node" bukan Quick Pick | **MASIH ADA** | `cur-06-E-add-node.png` (bandingkan palette yang sudah Quick Pick: `cur-37-palette-light.png`) |
| F | Settings: toggle switch, dropdown terpotong, layout tidak vertikal | **SEBAGIAN**: checkbox dan layar penuh vertikal sudah; sisa select campur, teks select terpotong, chip toggle | `cur-24-F-settings-top.png`, `cur-26-F-settings-interaksi.png`, `cur-28-F-settings-agent.png`, `cur-32-F-settings-environment.png`, `cur-34-F-theme-dropdown.png` |

### A. Chip ⌘K menimpa ikon (MASIH ADA)
- Pengukuran: tombol `.cluster-search` lebar 22px, sedangkan isinya ikon search + `.kbd` chip (≈30px); chip meluber keluar tombol dan menutup tombol Explorer (`codicon-files`). Deteksi: `span.codicon.codicon-files` tertutup `span.kbd`.
- Akar penyebab: spesifisitas CSS. `src/client/canvas-ui.css` memuat `.controls-cluster > button { width:22px; height:22px; border-radius:5px; ... }` (0,1,1) yang mengalahkan `.cluster-search { width:auto; gap:6px; padding:0 6px; }` (0,1,0). Markup di `src/client/CanvasToolbar.tsx` ~147-165 (`<Button className="cluster-search">` berisi `.codicon-search` + `.kbd`).
- Saran: naikkan spesifisitas (`.controls-cluster > .cluster-search`) atau ubah aturan umum jadi `.controls-cluster > button:not(.cluster-search)`; atau hapus chip dari cluster (VS Code command center tidak punya chip di toolbar).

### B. Chrome node terminal (SEBAGIAN)
- Masih ada: `border-top-width:2px` dengan warna `--node-swatch` (biru `#0a84ff` untuk terminal; hijau Codex, oranye Claude) pada seluruh jenis node. Terlihat sebagai "garis tebal berwarna" di atas node, sedangkan VS Code tidak punya border atas berwarna pada editor group.
- Akar: `src/client/node-chrome.css` `.term-node { border:1px solid var(--vscode-editorGroup-border,...); border-top-width:2px; box-shadow:var(--nc-shadow) }`, plus `[border-top-color:var(--node-swatch)]!` di `TerminalNode.tsx:170`, `EditorNode.tsx:299`, `FilesNode.tsx:287`, `AgentNode.tsx:238` (inline `--node-swatch` dari `NodeColorSwatch.tsx`).
- Sudah beres: tombol close tidak merah, radius `--nc-radius: 3px` (bukan membulat besar), ikon header codicon.
- Sisa: ikon header node terminal menumpuk 4-5 ikon kecil tanpa label (split-h, split-v, refresh, search, mic, comment, fullscreen, close), tampil di editor/files juga; lihat gap G-4.

### C. FolderPicker (SUDAH BERES, sisa bug fungsional)
- Footer tidak menimpa list; ikon folder codicon (bukan emoji); tombol Cancel / "Select this folder" gaya VS Code; radius dialog 5px.
- Sisa: (1) `FolderPicker.tsx:73` `load(path + '/' + d)` menghasilkan `//private/tmp` saat path root `/`; (2) `.fp-path` memakai `direction: rtl` (`folderPicker.css:39-44`) sehingga garis miring awal tampil di ujung ("Users/bip/" tanpa `/` awal, `cur-43`). Lihat G-8, G-9.

### D. Activity bar bawah (SEBAGIAN)
- Tidak ada slot kosong di bawah "+": item = Sessions, Inbox, Chat, Board, Add node, Settings, lalu blok `.dock__modes` (Lock view, Clean view) di bawah.
- Lock/Clean view memakai kelas `vscode-activity-bar__item dock-btn` dengan `aria-pressed` (`Dock.tsx:289-311`, `dock.css:44` `.dock-btn[aria-pressed='true']`). Saat aktif tampil sama dengan item navigasi terpilih (garis marker kiri + ikon terang), sehingga terbaca sebagai "panel aktif". Warna idle lock/eye-closed berbeda dari ikon nav (204 vs 134 pada kanal terang).
- Saran: toggle mode dibuat sebagai tombol ikon tanpa marker (seperti item "Accounts/Manage" VS Code yang tidak punya marker), warna idle disamakan.

### E. Add node (MASIH ADA)
- `Dock.tsx`: `<Dialog><DialogContent className="dock-add-dialog">` (shadcn/Radix) berisi `.dock-add-list` dengan `<Button variant="ghost" className="dock-action-row">`: dialog tengah layar dengan backdrop dan bayangan Radix default, bukan Quick Pick di bawah title bar. Agen memakai titik warna `.dock-menu__glyph`, Terminal/Workspace memakai codicon: tidak konsisten. Tidak ada filter input, tidak ada keybinding, tidak ada hint. Tidak ada terpotong di 1440 (di lebar sempit belum diuji).
- Saran: pakai `VscodeQuickPick` (sudah dipakai palette) dengan input filter dan ikon codicon seragam (`terminal`, `hubot`, `folder`, `edit`).

### F. Settings (SEBAGIAN)
- Sudah: checkbox native bergaya VS Code (tidak ada `role=switch`, deteksi switch kosong), dialog layar penuh 1440x764, daftar kategori vertikal di kiri, kontrol vertikal (judul, deskripsi, kontrol).
- Sisa: tiga jenis dropdown bercampur (Radix select di Terminal, tombol-select kustom, `<select class="st-native-select">` di `EnvValueControl.tsx:29` untuk Environment); teks select terpotong tanpa ellipsis di Interaksi; `.st-chip` sebagai toggle abu-abu di Agent (`SettingsAgents.tsx:101-110`, `settings-controls.css:235-290`); campuran Indonesia/Inggris ("Skema warna", "Tinggi baris" vs "Settings", "Environment"); judul kategori "Terminal" menumpuk dengan baris pertama yang scroll di bawahnya (tidak sticky dengan benar, `cur-33`).

## Tabel gap

Level: H = high, M = medium, L = low.

| ID | Layar | Komponen & file sumber | Masalah visual | Lvl | Saran |
|---|---|---|---|---|---|
| G-1 | Canvas toolbar (1440 & 1024) | `.cluster-search` vs `.controls-cluster > button`, `canvas-ui.css`, `CanvasToolbar.tsx` | Chip ⌘K menimpa tombol Explorer (A) | H | Perbaiki spesifisitas / hapus chip |
| G-2 | Canvas | `.controls-cluster` (`position:absolute; z-index:26`) | Cluster menutupi tombol header node baru yang spawn di kanan atas (deteksi: `codicon-search/mic/comment/close` COVERED_BY) | H | Pindah toolbar ke title bar/status bar atau offset spawn node |
| G-3 | Add node | `Dock.tsx` `.dock-add-dialog`, `dock.css:68-74` | Dialog Radix bukan Quick Pick (E) | H | Ganti `VscodeQuickPick` |
| G-4 | Node chrome (terminal/files/editor) | `node-chrome.css`, `TerminalNode.tsx:170` dst. | Border atas 2px berwarna swatch (B); header terlalu banyak ikon tanpa label | H | Border 1px netral `--vscode-editorGroup-border`; swatch jadi dot kecil di tab |
| G-5 | Settings > Environment/Interaksi/Terminal | `EnvValueControl.tsx:29`, komponen select Settings | Tiga gaya dropdown berbeda, teks terpotong tanpa ellipsis (F) | H | Satu komponen select VS Code (`vscode-select`) |
| G-6 | Activity bar | `Dock.tsx:289-311`, `dock.css:44` | Lock/Clean view tampak seperti tab aktif; warna idle beda (D) | M | Hapus marker pada toggle mode, samakan warna |
| G-7 | Settings > Agent | `.st-chip` `settings-controls.css:266-290` | Chip abu-abu sebagai toggle (bukan checkbox) | M | Ganti checkbox VS Code |
| G-8 | FolderPicker | `FolderPicker.tsx:73` | Path ganda `//private/tmp` | M | Gabung path tanpa menggandakan `/` |
| G-9 | FolderPicker | `folderPicker.css:39-44` `.fp-path` rtl | `/` awal pindah ke ujung ("Users/bip/") | M | Pakai `text-overflow` dari kiri dengan elemen terbalik, atau breadcrumb VS Code |
| G-10 | Palette / Quick Pick | `CanvasToolbar.tsx:120` | Semua jenis node (files, editor) memakai ikon `terminal` | M | Ikon per `type` (`folder`, `edit`, `hubot`) |
| G-11 | Sessions sidebar | `.sessions-sidebar__count`, `.ss-tree__count` | Badge hitungan radius 8px (pill) dengan latar abu-abu, VS Code memakai badge `--vscode-badge-*` | L | Pakai token badge (radius 11px bawaan VS Code ok) atau hilangkan |
| G-12 | Sessions row | `ss-tree` row hover | Ikon trash saat hover menimpa teks meta (`tmp`) | M | Sembunyikan meta saat hover atau beri ruang |
| G-13 | Title bar | `.app-titlebar__name` `styles.css:240` | Pil abu-abu radius 6px lebar 600px (command center VS Code radius 5px, bordernya tipis) | L | Radius 5px, border `commandCenter-border` |
| G-14 | Menu bar | menu File/Help | Hanya 2 menu (tidak ada Workspace/View seperti brief), item tanpa kolom keybinding | M | Tambah keybinding dan menu View |
| G-15 | Minimap | `App.tsx:384`, `canvas-ui.css:161`, `styles.css:132` | Fill node biru terang jenuh (`#3b82f6`-like) di kedua tema; di light mencolok | M | Warna node minimap netral `--vscode-minimap-*` |
| G-16 | Canvas edge | label edge `open…` | Label edge terpotong di sisi kanan | L | Beri padding/`overflow: visible` |
| G-17 | Chat panel | `chat/*.tsx`, `chat/chat.css:129-142` | "Loading…" tetap tampil bersama "No conversations yet"; banner error kotak merah penuh lebar (bukan notifikasi VS Code); panel punya dua tombol X (tab dan sisi kanan) | M | Hapus Loading saat error; banner di dalam panel dengan ikon dan tombol kecil |
| G-18 | Inbox panel | `inbox.css` | Filter chip biru dengan radius, pesan error merah dengan tombol Retry biru tebal | L | Tombol sekunder VS Code |
| G-19 | Panel bawah (Chat+Inbox) | panel layout | Dua panel bertumpuk tanpa sash/resizer, header "CHAT" dan "INBOX" masing-masing dengan X | L | Satu panel dengan tab (seperti Problems/Output) |
| G-20 | Board | Kanban | Layar penuh menutup activity bar dan title bar; tombol Close abu-abu tebal; kolom kosong tanpa empty state | L | Jadikan editor tab atau overlay VS Code |
| G-21 | Dialog | `.vscode-dialog` (help, folder picker) | Bayangan `0 0 8px 2px` (widget-shadow) berbeda dari menu `0 2px 8px 0`; dialog Radix memakai bayangan default lain | L | Satu token bayangan per jenis widget |
| G-22 | Help overlay | `.help-overlay` | Kolom command wrap dengan tanda hubung ("di-hover"), tidak ada ikon tutup fokus; bersih lain | L | Perlebar kolom |
| G-23 | Settings umum | `st-*` | Judul bagian (Terminal) tidak sticky bersih; string campuran ID/EN; badge `default`/`restart` seperti chip dengan border | L | Samakan bahasa; badge VS Code |
| G-24 | Welcome / empty state | halaman awal workspace kosong | Label membungkus ke baris kedua (`cur-01-empty-fontfixed.png`) | L | Lebarkan tombol |
| G-25 | Lingkungan dev | `vite.config.ts` (tanpa `fs.allow`) | Codicon 403 di worktree dengan `node_modules` symlink, semua ikon tofu | M | `server.fs.allow` untuk root repo utama (catatan saja, hanya relevan di worktree) |
| G-26 | Light theme | `cur-35`, `cur-36` | Cukup konsisten; masalah yang sama (G-1, G-2, G-15) tetap; terminal terang tanpa kontras prompt di blok bawah | L | n/a |

Jumlah: 26 gap = High 5 (G-1 s/d G-5), Medium 10 (G-6 s/d G-10, G-12, G-14, G-15, G-17, G-25), Low 11 (sisanya).

## Inventaris elemen non-VS Code yang terdeteksi

- Emoji sebagai ikon: tidak ada di build ini (deteksi kosong di semua layar).
- Switch/toggle: tidak ada `role=switch`; sisa `.st-chip` (G-7).
- SVG non-codicon: hanya internal React Flow (`react-flow__marker`, `background`, `minimap-svg`) dan 1 SVG tanpa kelas di title bar (logo).
- Radius >5px: `.app-titlebar__name` 6px, `.vscode-quick-pick` 6px, `.sessions-sidebar__count` / `.ss-tree__count` 8px, badge Kanban `rounded-full` (Tailwind di Kanban), dot swatch `50%` (wajar).
- Bayangan: `.controls-cluster`, `.term-node` memakai `0 0 8px 2px` (terlalu besar untuk chrome flat VS Code), menu `0 2px 8px`.
- Warna di luar `--vscode-*`: minimap fill biru, `.st-chip.is-off`, banner `.chat-error` fallback `#f48771`.
- Cursor pointer pada chrome: tidak ditemukan (cursor default).
- Font di luar stack: tidak ditemukan.

## Kandidat CSS mati (hanya catatan, tidak diubah)

Skrip: ekstrak kelas dari semua `src/client/**/*.css`, lalu cari string kelas di seluruh `*.ts/tsx` non-test. Kelas tanpa satu pun referensi:

- `agent.css`: `.node-menu__item`, `.node-menu__item--danger`, `.node-menu__icon`, `.node-menu__sep`
- `canvas-ui.css`: `.node-menu--canvas`, `.node-menu__row`, `.node-menu__caret`, `.node-menu__dot`, `.node-menu__sub`, `.node-menu__item`
- `chat/chat.css`: `.chat-tool__state--awaiting_approval` (kemungkinan dinamis dari string state, verifikasi)
- `inbox.css`: `.inbox-state--needs_you` (kemungkinan dinamis, verifikasi)

Kandidat kuat mati: keluarga `.node-menu__*` (menu node lama sebelum migrasi ke `vscode-menu`).

## Tidak terjangkau

- Verifikasi hover/fokus tooltip per node, menu node (klik kanan pada node), popup swatch warna, tombol split, dan hover pada close node tidak seluruhnya diuji.
- Filter sessions kosong dan grup STATUS/NODES (screenshot 21 tidak dibuat).
- Notifikasi/toast tidak terpicu; Settings Preview/Canvas hanya screenshot, tanpa scroll penuh.
- Dialog "Add node" pada lebar sempit; FolderPicker dari form Workspace bernama (hanya dari "+").
