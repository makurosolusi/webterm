# PLAN BROWSER-CANVAS (a) — Tujuan, arsitektur, keputusan produk, workstream

Seri: `-a` (ini: butir 1-3) · `-b` (kontrak + rencana test) · `-c` (keamanan, rollout, risiko) · `-d` (spec siap-tempel per WS).
Sumber: `RND/31..34-b`. Label: fakta = diverifikasi di kode worktree; `[BT]` = belum terverifikasi (butuh uji nyata, dilarang dijalankan penyusun rencana).

## 1. Tujuan, non-tujuan, keputusan arsitektur

**Tujuan.** Node `browser` di canvas webterm: browser sungguhan (login, video, SPA) yang (1) dipakai manusia langsung di node, (2) dikendalikan agent AI lewat endpoint kontrol terautentikasi, (3) mendukung login yang bertahan dan import cookie yang aman, (4) tidak membuka celah SSRF ke host server.

**Non-tujuan (MVP).** Audio; download/upload file; popup jadi node baru; ekstensi browser lokal (opsi D); Neko/WebRTC (opsi B); iframe proxy (opsi C, ditolak); shell Electron/Tauri (E); membaca store cookie browser harian user; `puppeteer-core`/`playwright-core` di dalam webterm; bundling Chromium.

**Keputusan arsitektur (satu rekomendasi).** Chromium terkelola SERVER-SIDE + CDP: screencast JPEG ke klien lewat WS biner TERPISAH `/ws/browser`, input manusia diteruskan sebagai event CDP, agent lewat `/api/control/browser/:nodeId/:verb` (capability `wcap_*`), semua di balik satu `BrowserHost`.

| Alasan | Detail |
|---|---|
| Cocok model web channel | webterm = server Bun + browser biasa (sering jarak jauh); `<webview>` Electron tidak ada. Satu port HTTP/WS ikut TLS proxy dan gate `allowed()` yang sudah ada |
| Nol dependency baru | klien CDP mentah ~60 baris di atas paket `ws` yang sudah dependency; Chromium dibawa user (`WEBTERM_BROWSER_BIN`) |
| Agent dapat kendali kuat | DOM/AX via CDP; manusia dan agent berbagi satu target lewat lease |
| Koordinat tahan zoom | rumus berbasis `getBoundingClientRect()` tanpa membaca nilai zoom React Flow |

| Alternatif | Ditolak karena |
|---|---|
| B noVNC/Neko/KasmVNC/Xpra | infrastruktur Docker/Xvfb, layanan kedua dengan auth sendiri, GPL (Kasm/Xpra), agent tetap butuh CDP (arsitektur ganda). Hanya fase opsional di balik antarmuka `BrowserHost` yang sama |
| C reverse proxy + iframe | rapuh, anti-bot/XFO, tanpa CDP agent buta, konten asing ber-origin webterm = XSS ke token/PTY |
| D ekstensi MV3 | pasang ekstensi, infobar debugger `[BT]`, hanya cermin tab user; fase 4 opsional |
| E Electron/Tauri | memutus model web channel; overlay native Tauri tak ikut `scale()` DOM |
| Port CDP mentah untuk agent | siapa pun di host/PTY lolos token; kendali penuh browser + cookie |
| puppeteer/playwright-core di server | dependency ~besar, tak perlu di jalur streaming; agent eksternal boleh membawa sendiri lewat verb kontrol |

## 2. Keputusan produk (butuh user; DEFAULT sudah dipilih, jangan menggantung)

