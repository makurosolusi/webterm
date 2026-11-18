# Browser tabs: keputusan (tahap kontrak + komponen)

Satu node `browser` = satu jendela Chromium berisi banyak tab. Dokumen ini mencatat *kenapa*; spesifikasi lengkap
ada di spec induk (P1-P5). Tahap ini hanya menyediakan kontrak (`src/shared/browser.tabs.ts`) dan komponen UI yang
berdiri sendiri (`src/client/browserTabs/`). Belum ada integrasi ke `BrowserNode` dan belum ada perubahan server.

## Kenapa tab di dalam node, bukan node per halaman
- Satu tugas web sering melintasi beberapa halaman (login, tautan baru, OAuth). Satu node per halaman memenuhi
  canvas dan memecah sesi; satu node berisi tab menjaga satu profil, satu cookie jar, satu proses.
- Pola yang sudah dikenal (Chrome, Edge, editor tabs VS Code, Arc) berarti tidak ada yang perlu dipelajari.
- Batas **8 tab per node** (`MAX_TABS_PER_NODE`): tiap tab hidup menambah memori Chromium; di atas itu pengguna
  seharusnya membuka node lain. Penuh = tombol `+` nonaktif dengan alasan terlihat ("Tab limit (8) reached") dan
  lencana `8/8`; pintasan dan menu memberi alasan yang sama lewat `onNotice`, bukan diam.

## Aturan popup -> tab
`window.open`, `target=_blank` dan OAuth popup menjadi tab baru di node pembukanya (bukan node baru) sampai batas
8. Penuh: popup ditolak dengan notifikasi dan tautan dibuka di tab pembuka, supaya tidak hilang diam-diam.
Server (P1) yang menerapkan aturan ini; kontrak membawa `openerTabId` agar UI dan agent tahu asal tab.

## Dua kursor: manusia dan agent
`activeTabId` milik manusia, `agentTabId` milik agent; keduanya terpisah. Agent bekerja di tab latar tanpa
mengganggu tab yang sedang dilihat manusia. Event `tabActivated` membawa `by: 'human' | 'agent'` dan hanya
menggerakkan kursor yang disebut. Strip menandai `agentTabId` dengan ikon bot kecil (juga masuk nama aksesibel).
Perilaku "UI ikut agent" adalah keputusan induk (P3), bukan komponen ini.

## Kontrak murni, id dari pemanggil
`reduceTabs(state, action)` murni dan dipakai klien (optimistik) dan nanti server. Id tab baru dikirim pemanggil
(`newTabId`), supaya reducer tetap deterministik dan mudah diuji. Penutupan mengikuti Chrome: tab aktif pindah ke
tetangga kanan, lalu kiri. Menutup tab terakhir menghasilkan `tabs: []` dan kursor `null` (node menampilkan halaman
tab baru, node tidak hilang). Riwayat tertutup maksimal 10 (`closed`, terbaru dulu) untuk Ctrl+Shift+T.
`popOut` mengeluarkan tab dari node tanpa masuk riwayat (tab itu pindah, bukan ditutup).
Deviasi dari spesifikasi: aksi `closeOthers`, `closeToRight`, `reload` ditambahkan (menu konteks memerlukannya);
`reload` tidak mengubah state. Salin URL ditangani strip sendiri lewat clipboard dan melapor lewat `onNotice`.

## Komponen
- `BrowserTabStrip`: terkontrol penuh (state masuk, `onAction` keluar), tanpa fetch/WS. WAI-ARIA tabs: aktivasi
  manual seperti VS Code (panah/Home/End memindah fokus, Enter/Space mengaktifkan), roving tabindex, Delete atau
  Ctrl/Cmd+W menutup, Alt+Shift+panah mengurutkan (alternatif keyboard untuk seret). Lebar tab 96-220px; lewat
  itu strip menggulung dengan chevron dan menu All tabs. Menu memakai `VscodeMenu` yang sudah ada (bukan
  dependensi baru; repo tidak punya DropdownMenu shadcn).
- `useBrowserTabShortcuts`: dengar di container node pada fase capture (Chromium tidak pernah melihat chord ini
  lewat CDP; pola yang sama dengan `browserChord` di `BrowserNode`). Tidak menangkap di xterm atau input teks lain;
  kolom alamat browser (`data-browser-omnibox`) dikecualikan dari larangan itu. Ctrl/Cmd+W pada tab yang fokus
  diserahkan ke strip (menutup tab itu, bukan tab aktif).
- `BrowserNewTabPage`, `BrowserTabStates`: halaman tab baru, crashed (Reload), galat navigasi/offline (Retry),
  discarded (spinner, memicu `onWake` sekali).
- Gaya: hanya token tema `--vscode-*` dengan fallback token app; reduced-motion mematikan transisi dan scroll halus
  dan mengganti putaran spinner dengan pudar lembut.

## Rujukan pola
WAI-ARIA Authoring Practices "Tabs" (manual activation); Chrome (ukuran tab, tetangga kanan lalu kiri, tab
terakhir, Ctrl+Shift+T, middle-click); VS Code editor tabs (aktivasi manual, ikon tutup, tooltip).

## Menyusul
P1 server (model tab, popup -> tab, screencast hanya tab aktif, persistensi); P2b integrasi ke `BrowserNode`
setelah profil ter-merge; P3 agent (verb `tabs`/`tab`, `--tab`, `newTab`); P4 split pane; P5 QC (sinkron, bandingkan).
Belum diverifikasi tanpa browser: tampilan nyata strip, perilaku overflow dan drag dengan layout sungguhan, kontras
warna di tema terang/gelap/kontras tinggi.
