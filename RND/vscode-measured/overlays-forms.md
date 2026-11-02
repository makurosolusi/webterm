# VS Code Dark Modern: overlay & form (diukur dari vscode.dev)

Sumber: https://vscode.dev (Preview, tema Dark Modern), viewport 1440x764, DPR 2, ego-browser TaskSpace `webterm-vsc-ref-02`.
Semua angka px CSS dari `getComputedStyle`/`getBoundingClientRect`. Label: **(diukur)** vs **(perkiraan)**. Perbandingan dengan `RND/20-VSCODE-UI-PLAN.md` §1.1 ditandai **KOREKSI**.
Token mentah: `overlays-forms-tokens.json` (154 var `--vscode-*` relevan). Screenshot: `shots/overlay-*.png`.

## 0. Temuan inti: dua varian UI

vscode.dev terbaru punya setting `workbench.experimental.modernUI` (kartu mengambang). Pengukuran saya sempat melewati keduanya karena profil browser dipakai bersama:

| Properti | Modern UI (awal) | Klasik (dominan di bawah) |
|---|---|---|
| radius widget (quick input, dialog, menu, find, hover) | 8px | 12px (quick input, dialog) / 8px (menu, find, notif) |
| radius input | 4px | 6px (quick input) / 4px (lainnya) |
| radius row list | 4px | 3px (quick pick) / 6px (menu) |
| sidebar | kartu mengambang | menempel, header view UPPERCASE |

Rekomendasi: tiru varian klasik untuk webterm (lebih stabil, cocok dengan "Dark Modern" dokumentasi). Angka di bawah = klasik kecuali ditulis lain.

**KOREKSI global vs plan §1.1:** radius BUKAN 2px. Pakai skala `cornerRadius`: small 4 / medium 6 / large 8 / xLarge 12 (var `--vscode-cornerRadius-*`, diukur). Bayangan widget BUKAN `0 8px 24px rgba(0,0,0,.36)`: quick input & dialog `0 0 20px rgba(0,0,0,.15)`, menu/find/hover/notif-center `0 0 12px rgba(0,0,0,.14)` (diukur).

## 1. Quick Input / Command Palette / Quick Open

| Elemen | Nilai (diukur) |
|---|---|
| Widget | lebar 600 (+1px border kiri/kanan = 602), left 420 (tengah), top 6px (di bawah titlebar/banner, `top:6px` relatif workbench), z 2550 |
| Widget visual | bg `#222222`, border 1px `#313131`, radius 12px (klasik) / 8px (modern), shadow `0 0 20px rgba(0,0,0,.15)`, font 13px/18.2px |
| Header | padding `6px 6px 4px` |
| Input box | tinggi 25 (input dalam 23, padding `4px 6px`), bg `#313131`, border 1px `#3C3C3C`, radius 6px (klasik)/4px (modern), fokus: outline 1px `#0078D4` offset -1px (selalu fokus) |
| Placeholder Quick Open | "Search files by name (append : to go to line or @ to go to symbol), or paste a link" |
| Daftar | mulai y=44 (6+header 38), area scroll padding `0 6px`, tinggi baris **22**, tinggi maks tampak 277 pada palette (maks ~ 20 baris=440 di plan; belum diuji penuh) |
| Row normal | fg `#CCCCCC`, transparan, entry padding `0 4px` (palette) / `0 6px` (picker lain), radius 3px (klasik)/4px (modern), cursor pointer |
| Row fokus/seleksi | bg `#04395E`, fg `#FFFFFF` |
| Row hover | bg `#2A2D2E`, fg `#CCCCCC` |
| Highlight cocok | bold 700, warna `#2AAAFF` |
| Keybinding badge | font 11px/10px, padding `3px 5px`, margin-right 2px, bg `rgba(128,128,128,.17)`, border 1px `rgba(51,51,51,.6)` (bawah `rgba(68,68,68,.6)`), radius 3px, inset shadow `0 -1px 0 rgba(0,0,0,.36)` |
| Aksi baris (gear) | ikon 16, padding 2 (20x20), margin-left 4, radius 4 |
| Pemisah grup | border-top 1px `#3C3C3C` pada entry pertama grup; label grup di KANAN, 11px `#9D9D9D` (mis. "recently opened", "other commands"), margin-right 4 |
| Deskripsi | 11.7px, opacity 0.7, margin-left 5.85px |
| Scrollbar daftar | 8px, slider `rgba(121,121,121,.4)` radius 4, fade `opacity .8s linear` |
| Varian title bar (picker bertitel, "Open Folder"-like) | bg bar `rgba(255,255,255,.1)`, padding-top 2px, tombol back 20x20 (ikon 16), judul padding `3px 0`; bg widget `rgb(37,37,38)` |
| Toggle header (centang "semua") | 22x22, padding 3, radius 6 |
| Picker 2 baris (Walkthrough) | label + tag "Built-In" + detail di baris kedua; tooltip hover gelap |