| ID | Pertanyaan | DEFAULT rekomendasi | Alasan singkat |
|---|---|---|---|
| P-1 | Pendekatan streaming | Opsi A (CDP screencast), tanpa audio | lihat §1 |
| P-2 | Chromium: bundel atau deteksi? | Tidak dibundel. `WEBTERM_BROWSER_BIN` atau lokasi umum; absen = node menampilkan petunjuk pasang. Flag `WEBTERM_BROWSER` default OFF | hindari ~100 MB dan lisensi biner |
| P-3 | Cookie/login MVP | Login manual di node + profil persisten per workspace. Import file (`storageState`/`cookies.txt`) = fase terpisah di flag `WEBTERM_BROWSER_COOKIE_IMPORT` default OFF. DILARANG: baca store browser harian, attach ke Chrome harian | risiko terendah; ikut dok 33 |
| P-4 | Kendali agent | Default OFF per node (`agentControl`), toggle manual di node + env global `WEBTERM_BROWSER_AGENT` default OFF; lease dengan chip "agent mengemudi" + Stop/ambil alih | agent mengemudi browser berlogin = risiko tinggi |
| P-5 | Akses localhost/LAN (dev server user) | Blok semua privat/loopback/link-local/metadata. Pengecualian HANYA lewat `WEBTERM_BROWSER_ALLOW_HOSTS` (daftar `host:port`, default kosong). Port webterm sendiri (`PORT`) TIDAK PERNAH boleh masuk allowlist (hard-deny) | SSRF ke webterm = kendali PTY |
| P-6 | Batas resource | `WEBTERM_BROWSER_MAX_LIVE`=3; discard tersembunyi >5 menit (`WEBTERM_BROWSER_DISCARD_MS`=300000) | ikut nodeterm; memori per renderer 100-300 MB `[BT]` |
| P-7 | Isolasi profil | Satu profil persisten per workspace (`dataDir()/browser/profiles/<workspaceId>`), satu proses Chromium per profil. Mode ephemeral per node DITUNDA | kunci `SingletonLock`; sederhana |
| P-8 | Popup / `window.open` | Navigasi di tempat (node yang sama). Node baru ditunda | tak ada hang |
| P-9 | Download & file chooser | Ditolak (`Browser.setDownloadBehavior` deny; chooser tidak dicegat) di MVP; pesan jelas | permukaan serangan kecil dulu |
| P-10 | Konsekuensial oleh agent (kirim form lintas-domain, bayar, kirim pesan) | Verb `click`/`type` pada elemen `submit` lintas-origin butuh persetujuan manusia lewat gerbang `approval*` yang ada, bila central/approval aktif; bila tidak ada, ditolak default | prompt injection |
| P-11 | TTL cookie vault | 7 hari (`WEBTERM_BROWSER_COOKIE_TTL_DAYS`), scope workspace | ikut dok 33 |
| P-12 | Tool central agent | Ditunda sampai `ca2` mendarat di main (WS-10, W5). R0 = status/daftar domain terautentikasi; R2 = aksi | bergantung registry yang belum di main |
| P-13 | Siapa boleh mengendalikan | Hanya token root (manusia) dan capability `wcap_*` verb `browser.*`. Token node (`x-nodeterm-node-token`) TIDAK membuka `/api/browser/*` maupun `/ws/browser` | default-deny allowlist `isNodeTokenPath` |

## 3. Workstream

Integration branch: `feature/browser-int` (dari main). Tiap WS = branch `feature/<nama>` yang di-merge ke integration branch atas konfirmasi orkestrator; ke main hanya atas perintah user. Worker DILARANG commit/push; menjalankan Chromium nyata dilarang (Rule 1) — semua test memakai CDP tiruan.

Pemetaan titik panas: `workspace.ts`, `nodeTypes.tsx`, `nodeList.ts`, `store.ts`, `App.tsx`, `Dock`/`canvasMenu*`/`CanvasToolbar`, `api.ts`, `index.ts`, `upgradeRouting.ts`, `auth.ts`, `control/capabilities.ts`, `envRegistry*`, `CHANGELOG.md`, README, `package.json` = MILIK WS-11 saja (W4). WS lain TIDAK menyentuhnya; mereka mengekspor fungsi/komponen, WS-11 menyambung.

| WS | Nama / branch | Tujuan | Gel. | Bergantung |
|---|---|---|---|---|
| WS-00 | contract · `feature/browser-contract` | Tipe kontrak, encoder frame biner, fungsi murni (koordinat, URL, discard) | W0 | — |
| WS-01 | cdp-host · `feature/browser-cdp-host` | Klien CDP mentah, peluncur Chromium, `BrowserHost` (target, screencast, input) | W1 | 00 |
| WS-02 | ssrf-guard · `feature/browser-ssrf-guard` | Proxy penyaring SSRF + penjaga navigasi | W1 | 00 |
| WS-03 | cookie-vault · `feature/browser-cookie-vault` | Vault AES-GCM, parser import, redaksi, jalur profil | W1 | 00 |
| WS-04 | stream-gateway · `feature/browser-stream-gw` | Gateway `/ws/browser`, backpressure, penonton | W2 | 00, 01 |
| WS-05 | lifecycle · `feature/browser-lifecycle` | Hibernate 3 tingkat, batas live, timer discard | W2 | 00, 01 |
| WS-06 | client-node · `feature/browser-client-node` | `BrowserNode`, permukaan canvas, input, klien WS | W2 | 00 |
| WS-07 | lease-agent · `feature/browser-lease-agent` | Lease, verb agent, snapshot ber-ref, allowlist CDP, handler kontrol | W2 | 00, 01 |
| WS-08 | rest-cookie-api · `feature/browser-rest-api` | Handler `/api/browser/*` (status, lease, agent-control, cookie preview/commit/list/clear) | W3 | 00, 03, 07 |
| WS-09 | client-ux · `feature/browser-client-ux` | Chip lease, toolbar URL, dialog cookie, banner diblokir | W3 | 00, 06, 08 (kontrak) |
| WS-10 | agent-shim · `feature/browser-agent-shim` | Shim sh + SKILL.md untuk agent di terminal | W3 | 00, 07 |
| WS-11 | integrator · `feature/browser-integrate` | Sambung semua titik panas, env registry, docs, uji integrasi | W4 | semua W0-W3 |
| WS-12 | central-tools · `feature/browser-central-tools` | Tool browser untuk central agent | W5 (kondisional) | 11 + `ca2` di main |

