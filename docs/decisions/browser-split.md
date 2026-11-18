# Browser split: keputusan (P4)

Satu node `browser` bisa menampilkan beberapa tab sekaligus dalam pane yang dibelah (maks 4), seperti split pane terminal
dan editor group VS Code. Dokumen ini mencatat *kenapa*; konteks tab ada di `browser-tabs.md`. Sinkron antar pane dan
compare overlay (P5) dan verb agent `layout` belum dikerjakan; agent tetap mengalamatkan TAB, bukan pane.

## Kenapa
QC perlu melihat beberapa halaman sekaligus dan membandingkannya (ukuran berbeda, halaman berbeda) tanpa klik bolak-balik
antar tab. Pola yang sudah dikenal: editor group VS Code (seret tab ke tepi), DevTools device toolbar dan Responsively
(banyak viewport berdampingan).

## Model: pohon pane yang dipakai ulang
- Layout = `Pane` yang sama dengan terminal (`src/shared/workspace.shape.ts`: `PaneLeaf {id}` | `PaneSplit {dir h|v, ratio, a, b}`),
  tetapi `id` daun = **tabId**. Geometri dan separator memakai ulang `src/client/paneTree.ts` (`paneLayout`, `ratioFromPointer`,
  `boxRect`); pane dirender sebagai daftar rata ber-key tabId, jadi membelah hanya mengubah `style` dan canvas pane lain tidak dibuang.
- Reducer murni di `src/shared/browser.layout.ts` (`splitPane`, `closePane`, `assignTab`, `resizePane`, `swapPanes`,
  `focusPane`, `layoutAfterClose`, `validLayout`). Dipakai klien (optimistik) dan server (validasi, tab ditutup).
- Aturan: tiap daun satu tab; satu tab maksimal di satu pane; tab yang tak tampil tetap di strip; maks `MAX_PANES = 4`
  (alasan terlihat "Pane limit (4) reached"); pane terakhir tak pernah hilang; satu pane = **tanpa layout** (tidak disimpan).
- **Fokus pane = `activeTabId`.** Tidak ada kursor fokus kedua: pane fokus selalu tab aktif manusia. Mengaktifkan tab yang
  tak tampil menggantikan tab di pane fokus (`reduceTabs` 'activate' dan `followFocus` di server). Menutup tab yang tampil:
  pane menampilkan tab tak-tampil terdekat (kanan, lalu kiri) atau runtuh (`layoutAfterClose`).
- Persistensi: `layout` opsional di `PersistedTabs` dan `device` opsional di `PersistedTab`, lewat jalur `canvas.update` yang
  sama dengan daftar tab (debounce host). Tidak menyentuh `db.ts`. `validPersistedTabs` membuang daun yang tab-nya sudah tak
  ada; node lama (tanpa field) = satu pane, tidak berubah.

## Streaming multi-tab
- Sebelumnya hanya tab aktif yang di-screencast lewat `rec.cast`. Sekarang klien mengirim `{t:'view', visible:[tabId], focus}`
  (parser ketat, maks 4 id). Tab **fokus** tetap lewat `rec.cast` (fps penuh). Tiap tab terlihat lain mendapat screencast sendiri
  ("side cast") pada sesinya, dengan `everyNthFrame = SIDE_EVERY_NTH` (12, sekitar 5 fps) dan, saat lebih dari 2 pane, ukuran
  frame x `CROWDED_SCALE` (0.6). Tab yang tak tampil: screencast berhenti (perilaku lama).
- Frame membawa tabId: id frame biner menjadi `nodeId` + `\u001f` + `tabId` (klien lama tanpa split melihat id polos).
  Nomor `seq` satu ruang per node, jadi gerbang kirim/ack per (klien,node) tidak berubah; frame tertunda disimpan per tab
  supaya satu pane tak menimpa pane lain. Ack frame side dikirim ke sesi tab itu.
- Input membawa `tab` opsional; input ke tab non-fokus langsung ke halamannya (tidak membangunkan halaman, tidak lewat
  antrean node). Verb agent tetap pada `agentTabId` (tidak berubah).
- Penanganan: tab crash tidak dibangun ulang diam-diam (menunggu Reload); tab discard yang terlihat dibangunkan server saat
  `view` tiba dan tidak di-discard selama tampil; viewer terakhir pergi = semua screencast berhenti.