**KOREKSI vs plan:** input 25px (plan 24), radius input 6/4 (plan 2), bg widget `#222222` bukan `#202020` (editorWidget=#202020 hanya untuk find/hover/dialog), `list-activeSelectionBackground` pada quick pick = `#04395E` (plan `#094771`). Lebar 600 dan top 6px COCOK.
Animasi buka 250ms scale 0.97 di plan: **tidak teridentifikasi** pada widget (tak ada `transition`/`animation` terbaca pada `.quick-input-widget`); anggap muncul langsung (perkiraan).

## 2. Dialog modal (Unsaved changes)

Dipicu dengan menutup tab untitled ber-isi. Screenshot `overlay-16-dialog.png` (dibaca, cocok dengan angka).

| Elemen | Nilai (diukur) |
|---|---|
| Backdrop | fullscreen 1440x764, bg `rgba(0,0,0,.5)`, z 2575, flex center |
| Kotak | 480 konten (498 total dg padding 8 + border 1), tinggi 142 (konten 124), bg `#202020`, border 1px `#313131`, radius 12px, shadow `0 0 20px rgba(0,0,0,.15)` |
| Baris tombol close | tinggi 24 (padding-bottom 4), tombol X 22x22 (ikon 16, padding 3, radius 6) di kanan atas |
| Baris pesan | padding `0 8px 0 12px`; ikon 24x24 (warning `#CCA700`), kontainer pesan padding-left 12 |
| Judul | 14px / 600 / lh 18.2, margin-bottom 4 |
| Detail | 13px / lh 20, warna `#CCCCCC` |
| Baris tombol | padding-top 20, tombol rata kanan (margin-left kontainer 67), gap 8 (margin 4 tiap tombol) |
| Tombol | tinggi 26, padding `4px 8px`, font 12px/16px, radius 4px, lebar mengikuti teks |
| Urutan (macOS) | `Don't Save` , `Cancel` , `Save` (primer paling kanan) |
| Primer | bg `#0078D4` (hover/fokus `#026EC1`), fg `#FFF`, border 1px `rgba(255,255,255,.1)`; fokus awal pada primer: outline 1px `#0078D4` offset 1px |
| Sekunder | bg transparan, fg `#CCC`, border 1px `rgba(204,204,204,.15)`, hover bg `#2B2B2B` |
| Footer / checkbox | tidak ada pada dialog ini (NULL) |

**KOREKSI vs plan:** lebar 480 COCOK. Padding 20 BUKAN: padding kotak 8, ikon/baris 12, jarak ke tombol 20. Judul 14px/600 bukan 16px. Radius 12 bukan 2-6. Tombol 26px.

## 3. Menu & context menu

Hamburger (web) dan context menu tab. Screenshot `overlay-17..21`.

| Elemen | Nilai (diukur) |
|---|---|
| Kontainer | bg `#1F1F1F` (`menu-background`), border 1px `#454545`, radius 8px, z 2000 (hamburger) / 2575 (context view), shadow `0 0 12px rgba(0,0,0,.14)` (context) |
| Padding vertikal bar | `4px 0` |
| Item | tinggi **24**, `action-menu-item` margin `0 4px` (inset 4px kiri-kanan), radius 6px, flex |
| Label | 13px, lh 13, padding `0 26px` (kiri 26 = slot centang/ikon `menu-item-check` lebar 26) |
| Kolom shortcut | `keybinding` 13px, padding `0 26px`, opacity .7, rata kanan; disabled opacity .4 |
| Panah submenu | ikon 16, padding `0 28.8px`, opacity .7 |
| Pemisah | item tinggi 11, garis 1px `#454545`, margin `5px 0` |
| Hover/fokus | bg `#2A2D2E` (list-hover), fg tetap `#CCC` (TIDAK `#0078D4`, walau token `menu-selectionBackground=#0078d4` ada) |
| Disabled | label `rgba(204,204,204,.5)`, cursor default, tanpa hover |
| Centang | ikon `codicon-menu-selection` di slot 26 kiri |
| Submenu | terbuka ~ langsung ke kanan item, menempel (x=290.9 vs induk kanan 289.9), tinggi 493 (File), lebar 336 |
| Transisi | `transform .05s` pada item |
| Urutan isi tab context | Close, Close Others, Close to the Right, Close Saved, Close All, sep, Save, Save As, sep, Reopen Editor With, sep, Keep Open, Pin, sep, Split Right, Split & Move, sep, Move/Copy into New Window |

**KOREKSI vs plan:** baris 24 (plan 22), padding item `0 26px` dalam inset 4px (plan `2px 26px 2px 2px`), radius 6/8 (plan 2), shadow 0 0 12px.

## 4. Settings editor (modal editor, Cmd+,)

Overlay modal 1152x562.4 di (144,100.8) (~80% viewport), bg `#1F1F1F`, border 1px `rgba(204,204,204,.2)`, radius 8px, shadow `0 0 20px rgba(0,0,0,.15)`. Screenshot `overlay-10..15`.

| Bagian | Nilai (diukur) |
|---|---|
| Header modal | tinggi 32, padding `0 8px 0 10px`, bg `#181818`, border-bottom 1px `#2B2B2B`, judul 12px/600; ikon tombol 16, padding 3, radius 6 |
| Header settings | margin-top 11, padding `3px 24px 0` |
| Search | tinggi 26, bg `#313131`, border 1px `#3C3C3C`, radius 4, padding `2px 6px`; badge hitungan 18 tinggi 11px `#9D9D9D` |
| Tab User/Workspace/Remote | widget tinggi 32.7, label padding `7px 8px 6.5px`; aktif fg `#FFF` + border-bottom 1px `#FFF`, tidak aktif `#CCC` opacity .9 |
| Tombol "Backup and Sync Settings" | 26 tinggi, padding `4px 8px`, 12px/16px, bg `#0078D4` (hover `#026EC1`), radius 4 |
| TOC kiri | lebar 200 (baris 176 efektif), baris 22px, 13px/lh 22, opacity .9; terpilih: fg `#FFF`, teks bold 700, outline fokus 1px `#0078D4` offset -1; shadow `0 0 4px rgba(0,0,0,.08)` |
| Daftar (tree) | lebar 950, padding horizontal item 24 |
| Konten item | padding `12px 14px 26px` (bool) / `12px 14px 18px` (lain) |
| Judul | "Kategori: Nama": kategori 600 opacity .9, nama 600 `#FFF` (settings-headerForeground) |
| Deskripsi | margin-top -1, opacity .9, 13px/18.2 |
| Blok nilai | margin-top 9 |
| Hover baris | `contents` bg `rgba(42,45,46,.3)`; gear (22x22, ikon 16, padding 3, radius 6) opacity 0 -> tampil, `transition opacity .3s` |
| Modified | border kiri 2px `rgba(187,128,9,.4)`; teks "(Modified elsewhere)" setelah judul |
| Validasi | bg `rgb(90,29,29)`, border `rgb(190,17,0)` |
| Tinggi item | bool 98, enum 107, number/text 106 (124 dengan deskripsi 2 baris) |

Kontrol:

| Kontrol | Ukuran / gaya (diukur) |
|---|---|
| Text | 420x25, radius 4, border `#3C3C3C`, bg `#313131` |
| Number | 200x25 sama gaya; fokus outline 1px `#0078D4` offset -1 |
| Select (`<select>` native) | 320x26, padding `2px 6px`, bg `#313131`, border `#3C3C3C`, radius 4; fokus outline 1px `#0078D4` offset -1; hover tak berubah warna, cursor pointer |
| Checkbox | 18x18, bg `#313131`, border 1px `#3C3C3C`, radius 3, margin-right 9, ikon centang codicon 16; hover/fokus tidak mengubah gaya kotak (fokus ditandai pada baris `focused.selected`) |

**KOREKSI vs plan:** checkbox 18x18 (plan 16x16), input 25px radius 4 (plan 24, radius 2), tombol 26px radius 4.

## 5. Form controls lain

| Kontrol | Nilai (diukur) |
|---|---|
| Tombol primer (Explorer) | 259x26, padding `4px 8px`, 12px/16, bg `#0078D4`, hover `#026EC1` (transisi tak terbaca), fokus outline 1px `#0078D4` offset 2px, border 1px `rgba(255,255,255,.1)`, radius 4, teks tengah |
| Badge hitungan ("2 unsaved") | 17 tinggi, padding `2px 4px`, margin-left 6, 11px, bg `#616161`, fg `#F8F8F8`, radius 2 |
| Badge activity bar | 16 tinggi, min-width 16 (konten 8), padding `0 4px`, 9px/600, bg `#0078D4`, fg `#FFF`, radius 20 |
| Link | warna `#4DAAFC` (textLink-foreground); `monaco-link` banner 12px/26, padding 3 |
| Progress bar | tinggi 2px, lebar 100%, bg `#0078D4`, display none saat idle (diukur); animasi aktif tidak ditangkap |
| Focus ring | 1px `#0078D4`: input/select offset -1; tombol offset 1-2 (primer fokus) |
| Tab editor | tinggi 35, aktif bg `#1F1F1F` fg `#FFF`; tidak aktif bg `#181818` fg `#9D9D9D`; border kanan 1px `#2B2B2B`; tombol close 20x20 (ikon 16 padding 2 radius 6) |
| Checkbox Welcome | 18x18 sama gaya, gap label 8 |

## 6. Find widget (Cmd+F)

| Elemen | Nilai (diukur) |
|---|---|
| Widget | 419x33 di kanan atas editor (x=963,y=100; offset atas margin-top 4, kanan ~0), bg `#202020`, border 1px `#313131`, radius 8, shadow `0 0 12px rgba(0,0,0,.14)`, z 35, transisi `transform .2s linear` |
| Padding | `0 4px 0 9px` |
| Input box | 216x25, radius 4, border `#3C3C3C`, fokus outline 1px `#0078D4` |
| Toggle (Aa/ab/.*) | 20x20, padding 1, margin-left 2, radius 3, border 1px transparan |
| Counter | 69x25, "1 of 1" 12px/lh 23, margin-left 3 |
| Tombol nav & close | 22x22 (ikon 16 padding 3), radius 4-5 |
| Expand (replace) | 18x23, margin `4px 0 4px 5px`, radius 4 |
| Sash kiri | 2px lebar, `rgba(204,204,204,.2)` |

## 7. Notifikasi, tooltip, scrollbar

| Elemen | Nilai (diukur) |
|---|---|
| Notification center | 450x35 (kosong "No New Notifications"), kanan 8px dari tepi, border 1px `#313131`, radius 8, shadow `0 0 12px rgba(0,0,0,.14)`, z 2545 |
| Header center | tinggi 35, padding `0 2px 0 8px`, bg `#1F1F1F`, judul 12px/600 `text-transform: capitalize`, aksi clear-all 22x22 (disabled `rgba(204,204,204,.5)`) |
| Toast | **tidak berhasil dipicu** (tak ada perintah yang memunculkan toast di vscode.dev tanpa login/ekstensi); lebar 450 center; plan 400 = KOREKSI (perkiraan, belum diukur) |
| Tooltip (hover compact) | tinggi 25, padding konten `2px 8px`, font 12px/19, bg `#202020`, border 1px `rgba(204,204,204,.2)`, radius 3 (compact; hover biasa 8), shadow `0 0 12px rgba(0,0,0,.14)`, z 40, animasi `fadein .1s linear`; dengan pointer panah; isi "Search (⇧⌘F)" |
| Delay tooltip | dingin: ~1500 ms (`workbench.hover.delay` default; ukur polling termasuk overhead RPC, perkiraan) ; hangat (pindah antar ikon): 23 ms; hilang setelah mouse leave: ~190 ms |
| Scrollbar sidebar/panel/list | lebar 8, slider `rgba(121,121,121,.4)`, radius 4, hover `rgba(100,100,100,.7)`, aktif `rgba(191,191,191,.4)` |
| Scrollbar editor | lebar 14 (vertikal), horizontal 12; radius 4 (sisi kiri saja `4 0 0 4` di editor modified) |
| Scrollbar auto-hide | kelas `invisible fade`, opacity 0 saat idle |

**KOREKSI vs plan:** scrollbar 8px di view (plan 14/10), 14 hanya di editor; notifikasi 450 (plan 400, center terukur).

## 8. Welcome page

| Elemen | Nilai (diukur) |
|---|---|
| Container | 1082x387, tinggi-constrained |
| h1 | 26px/600; h2 18px/600 margin-bottom 5 |
| Link mulai ("New File...") | 13px/lh 24, warna `#4DAAFC`, tinggi 27, margin 2 |
| Kartu kategori | padding `4px 4px 4px 6px`, margin `8px 8px 8px 0`, bg `#2B2B2B`, radius 6, tinggi 54 |
| Show on startup | gap 8, padding 4, checkbox 18x18 |

## Pola interaksi

- Keyboard: palette/quick open terbuka dengan Cmd+Shift+P / Cmd+P, input langsung fokus (ring biru 1px), Up/Down pindah baris, Enter eksekusi **baris pertama langsung** (hati-hati: Enter di hasil filter menjalankan perintah), Escape menutup; Cmd+, Settings, Cmd+F find.
- Item order dialog macOS: tombol destruktif, Cancel, primer paling kanan; primer berfokus awal.
- Fokus: cincin 1px `#0078D4` (`focusBorder`); input/select offset -1, tombol offset 1-2.
- Menu: hover == fokus (bg `#2A2D2E`); submenu buka tanpa delay perceptibel (<~900ms diuji), tertutup oleh Escape; item disabled tak bisa hover.
- Settings: kiri TOC, kanan daftar; gear muncul hanya saat hover (opacity 0 -> 1, 0.3s).
- Tooltip: delay awal ~1.5 s, antar ikon instan.
- Animasi: hover fade-in `.1s linear`, find slide `.2s linear`, item menu `transform .05s`, scrollbar fade `.8s linear`, settings gear `opacity .3s`.
- Microcopy: "Do you want to save the changes you made to X?" / "Your changes will be lost if you don't save them." / "No New Notifications" / "No matching commands".

## Hal yang tak bisa diukur

- Toast notifikasi (tak terpicu), animasi progress aktif, quick pick dengan `detail` berkonten dan multi-select berkotak centang (tidak ditemukan di vscode.dev tanpa folder/ekstensi), dropdown select terbuka (native `<select>`, popup OS), tooltip dengan teks panjang, state disabled pada tombol primer, transition tombol (tak terbaca stabil), animasi buka quick input.
- Profil browser dipakai bersama worker lain: layout/UI mode berubah di tengah sesi (modern -> klasik); angka klasik dominan, modern dicatat di §0.
