# VS Code Dark Modern — ukuran workbench/chrome (vscode.dev)

Sumber: https://vscode.dev (build Preview), Chromium via ego-browser, TaskSpace `webterm-vsc-ref-01`.
Metode: `getBoundingClientRect` + `getComputedStyle` langsung di DOM `.monaco-workbench`; token dibaca dari
`getComputedStyle(.monaco-workbench).getPropertyValue('--vscode-…')`. Token lengkap: `workbench-tokens.json` (314 token terkurasi).
Tag: **(diukur)** = nilai terbaca dari DOM; **(perkiraan)** = dari screenshot / pengamatan tunggal / transien.
Screenshot: `shots/workbench-*.png`. Overlay (menu, quick input, find, notifikasi, settings) dicakup worker lain: `shots/overlay-*.png`.

## 0. Temuan utama: DUA mode tampilan

vscode.dev default ke **"Workbench › Experimental: Modern UI" = ON** (class `modern-ui modern-ui-tabs
modern-ui-connected-editor-tabs modern-ui-notifications-dialogs floating-panels`). Mode ini membuat
activity bar / sidebar / editor / panel menjadi **kartu mengambang** (margin 4px, radius 8px, border 1px #252526) dan
mengubah banyak dimensi. Mode **Classic** (setting dimatikan) = persis angka `RND/20-VSCODE-UI-PLAN.md §1.1`.
Semua nilai di bawah diberi kolom Classic dan Modern. Warna token (Dark Modern) **identik** di kedua mode.
Radius token: `--vscode-cornerRadius-small/medium/large` = 4/6/8px (diukur).

Pilih satu mode sebagai target tiruan webterm — RND/20 saat ini = Classic.

## 1. Banner vscode.dev (bukan bagian workbench)

| Elemen | Nilai |
|---|---|
| Banner atas (khusus vscode.dev) | tinggi 26px, bg #04395e, font 12px (diukur). Abaikan untuk tiruan. |

## 2. Title bar & menu/command center

| Properti | Classic | Modern |
|---|---|---|
| Tinggi title bar | 35px (diukur) | 35px (diukur) |
| Background | #181818 (`titleBar-activeBackground`) | sama |
| Border-bottom | 1px #2b2b2b (`titleBar-border`) | sama |
| Shadow | `rgba(0,0,0,.08) 0 0 6px` (diukur) | sama |
| Command center | 613x24, font 12px (diukur) | sama |
| Ikon titlebar (label) | 22x22, padding 3px, radius 6px | radius 4px (layout icon) |
| Hover ikon | bg `rgba(90,93,94,.31)` (`toolbar-hoverBackground`) | sama |
| Font UI | `-apple-system, system-ui, sans-serif` (diukur), 13px | sama |

Menu bar (File/Edit/…) tidak muncul sebagai deretan di vscode.dev (dilipat jadi ikon hamburger di activity bar). Tinggi menu bar 35px dari RND/20 **tidak terverifikasi** (perkiraan).

## 3. Activity bar

| Properti | Classic | Modern |
|---|---|---|
| Lebar | 48px (diukur) | **44px** (x=4, margin kiri/bawah 4px) — KOREKSI |
| Item | 48x48 | **36x36**, gap 8px (stride 44) — KOREKSI |
| Ikon | codicon 24px, padding 3px, radius 6px | 24px, label radius 4px |
| Background | #181818 | #181818 |
| Border | tanpa border sendiri; sidebar punya border-right 1px #2b2b2b | border 1px #252526, radius 8px (sudut luar) |
| Indikator aktif | bar kiri 2px #0078d4 (`.active-item-indicator::before`, z=1) | **kotak 32x32 radius 4 bg `rgba(255,255,255,.13)`** (bukan bar kiri) — KOREKSI |
| Warna ikon | aktif/hover #d7d7d7, tidak aktif #868686 | aktif #cccccc, tidak aktif #868686 |
| Badge | tinggi 16, padding 0 4px, font 9px/600, radius 20px, bg #0078d4, fg #fff | sama |
| Accounts/Manage | di bawah, 48px tiap item | di bawah, 36px |
| Fokus keyboard | bar kiri 2px sama dengan aktif (diukur) | - |

## 4. Side bar

| Properti | Classic | Modern |
|---|---|---|
| Lebar default | 300px | 300px |
| Background / border | #181818 / border-right 1px #2b2b2b | #181818 / 1px #252526, radius 8px (kanan-bawah) |
| Title row | 35px, padding 0 8px; label 11px UPPERCASE, weight 400, line-height 35, padding-left 12 | **32px**, padding 0 4px; label 12px weight 600, `text-transform: capitalize` ("Explorer") — KOREKSI |
| Aksi title | 22x22 | 22x22 radius 4 |
| Pane header | **22px**, 11px, weight 700, UPPERCASE, chevron 16px; hover tidak berubah | **28px**, title 12px/600 capitalize, margin 0 4px, radius 4 — KOREKSI |
| Border pane header | 1px #2b2b2b (`sideBarSectionHeader-border`) | pemisah tipis |
| Baris list/tree (Open Editors) | 22px, padding-left 8px, 13px | 22px, margin 0 4px, radius 4px |
| Baris terpilih (tak fokus) | bg #37373d (`list-inactiveSelectionBackground`) | sama |
| Baris hover | bg #2a2d2e (`list-hoverBackground`) | sama |
| Baris terpilih+fokus | bg #04395e (`list-activeSelectionBackground`), outline #0078d4 (`list-focusOutline`) | sama |
| Badge hitungan header | font 10px, bg #616161, tinggi 16 (classic) | tinggi 18, fg #f8f8f8 |
| Tombol primer (Welcome view) | 26px tinggi, 12px, padding 4px 8px, radius 4px, bg #0078d4, hover #026ec1, border 1px `rgba(255,255,255,.1)` | sama |
| Fokus tombol | outline 1px #0078d4, offset 2px | sama |

Indent tree & chevron per level: **tidak terukur** (tak ada folder tree; lihat §15). Indent 8px dari RND/20 tak terverifikasi (perkiraan).

## 5. Tab bar

| Properti | Classic | Modern (connected tabs) |
|---|---|---|
| Strip | 35px, bg #181818 (`editorGroupHeader-tabsBackground`) | **32px**, strip bg #2b2b2b di belakang tab — KOREKSI |
| Tab tinggi | 35px | **31px**, radius 4px |
| Padding tab | padding-left 10px, border-right 1px #2b2b2b | padding 0 30.5px 0 6px, margin-right 8px |
| Tab aktif | bg #1f1f1f, fg #fff, inset shadow `rgba(0,0,0,.02) 0 8px 12px`; border-top 1px #0078d4 (`.tab-border-top-container`) | bg #1f1f1f (tersambung ke editor) |
| Tab tak aktif | fg #9d9d9d, bg #181818 | fg #9d9d9d |
| Tab hover | bg #1f1f1f, shadow `rgba(0,0,0,.08) 0 0 4px` | sama |
| Label | 13px; deskripsi 11.7px, opacity .7, margin-left 5.85px | label tinggi 24 |
| Ikon file | seti 19.5px, padding-right 6px | sama |
| Tombol close | 20x20, padding 2px, radius 6px, hover bg `rgba(90,93,94,.31)`; tab tak aktif **opacity 0 sampai hover** | 20x20 radius 4 |
| Dirty | titik di tombol close (`::before`) | sama |
| Garis bawah strip | `.tabs-and-actions-container::after` #2b2b2b | tak ada |
| Editor actions | 22x22, padding 0 8px 0 4px | 22x22 |

## 6. Breadcrumb

Tidak terukur: file Untitled tak menampilkan breadcrumb dan tak ada folder untuk dibuka (diukur = tidak ada). 22px dari RND/20 tak terverifikasi (perkiraan).

## 7. Editor, minimap, scrollbar

| Properti | Nilai |
|---|---|
| Background | #1f1f1f (`editor-background`) (diukur) |
| Part editor Modern | kartu: margin 4px, border 1px #252526, radius 8px — KOREKSI |
| Gutter nomor baris | 12px Menlo, #6e7681, aktif #cccccc; line-height 18 (diukur) |
| Highlight baris aktif | border #282828 (`editorLineHighlightBorder`) |
| Font editor | Menlo, Monaco, "Courier New", monospace, 12px |
| Minimap | lebar 120px (diukur); detail render tak diukur |
| Scrollbar vertikal | slider 10px (lebar track 14 di RND/20: tak terverifikasi); slider `rgba(121,121,121,.4)`, hover `rgba(100,100,100,.7)`, aktif `rgba(191,191,191,.4)` |

## 8. Status bar

| Properti | Classic | Modern |
|---|---|---|
| Tinggi | 22px | **28px**, padding 2px 12px — KOREKSI |
| Font | 12px | 12px |
| Background | #181818 (token noFolder #1f1f1f; screenshot awal sempat biru, lihat §15) | #181818, `box-shadow 0 1px 0 #181818` |
| Border-top | 1px #2b2b2b | tak ada |
| Item | label padding 0 5px, margin 0 3px; item pertama/terakhir 8px | tinggi 24, radius 4px, padding 6px (luar) / 5px, margin 0 3px |
| Hover | bg `rgba(241,241,241,.2)`, fg #fff, transition `background-color .15s ease-out` | sama |
| Foreground | #cccccc | #cccccc |

## 9. Panel bawah

| Properti | Classic | Modern |
|---|---|---|
| Container | border-top 1px #2b2b2b, bg #181818 | kartu: margin 4px, border 1px #252526, radius 8px |
| Title row | 35px, padding 0 8px | **32px** |
| Item tab | padding 0 10px, 11px UPPERCASE, weight 400 | padding 0 10px, **13px normal case** — KOREKSI |
| Warna | aktif #cccccc, tak aktif #9d9d9d | sama |
| Indikator aktif | garis 1px #0078d4 (`panelTitle-activeBorder`) ~28.5px di bawah atas panel | **pill 24px tinggi bg #37373d radius 4** (bukan garis) — KOREKSI |
| Aksi panel | 22x22 | 22x22 |
| Sash panel | 4px, row-resize | 4px |

## 10. Sash

| Properti | Nilai |
|---|---|
| Tebal | 4px (diukur), sash sidebar `col-resize` di x=346, sash panel `row-resize` |
| Hover | warna `sash-hoverBorder` #0078d4, transition `background-color .1s ease-out` |

## 11. Menu konteks (tombol Manage)

Radius 8px, shadow `rgba(0,0,0,.14) 0 0 12px`, item 24px, label padding 0 26px, separator 1px #454545 margin 5px, shortcut opacity .7 (diukur). RND/20 menu row 22px: **KOREKSI → 24px** (mode ini; Classic juga terbaca 24).

## 12. Tooltip / hover widget — (perkiraan)

bg #202020 (`editorHoverWidget-background`), border 1px `rgba(204,204,204,.2)`, font 12px, line-height 19, padding 2px 8px, shadow `rgba(0,0,0,.14) 0 0 12px`. Radius terbaca 3px di satu capture dan 8px di lain (capture saat fade) → **tidak pasti**. Delay muncul ~1.5s (satu pengamatan; default `workbench.hover.delay` = 1500). Lihat juga `shots/overlay-25-tooltip.png`.

## 13. Modal Settings (acuan dialog)

1152x562 di (144,101), radius 8px, shadow `rgba(0,0,0,.15) 0 0 20px`, header 33px (padding 0 8px 0 10px, border-bottom #2b2b2b) (diukur). Quick input: lebar 602 (600 + border 2), x=420, y=6 (hanya rect).

## 14. Pola interaksi

- **Fokus antar bagian**: F6 memutar fokus (editor, panel, status bar, activity bar, sidebar). Bagian terfokus: outline 1px solid #0078d4 offset -1px.
- **Fokus kontrol** (tombol): outline 1px solid #0078d4 offset 2px (`focusBorder`). List: `list-focusOutline` #0078d4.
- **Item activity bar terfokus keyboard**: tampil bar kiri 2px sama dengan aktif (Classic).
- **Hover**: ikon toolbar bg `rgba(90,93,94,.31)`; baris list #2a2d2e; tab hover bg #1f1f1f; item status bar `rgba(241,241,241,.2)`; pane header tidak berubah saat hover.
- **Transisi**: status bar item `background-color .15s ease-out`; sash `background-color .1s ease-out`; selain itu umumnya tanpa transisi (diukur dari computed style).
- **Tombol close tab**: opacity 0 sampai tab di-hover (tab tak aktif); tab dirty menampilkan titik, berubah jadi X saat hover.
- **Tooltip**: delay ~1.5s, memudar saat mouse keluar (perkiraan).
- **Cursor**: sash resize (`col-resize`/`row-resize`); selainnya default/pointer pada item klik.
- **Ctrl+J** tidak membuka panel di sesi otomasi; tombol layout di titlebar berhasil.

## 15. Hal yang tak bisa diukur / tak tersedia di vscode.dev

- **Terminal**: panel tertulis "Terminals are not available in the web editor…" → header/tab list terminal tak terukur.
- **Notification toast**: gagal dipicu (Open Folder, Backup & Sync, install extension tak menghasilkan toast; Cmd+S membuka file chooser yang dibatalkan). Hanya token: `notifications-background` #1f1f1f, `notifications-border` #2b2b2b, `notificationToast-border` #313131. max-width 400px dari RND/20 **tak terverifikasi**. Lihat `shots/overlay-24-notification.png` dari worker overlay.
- **Folder tree** nyata (indent, chevron per level, ikon folder): tak ada folder yang bisa dibuka; baris diukur dari Open Editors.
- **Find widget**: tidak diukur di worker ini (lihat `shots/overlay-23-find.png`).
- **Breadcrumb**: tak tampil untuk Untitled.
- **Tooltip radius & delay**: tak konsisten di otomasi (jendela dianggap "inactive"; hover kadang tak muncul).
- **Menu bar teks** (File/Edit/…): tak ada, dilipat ke hamburger.
- **Status bar biru** di screenshot awal (`workbench-00-initial.png`): computed style kemudian #1f1f1f; kemungkinan transien first-paint/no-folder, tak terjelaskan.
- Minimap detail, scrollbar horizontal, hover state mode Modern per elemen: tak diukur penuh.

## 16. Ringkasan KOREKSI terhadap RND/20 §1.1

RND/20 benar untuk **Classic**. Bila yang ditiru adalah vscode.dev default (Modern), koreksi:

| Elemen | RND/20 | Modern terukur |
|---|---|---|
| Activity bar lebar / item | 48 / 48x48 | 44 / 36x36 |
| Indikator aktif activity bar | bar kiri 2px | kotak 32x32 radius 4 `rgba(255,255,255,.13)` |
| Judul sidebar | 35px, UPPERCASE 11px | 32px, capitalize 12px/600 |
| Pane header | 22px UPPERCASE | 28px capitalize 12px/600 |
| Tab strip / tab | 35px / padding 0 10px | 32px / 31px, padding 0 30.5 0 6, radius 4 |
| Panel title | 35px, 11px uppercase, garis aktif | 32px, 13px normal, pill #37373d |
| Status bar | 22px | 28px (item 24px radius 4) |
| Bagian utama | rata, border 1px #2b2b2b | kartu mengambang margin 4 radius 8 border #252526 |
| Menu row | 22px | 24px |