- **Beban:** `MAX_LIVE` tetap menghitung node, bukan pane. Node 4 pane men-stream empat halaman sekaligus; pengaman: fps
  rendah pane tak fokus dan skala frame saat ramai. Bila nanti terasa berat, ukur dulu sebelum menurunkan batas.
- Beberapa viewer pada satu node: pesan `view` terakhir menang (layout sama di semua jendela, jadi biasanya identik).

## Viewport dan device per tab
- Tiap pane melaporkan ukurannya (`resize` dengan `tab`); halaman dirender sebesar pane (`Emulation.setDeviceMetricsOverride`
  per sesi) dan frame sebesar itu. `device` per tab (`POST /api/browser/:nodeId/tabs/:tabId/device` dengan `{preset}`,
  `{preset:null}` atau `{w,h,dpr?}`) menang atas ukuran pane dan atas mode device lama node. Ganti identitas (UA/mobile/touch)
  memuat ulang halaman itu saja, seperti mode device node.
- Preset cepat di header pane: Mobile 390 (custom 390x844), Tablet 768 (iPad Mini), Laptop 1280 (custom), Desktop 1920 (preset).
  "Open this page in 3 sizes" = Mobile / Tablet / Desktop pada URL yang sama dalam 3 pane.
- Mode device lama per node tetap bekerja untuk pane tunggal; di split ia menjadi default bagi tab tanpa device sendiri.
  Ukuran node (`resize` tanpa `tab`) tidak lagi menimpa tab yang punya ukuran pane sendiri; saat unsplit ukuran pane dilupakan
  dan halaman mengikuti node lagi.

## UI
- Tombol "Split" di strip node (Split right/down, 2 columns, 2 rows, 2x2, Open this page in 3 sizes, Unsplit) dan menu konteks
  tab (Split right/down); seret tab dari strip ke tepi pane (seperempat luar = split di sisi itu, tengah = tampil di pane itu,
  pratinjau overlay) atau seret header pane ke pane lain untuk menukar. Header pane: judul (klik = pilih tab lain), ukuran
  halaman, menu device, Close pane.
- Separator: `role=separator`, `aria-orientation`, `aria-valuenow` (min 10, maks 90), seret pointer, panah (2%), Shift+panah (10%),
  Home/End, Enter atau dobel-klik reset 50/50; tidak pernah di bawah `MIN_PANE_PX = 160` px per sisi.
- Pintasan (hanya fokus di dalam node, tidak di terminal/editor teks): Ctrl/Cmd+\ split kanan, Ctrl/Cmd+Alt+panah pindah
  fokus pane, Ctrl/Cmd+W menutup tab fokus (pintasan tab yang sudah ada).
- Node terlalu kecil: opsi split nonaktif dengan alasan "Enlarge the node to split"; pane yang sudah ada menyusut dan muncul
  "Enlarge the node to see every pane". Reduced-motion: transisi pratinjau hanya bila tidak diminta mengurangi gerakan.

## Kompatibilitas
- Board lama (tanpa `layout`/`device`) = satu pane, perilaku sama; frame tanpa `tabId`; klien tanpa split tak terpengaruh.
- Pesan klien baru ditolak sebagai `bad_request` oleh server lama (dan sebaliknya server baru menerima klien lama).

## Belum diverifikasi tanpa browser UI
Tampilan nyata pane (garis fokus 2px, header, indikator ukuran, letterbox device), drag/drop zona tab ke pane dengan layout
sungguhan, separator di bawah pointer asli, kontras tema terang/gelap/kontras tinggi, perilaku di fullscreen node, dan
kinerja stream 4 pane di mesin lemah. Tes jsdom membuktikan pengkabelan dan keputusan; tes nyata Chromium
(`browserHost.split.real.bun.test.ts`) membuktikan stream dua tab, device per tab (`innerWidth` halaman), input per pane, dan
tidak ada proses sisa.

## Menyusul (P5)
Mode sinkron (navigasi/scroll/klik/ketik tercermin ke semua pane), verb agent `layout get|set` dan `--all`, compare overlay
(slider swipe dan selisih piksel).