Gelombang: W0 (satu WS, kontrak) -> W1 (01, 02, 03 paralel) -> W2 (04, 05, 06, 07 paralel) -> W3 (08, 09, 10 paralel) -> W4 (11) -> W5 (12).
Tidak ada file bersama antar WS dalam satu gelombang (tabel di bawah).

### 3.1 Kepemilikan file (EKSKLUSIF; semua path baru kecuali WS-11)

Batas Rule 8: route 150, service 300, repository 250, schema 200, types 300, utility 200, config 100, test 400; hard 500 baris / 20.000 karakter. Estimasi = baris produksi.

| WS | File dimiliki | Est. |
|---|---|---|
| 00 | `src/shared/browser.contract.ts` (types+konstanta, <=300) · `src/shared/browser.wire.ts` (encode/decode frame, <=200) · `src/shared/browser.coords.ts` (`toPagePoint`, <=100) · `src/shared/browser.url.ts` (validasi skema, `hostOnly`, <=150) · `src/shared/browser.discard.ts` (`shouldDiscard`, <=100) · test `*.test.ts` masing-masing | ~850 + test ~500 |
| 01 | `src/server/browser/cdp.client.ts` (<=200) · `chromium.launch.ts` (cari bin, flag, spawn, <=200) · `chromium.flags.ts` (<=100) · `browserHost.service.ts` (<=300) · `browserHost.input.ts` (peta event->CDP, <=200) · `browserHost.targets.ts` (<=200) · `fakeCdp.testkit.ts` (server `ws` tiruan, helper test) · tests `cdp.client.bun.test.ts`, `browserHost.bun.test.ts`, `chromium.flags.test.ts`, `browserHost.input.test.ts` | ~1200 + test ~900 |
| 02 | `src/server/browser/ssrf.ip.ts` (klasifikasi IP, <=150) · `ssrf.proxy.ts` (CONNECT + forward, <=300) · `ssrf.allowlist.ts` (parse `ALLOW_HOSTS`, hard-deny port sendiri, <=100) · `navigation.guard.ts` (skema + Fetch lapis-2, <=200) · tests `ssrf.ip.test.ts`, `ssrf.proxy.bun.test.ts`, `navigation.guard.test.ts` | ~750 + test ~700 |
| 03 | `src/server/browser/cookieVault.store.ts` (AES-256-GCM, <=250) · `cookieImport.parse.ts` (storageState + Netscape, <=250) · `cookieImport.preview.ts` (preview in-memory TTL, <=150) · `cookieRedact.ts` (<=100) · `profile.paths.ts` (<=100) · tests `cookieVault.store.bun.test.ts`, `cookieImport.parse.test.ts`, `cookieImport.preview.test.ts`, `cookieRedact.test.ts` | ~850 + test ~700 |
| 04 | `src/server/browser/browserWs.gateway.ts` (<=300) · `browserWs.viewers.ts` (penonton/subscribe, <=150) · `browserWs.backpressure.ts` (<=150) · tests `browserWs.gateway.bun.test.ts`, `browserWs.backpressure.test.ts` | ~600 + test ~500 |
| 05 | `src/server/browser/browserLifecycle.service.ts` (<=300) · `browserLifecycle.queue.ts` (antrean LRU live, <=150) · tests `browserLifecycle.service.test.ts`, `browserLifecycle.queue.test.ts` | ~450 + test ~450 |
| 06 | `src/client/BrowserNode.tsx` (<=300) · `browser.surface.tsx` (canvas+overlay+textarea IME, <=250) · `browser.stream.ts` (klien WS biner, <=200) · `browser.input.ts` (event DOM -> pesan, <=200) · `browser.clipboard.ts` (<=100) · tests `browser.input.test.ts`, `browser.stream.test.ts`, `BrowserNode.test.tsx` (jsdom pragma) | ~1050 + test ~700 |
| 07 | `src/server/browser/browserLease.service.ts` (<=250) · `browserAgent.verbs.ts` (<=300) · `browserAgent.snapshot.ts` (AX -> ref, <=250) · `browserAgent.cdpAllowlist.ts` (wrapper tunggal, <=150) · `browserAgent.wrap.ts` (bungkus konten tak tepercaya, <=100) · `browserControl.handler.ts` (route `/api/control/browser/...`, <=150) · tests `browserLease.service.test.ts`, `browserAgent.verbs.bun.test.ts`, `browserAgent.snapshot.test.ts`, `browserAgent.cdpAllowlist.test.ts` (struktural), `browserControl.handler.test.ts` | ~1200 + test ~900 |
| 08 | `src/server/browserApi.ts` (route status/lease/agent-control, <=150) · `src/server/browserApi.cookies.ts` (route cookie, <=150) · tests `browserApi.bun.test.ts`, `browserApi.cookies.bun.test.ts` | ~300 + test ~400 |
| 09 | `src/client/BrowserLeaseChip.tsx` (<=120) · `BrowserToolbar.tsx` (<=200) · `BrowserCookieDialog.tsx` (<=250) · `browser.api.ts` (REST wrapper, <=100) · tests `BrowserCookieDialog.test.tsx`, `BrowserLeaseChip.test.tsx`, `browser.api.test.ts` | ~670 + test ~500 |
| 10 | `src/server/browserAgentShim.ts` (<=200; pola `contextLinkSkill.ts`) · test `browserAgentShim.test.ts` | ~200 + test ~150 |
| 11 | Ubah: `src/shared/workspace.ts` (+`'browser'` pada `WsNodeKind`; +`url?`, `agentControl?` pada `WsNode`; file 464 baris -> tambah <10 baris kohesif) · `src/client/nodeTypes.tsx` · `nodeList.ts` · `store.ts` (`toFlow`/`toWsNode` salin `url`,`agentControl`) · `App.tsx` (`onAddBrowser`) · `canvasMenu.model.ts` + `canvasMenu.pane.tsx` + `CanvasToolbar.tsx` (`KIND_ICONS`) + `Dock.tsx` · `src/server/api.ts` (rantai `browserApi`) · `index.ts` (konstruksi `BrowserHost`/gateway) · `upgradeRouting.ts` (`/ws/browser`) · `control/capabilities.ts` (+`'browser.read'`,`'browser.act'` pada union dan `CAPABILITY_VERBS`) · `control/mount.ts` (rute browser) · `envRegistry.platform.ts` + `envRegistry.types.ts` (`EnvGroup += 'browser'`) · `CHANGELOG.md` · README (bagian kontrak yang berubah saja). Baru: `src/server/browser/browser.runtime.ts` (perekat, <=150) · `browser.integration.bun.test.ts` · `browser.envRegistry.ts` (def env, <=100) | ~350 ubah + ~250 baru |
| 12 | `src/server/central/tools/defs/browser.status.ts`, `browser.act.ts` (+ satu baris daftar di `defaultRegistry.ts` hanya setelah `ca2` mendarat) · test `browserTools.test.ts` | ~250 + test ~250 |

Catatan Rule 8: file ber-estimasi mendekati batas (>=80%) dipecah worker sejak awal; `browserAgent.verbs.ts` dibagi `*.verbs.read.ts`/`*.verbs.act.ts` bila >240 baris. Setiap WS yang menambah env/flag tidak menyentuh registry: konstanta nama dan default ada di `browser.contract.ts`, WS-11 mendaftarkannya.

### 3.2 Alur data (ringkas)

```
Chromium (1 proses / profil workspace; --proxy-server=127.0.0.1:<ssrf>)
  <-CDP pipe/loopback-> BrowserHost (server)
        | screencastFrame (JPEG)                        ^ Input.dispatch* / Emulation / Page.navigate
        v                                               |
  browserWs.gateway  --[type|idLen|id|seq|JPEG] /ws/browser-->  BrowserNode (canvas)
        ^                                                       | JSON {ack, mouse, key, text, resize, nav}
        +-------------------------------------------------------+
  Agent --capability wcap_--> /api/control/browser/:nodeId/:verb --> lease -> verbs -> BrowserHost
```
