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

## Verifikasi Chromium nyata

`src/server/browser/browserHost.tabs.real.bun.test.ts` (+ `browserHost.tabs.real.testkit.ts`) menjalankan `BrowserHost` nyata di
atas Chrome headless (pool produksi, proxy SSRF produksi, penjaga navigasi produksi dengan allowlist `127.0.0.1:<port acak>`
saja; loopback tidak dilonggarkan) dan server HTTP lokal. Didaftarkan hanya bila ada Chromium; berjalan di gelombang
`*.real.bun.test.ts` `test:bun`. Hasil (3 run berturut-turut, semua 11 tes hijau, tanpa proses/dir temp tersisa):

| Butir | Hasil |
|---|---|
| (a) klik `window.open` = TAB baru di node yang sama; `window.opener` popup hidup | lulus |
| (b) popup instan `postMessage` + `window.close()`: judul opener `GOT:token-123`, tanpa tab/notice sisa | lulus (setelah perbaikan 2) |
| (b2) popup yang sempat diadopsi lalu menutup dirinya: tab hilang, view kembali ke opener, node tidak crash | GAGAL sebelum perbaikan 1, lulus sesudahnya |
| (c) `target=_blank` = tab baru | lulus |
| (d) popup ke-9 ditolak, notice, URL dibuka di tab pembuka | lulus |
| (e) banjir popup > `POPUP_BURST_MAX` ditolak | lulus |
| (f) screencast mengalir sebelum, di popup, dan sesudah kembali | lulus |
| (g) tab latar dibuang lalu dibangunkan, URL dimuat ulang | lulus |
| (g2) opener dengan popup hidup tidak dibuang | lulus (setelah perbaikan 3) |
| (h) tanpa proses Chromium dan dir data sementara | lulus |

Temuan dan perbaikan (akar, bukan gejala):

1. **Popup yang menutup dirinya mematikan node.** `Target.targetDestroyed`/`detachedFromTarget` pada target view dianggap
   hilangnya halaman node (`crash`), dan pada tab latar hanya menandai `crashed`; padahal `window.close()` pada popup adalah
   penutupan tab. Sekarang, bila node punya tab lain, kedua event itu menghapus tab (tanpa masuk "baru ditutup") dan view
   kembali ke tab pembuka (bukan tetangga kanan, mengikuti Chrome; OAuth butuh pembuka di layar). Node dengan satu tab
   tetap `crash` seperti sebelumnya; `targetCrashed` tetap menandai tab `crashed`.
2. **Popup yang tutup sebelum sempat di-attach** (OAuth instan) menghasilkan notice "A popup could not be opened as a tab"
   padahal tugasnya selesai; "No target with given id" kini dicatat info saja, tanpa notice.
3. **Pembuka dibuang saat popup hidup.** Tab latar dibuang setelah jeda diam (default 5 menit), dan itu memutus `window.opener`
   popup yang masih terbuka (2FA lama). Tab yang punya popup hidup tidak dibuang.

`window.opener` bertahan tanpa perubahan desain: halaman popup diadopsi (target asli Chromium dipertahankan), bukan dibuat
ulang. Tes regresi fake-CDP ada di `browserHost.tabs.test.ts`. Belum terverifikasi: Chrome headful (bukan headless),
Linux/Windows, dan klik manusia nyata lewat `Input.dispatchMouseEvent` (klik di tes memakai `element.click()` dengan
`userGesture`).

## Agent (P3)
Code: `browser.agentTabs.verbs.ts` (`withTabs`: verbs `tabs`/`tab`, `--tab`, `stale_tab_ref`, snapshot header), `src/shared/browser.agentTabs.ts`
(compact tab view), `central/tools/defs/browser.tab.ts`, registry capability `web.tabs` (`agentCapabilities.data.ts`).

- **Verbs.** `webterm browser tabs` (read: id, title, host, `active` = the human's tab, `agent` = the agent's working tab, `opener`,
  `state` ready/loading/discarded/crashed; never a full URL), `tab new [url]`, `tab switch <id>`, `tab close <id>` (act: they take the
  lease like any act verb). Every page verb (`status snapshot screenshot wait console navigate click type press scroll`) takes `--tab <id>`.
  Control route: `tabs` = `browser.read`, `tab` = `browser.act` (`BROWSER_VERB_CAP`).
- **`--tab` is sticky.** It selects the tab (moves `agentTabId` through `tabApi.activate(by:'agent')`) and then runs the verb on it, so the
  next verb without `--tab` is in the same tab. Chosen over "act there once and come back": coming back would move the human's view too
  while "follow agent" is on. The human's tab moves only by the server's follow rule, never by `--tab` alone.
