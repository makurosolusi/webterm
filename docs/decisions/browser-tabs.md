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

## Server (P1)
Code: `src/server/browser/browserHost.tabs*.ts` (model + CDP effects), `browser.runtime.tabs.ts` (API service, pop-out,
board save), `browserApi.tabs.ts` (routes), `browser.agentTabs.ts` (agent routing), contract additions in
`src/shared/browser.tabs.ts` (`PersistedTabs`, `validPersistedTabs`, events `tabMoved`, `remember`, `reopenedFrom`).

- **View slot.** `rec.targetId/sessionId` always belong to the human's active tab and are the only page that streams. Other
  live tabs are background targets (`TargetTable.bg*`). Activating a tab swaps the slot: `stopScreencast` on the old page,
  `startScreencast` on the new one. Each tab is its own offscreen Chromium window (CDP cannot put a target into another
  window); the node still shows one stream.
- **Popup -> tab.** The popup page is attached (adopted), not closed and recreated, so `window.opener`/`postMessage` OAuth
  keep working. It is placed after its opener tab. Shields (filter + burst cap) and the navigation guard run first; a blocked
  popup is closed with a `tabNotice`. At 8 tabs the popup is closed, its URL loads in the opener tab and the notice
  "Tab limit (8) reached; ..." is sent. Deviation: CDP has no user-gesture flag, so "from the human's visible tab" stands in
  for a gesture (it becomes the view); from the agent's tab while the agent holds the lease it moves the agent cursor.
- **Cursors.** `activate(by:'human')` moves the view and turns "follow agent" off for the session. A tab an agent action
  opens moves `agentTabId`, and the view too only while follow is on (decision: follow until the human picks a tab; no 5 s timer).
- **Discard.** A background tab idle for the node's discard delay (`WEBTERM_BROWSER_DISCARD_MS`) is closed in Chromium but
  stays listed (`discarded`); the active tab, loading tabs and the agent's tab while the agent drives are skipped. Waking
  rebuilds the page at its URL. Node-level discard/MAX_LIVE is unchanged and counts nodes (pages of one node share a slot);
  a crashed background tab is only marked `crashed`.
- **Persistence.** `WsNode.tabs` (`PersistedTabs`: url, title, http favicon URL, order, both cursors), written debounced
  (1.5 s) through `canvas.update` (no new SQL in db.ts). On open, the active tab loads and the rest are `discarded`; a node
  without `tabs` is one tab. Closed history is runtime only.
- **Pop-out.** Adds a browser node beside the source on the same profile with the tab URL, opens it through the MAX_LIVE gate
  first (full gate = nothing changes), then removes the tab without remembering it. A live page cannot move between windows
  over CDP, so scroll/form state is not carried.
- **Agent.** Verbs run on `agentTabId` (`agentTabHost`); one-tab nodes are unchanged. `click` returns `newTab` when it opened one.

### Endpoints (`/api/browser/:nodeId/tabs`, same auth as other browser routes; every answer is `{ state, tab?, newNodeId? }`)
`GET` list - `POST` {url?, afterTabId?} - `POST /:tabId/activate` - `DELETE /:tabId` - `POST /:tabId/move` {toIndex} -
`POST /:tabId/duplicate` - `POST /:tabId/pop-out` - `POST /reopen`. Errors: 400 bad id/url, 403 blocked (SSRF), 404, 409 `tab_limit` or `max_live`.
WS (`/ws/browser`): `{t:'tabs', id, state}` on attach, `{t:'tab', id, event}` (fold with `applyTabEvent`), `{t:'tabNotice', id, message}`.
The old `{t:'popup'}` is no longer sent.

Not verified without a real Chromium: that an adopted popup keeps `window.opener` live, real OAuth round trips, and that
screencast resumes on a swapped page.

## Integrasi di node (P2b)
Code: `src/client/browserTabs/useBrowserTabs.ts` (state + aksi), `browserTabs.api.ts` (REST), `BrowserTabPanel.tsx`
(halaman tab baru / crashed / discarded), dipasang di `BrowserNode.tsx`; tes: `BrowserNode.tabs.test.tsx`.

- **Letak.** Strip tepat di bawah baris judul/profil node dan di atas toolbar URL; area halaman = `role=tabpanel`
  (`aria-labelledby` = tab aktif, tab `aria-controls` = panel). Pintasan dipasang di body node (fase capture), jadi
  hanya hidup saat fokus ada di node; xterm dan input teks lain di dalam node dikecualikan. Textarea penyerap
  keyboard permukaan halaman diberi `data-tab-shortcuts` supaya Ctrl/Cmd+T/W/1-8 tetap sampai dari halaman.
- **Omnibox = tab aktif.** Server menayangkan dan menavigasi hanya tab aktif (slot tampilan), jadi `nav` WS yang sudah ada
  (go/back/forward/reload/stop) otomatis mengenai tab aktif; tidak ada endpoint navigasi per tab. Judul/URL/favicon node
  mengikuti state sesi yang sama.
- **Optimistic vs tunggu server.** activate/close/move/pop-out/close-others/close-to-right diterapkan lokal lewat
  `reduceTabs` lalu dikembalikan (rollback + toast) bila REST gagal; respons selalu menggantikan state. new/duplicate/reopen
  menunggu server karena id tab dibuat server. Reload tab non-aktif = activate lalu `nav reload`.
- **Ikuti agent.** `tabActivated by:'agent'` menggeser tab aktif UI selama manusia belum memilih tab sendiri (server sudah
  memindahkan halaman yang di-stream pada mode ikuti); memilih tab = berhenti mengikuti selama node ini terpasang.
- **Pop-out.** Node baru ditambahkan server ke board (profil sama, di samping) dan tiba lewat dorongan `canvas.update`;
  klien hanya menghapus tab dan memberi toast. Tidak ada pembuatan node di klien. Penanganan `{t:'popup'}` lama dihapus.
- **Galat.** 409 `tab_limit` -> toast "Tab limit (8) reached" (tombol + sudah nonaktif dengan alasan), `max_live` -> toast
  "Too many browsers are active. Hide one first.", galat lain -> rollback + "Could not <aksi>: ...". Koneksi putus: state tab
  terakhir tetap, penanda "Reconnecting..." memakai overlay node yang sudah ada.
- **Node lama.** Sebelum server mengirim daftar tab (atau tanpa data) strip menampilkan satu tab dari judul halaman + `+`.
  Tab kosong pertama tetap memakai halaman awal node; halaman tab baru dipakai untuk tab kosong saat ada lebih dari satu tab
  atau riwayat tertutup. Galat navigasi tetap lewat overlay `BrowserNoticeAction` (tidak digandakan oleh komponen state tab).
- **Deviasi.** Riwayat tertutup dibuka via `POST /reopen` (terbaru); entri yang lebih lama dibuka sebagai tab baru di URL-nya.
  Belum diverifikasi tanpa browser nyata: tampilan strip di node, seret nyata, fokus/pintasan di Chromium sungguhan.

## Menyusul
P1 server (model tab, popup -> tab, screencast hanya tab aktif, persistensi); P2b integrasi ke `BrowserNode`
setelah profil ter-merge; P3 agent (verb `tabs`/`tab`, `--tab`, `newTab`); P4 split pane; P5 QC (sinkron, bandingkan).
Belum diverifikasi tanpa browser: tampilan nyata strip, perilaku overflow dan drag dengan layout sungguhan, kontras
warna di tema terang/gelap/kontras tinggi.