- **Click that opens a tab.** The server already moves `agentTabId`; the result carries `newTab` and a `note` ("Opened a new tab t3: <title>;
  you are now on it."), so the model reads the new page with the next `snapshot`.
- **Refs belong to a tab.** Each snapshot remembers the tab it was taken in (answer field `tab`). A `click/type/wait` whose snapshot came from
  another tab is refused with `stale_tab_ref` (409) and `next: "snapshot tab <current> first, ..."`. The ref format is unchanged (`e12`).
- **Header.** For a node with 2+ tabs the snapshot's first line is `Tabs (n): t1 "Title" | t3 "Title" <- you`. It sits INSIDE the untrusted
  block (titles are page text) and look-alike markers are neutralised.
- **Refusals are never dead ends.** Every tab refusal carries `next`: `tab_limit` (409, "close a tab first (tab close <id>), or work in another
  browser node"), `unknown_tab` (404, "list the tab ids with the tabs verb"), `stale_tab_ref`. Wire shape `{error, message, next}` (`AgentTabError`).
  A new URL goes through the same navigation/SSRF guard as `navigate` (`403 blocked`).
- **Locked preset.** The skill-author preset keeps its whitelist `open|navigate|snapshot`; `tabs`, `tab` and any body carrying `tab` are 403
  `verb_not_allowed_for_preset` (it has one page and no reason to juggle tabs).
- **Central.** New tool `browser_tab` (R1: list/new/switch/close, no approval card), chosen over widening `browser_act` because list/new/close
  are not page actions and the `browser_act` shape check is strict per action. `browser_act` and `browser_read` take an optional `tab`;
  `browser_act` answers `newTab` and `note`; `browser_status` lists `tabs` per browser that has more than one.
- **One source of words (anti-forgetting).** Capability `web.tabs` lives once in `agentCapabilities.data.ts`: granted to `central.steward` and
  `chat.default`, denied for both author profiles (their CANNOT list says "Use browser tabs ..."). The steward prompt, the plain chat briefing,
  the UI line and the "Capabilities updated" note are all rendered from it; the Capability map goal and the off-switch (`browser_tab` off ->
  `web.tabs` off) follow the tool catalog. Nothing hand-writes "you can/cannot use tabs".
- **Sessions already running.** The briefing text changed, so `capabilityHash` changed: the existing `Capabilities updated` note reaches a chat
  that last saw the old hash (test: `agentChat.capabilities.bun.test.ts`, a node recorded with a pre-tabs hash). The Claude Code skill
  `webterm-browser` is rewritten on boot.
- **Not done here.** Split pane (P4) and QC sync/compare (P5).
- **Verified only with a fake CDP:** popup adoption, `agentTabId` moves, discard/wake of background tabs. The real-model smoke
  (`docs/smoke-capabilities.md`, cases `tab-open`, `tab-multi`, `tab-denied`) covers the end to end path with a real Chromium.

## A node that cannot operate (2026-11-18)

Owner report: a new browser opened with a profile showed the start page, a tab "New tab" with the agent robot, an address bar
holding a URL the page never loaded, and nothing responded; older browsers were fine.

Root causes (each proven by a test that failed before the fix):

1. **The MAX_LIVE gate refused the node without any state.** `BrowserLifecycle.admit` returned false, `attach` threw
   `BlockedError('max_live')`, and the gateway sent it as the generic `{t:'error', code:'blocked'}` ("This address is blocked.",
   non-sticky: gone after 4 s). The node never got a `state` or a `tabs` message, so the client stayed on its stand-in tab and
   start page, and every `nav`/click went to a node the server did not have. Nothing was logged either (no `browser.launch`).
   Now: its own wire code `max_live` (sticky), a log line `browser.attach_refused {reason:'max_live', live, maxLive}`, and a
   plate in the page area ("Browser paused: the limit of N active browsers is reached") with **Hide another browser…** (collapses
   the chosen browser; collapsed = hidden = evictable) and **Try again**. The gateway keeps the refused attach in `waiting` and
   retries it when `BrowserLifecycle.onCapacity` fires (a node was forgotten or hidden), so the node wakes by itself through the
   same `lifecycle.attach` gate; there is no second gate. While paused, `nav` from the toolbar is not sent and a warning explains why.
2. **The stand-in tab claimed to be the agent's.** `useBrowserTabs` built its stand-in with `agentTabId = tabId`, which the strip
   draws as the robot. A node nothing is attached to has no agent in it: `agentTabId` is now `null` there.
3. **A launch failure only said `launch_failed`.** The cause is now classified once (`launchReason`: `profile_locked`,
   `bin_not_found`, `spawn_error`, `debug_port_timeout`, `crashed_on_start`, `sandbox_unavailable`, `connect_failed`), logged in
   `browser.launch_failed` as `reason` (+ `detail`, our own LaunchError text, never a raw error that may hold paths) together with
   node and profile, sent as `error.reason`, and shown on the existing plate. Try again relaunches through `acquire`, which
   already reclaims a leftover Chromium of this server (`reclaimProfile`); there is no separate "Reclaim profile" button because it
   would do exactly what Try again does.

Not verified without a real browser: how the plate looks in both themes, the collapse animation of the hidden node, and the real
timing of the wake after hiding.


## Menyusul
P1-P3 (server, integrasi `BrowserNode`, verb agent) sudah ada. P4 split pane sudah ada: lihat `browser-split.md` (screencast
kini untuk semua tab yang tampil di pane, bukan hanya tab aktif; layout dan device per tab ikut daftar tab yang dipersist).
P5 QC (sinkron, bandingkan) dan verb agent `layout` belum.
Belum diverifikasi tanpa browser: tampilan nyata strip, perilaku overflow dan drag dengan layout sungguhan, kontras
warna di tema terang/gelap/kontras tinggi.
