# Browser Canvas: keputusan integrasi (WS-11)

Node `browser` menampilkan Chromium di server sebagai stream di kanvas. Semua fitur mati secara default;
dokumen ini mencatat *kenapa* perakitannya begini. Rencana lengkap: `PLAN/BROWSER-CANVAS-a..d.md`.

## Flag off = perilaku identik
- `startBrowserRuntime()` mengembalikan `null` bila `WEBTERM_BROWSER` bukan persis `on`, atau bila
  `WEBTERM_BROWSER_ALLOW_HOSTS` rusak (fail closed). Tanpa runtime: tidak ada proses Chromium, tidak ada rute
  `/api/browser/*`, dan `upgradeRoute` tidak menerima path `/ws/browser` (fungsi itu hanya diberi path bila flag on).
- Klien memeriksa `GET /api/browser/status` sekali per load. 404/galat/`enabled:false` = null, sehingga item
  "New Browser" (Dock, menu pane) tidak muncul dan tidak ada WebSocket. Biayanya satu request 404 per load.
- Dibuktikan oleh `browserCanvas.test.tsx`, `browser.integration.bun.test.ts`, `upgradeRouting.test.ts`,
  `sessions.browser.test.ts`.

## Gerbang auth
`/ws/browser` dan `/api/browser/*` BUKAN `isNodeTokenPath`, jadi token node (sesi agent) ditolak di sana;
hanya token root yang lolos. `/api/control/browser/*` lolos gerbang lewat jalur capability atau token node; handler
menolak dengan 401 bila tidak ada `x-webterm-capability` yang valid maupun token node yang dikenal. Socket browser terikat ke workspace lewat
query `workspaceId`.

## Capability untuk agent
Verb `browser.read` (status, snapshot, screenshot, wait, console) dan `browser.act` (navigate, click, type, press,
scroll, handoff, release) tetap dipisah di kontrak (`BROWSER_VERB_CAP`). Ada dua jalur identitas ke
`/api/control/browser/[:nodeId/]:verb` (`browserControl.handler.ts`):
1. **Sesi agent PTY: token node + kabel, dibaca per panggilan.** Sesi agent tidak lagi diberi capability browser
   di env saat spawn (model lama `WEBTERM_BROWSER_READ_CAP`/`WEBTERM_BROWSER_ACT_CAP` dihapus bersama
   `browser.sessionCaps.ts`). Shim `webterm-browser` (`browserAgentShim.ts`, dipasang sekali saat runtime start)
   hanya membawa token node sesi itu sendiri (`WEBTERM_TOKEN`, cadangan `NODETERM_NODE_TOKEN`) lewat `curl -K -`,
   jadi tidak ada nilai di argv. Server memetakan token ke node agent (`requesterOf`), lalu
   `resolveLinkedBrowser` (`browser.linkedTarget.ts`) membaca board TERSIMPAN saat panggilan itu: hanya node
   browser yang terhubung kabel (edge, arah mana pun, `linkedPeerIds` dari `contextLinkRoute.ts`) yang boleh
   dikemudikan. Satu kabel = otomatis; beberapa = `409 ambiguous_browser`, pilih dengan `--node <id>`;
   nol = `404 no_linked_browser` dengan pesan yang menyuruh agent minta kabel; `--node` ke browser tak terhubung =
   `403 not_linked`. Menyambung kabel langsung berlaku, melepasnya langsung mencabut, tanpa respawn sesi.
2. **Agent Pusat: capability `browser.*`** di header `x-webterm-capability`, node wajib di path
   (`400 node_required` bila tidak ada), di-scope `node:<id>`.

Kedua jalur lalu melewati gerbang yang sama, `agentAllowed(nodeId)`: sub-opsi `WEBTERM_BROWSER_AGENT`
(default `on`, `agentControlOn` di `browser.runtime.parts.ts`) DAN toggle per node `agentControl` (default on;
hanya `false` eksplisit yang mematikan). Ditolak = `403 disabled` dengan pesan "jangan retry"; `release` selalu
boleh supaya agent bisa melepas lease.

Kenapa per panggilan, bukan env saat spawn: model env membuat izin beku sejak sesi lahir (browser yang dibuat
belakangan tak terjangkau sampai respawn) dan, dengan satu browser di board, agent tanpa kabel ikut bisa
mengemudikannya. Pola ini meniru Orca (`browser-command-targets.ts`: halaman dipilih per panggilan dari
konteks pemanggil, error jelas bila tak ada) dan nodeterm (`browser-drive.ts`: gerbang dibaca LIVE saat drive,
identitas pemanggil terverifikasi), sama dengan pola context-link yang sudah ada di repo ini.

## Hapus node
Tidak ada pesan "discard" eksplisit di protokol. Hapus node = unmount `BrowserNode` -> detach -> timer discard
lifecycle server (`WEBTERM_BROWSER_DISCARD_MS`) membuang halamannya.

## Cookie
`DELETE /api/browser/:workspaceId/cookies/<domain>`: domain ada di path karena body DELETE tidak dibaca
(`cappedBodyGetter` mengembalikan `''`). Tanpa domain = hapus semua. Vault AES-256-GCM, kunci acak di SecretStore.

## Batasan yang diketahui
- Crash proses (bukan SIGINT/SIGTERM) bisa meninggalkan Chromium yatim.
- `status.version` belum disediakan.
- Throttle mouse-move dan keyCode 229 (IME) di sisi klien belum dikerjakan.
- Chromium nyata TIDAK diuji; test memakai server CDP tiruan (`fakeCdp.testkit.ts`).

## Penempatan node browser
Node browser bisa dibuka dari konteks (menu klik kanan link di terminal/agent, drop URL ke canvas), tidak hanya
dari tombol `+`. Rencana: `PLAN/BROWSER-PLACEMENT-a..c.md`. Keputusan:
- **Satu pintu `openBrowserAt`** lewat `NodeActions` (`useBrowserOpen`). Nilainya `undefined` bila flag browser
  mati di server, jadi semua pemicu otomatis tak muncul. Pemicu baru cukup memanggil pintu ini.
- **Perencana murni** (`browser.open.plan.ts`, `browser.open.place.ts`): tanpa DOM/React Flow, mudah dites.
  Hasilnya reuse, create (posisi + ukuran), atau invalid. Validasi URL tetap satu: `parseBrowserUrl`.
- **Dedupe = reuse + seleksi + fit-view, TANPA navigasi.** Kunci kanonik (fragmen dibuang, alias loopback
  disatukan) hanya untuk perbandingan dengan `data.url`; URL yang dikirim tetap apa adanya. Alasan: `nav` ditolak
  `lease_agent` saat agent memegang lease, dan navigasi akan merusak sesi pengguna. Mengirim host terkanonisasi
  juga merusak entri `WEBTERM_BROWSER_ALLOW_HOSTS` yang dicocokkan persis (`127.0.0.1:PORT` != `localhost:PORT`).
- **URL awal lewat `nav go` sekali setelah attach** (`browser.useGoto.ts`), bukan perubahan kontrak WS `/ws/browser`
  (kontrak tidak berubah). Sebabnya: server membaca URL awal dari workspace TERSIMPAN, sedangkan simpan klien
  di-debounce, jadi node baru bisa attach ke `about:blank`. Dikirim sekali per mount agar penolakan tidak jadi
  loop. Penjaga mirror: `about:blank`/kosong tidak ditulis balik ke `data.url` (`shouldMirrorUrl`).
- **Penempatan** di sisi anchor dengan kandidat berurutan kanan, bawah, kiri, lalu pindai grid, lalu kaskade;
  `at` eksplisit (drop) dipakai apa adanya. Ukuran node baru dari konstanta `BROWSER_OPEN_SIZE` (640x400), bukan
  ukuran bawaan settings. Fit-view hanya bila node tak sepenuhnya terlihat, dengan zoom minimum `FIT_MIN_ZOOM`
  (0.3) di atas `ZOOM_PAUSE_BELOW` agar stream tidak dijeda.
- **Pemicu v1:** baris "Open in canvas browser" di menu klik kanan link (terminal dan agent) dan drop URL ke
  canvas kosong (drop di atas node diabaikan). Cmd/Ctrl+klik tidak diubah (tetap tab baru).
- **Guard tidak berubah.** URL lokal tetap diblokir default dan tampil lewat UI `blocked` yang ada; baris menu
  tidak disembunyikan untuk URL lokal. Fitur ini tidak menambah log; bila perlu mencatat, hanya `hostOnly(url)`,
  tidak pernah URL penuh/query/fragmen.

### Belum ada (ditunda, menunggu keputusan pengguna)
- Pembukaan node browser oleh agent/central atas inisiatif sendiri (U2); butuh kanal server-ke-klien baru.
- Preview localhost otomatis tanpa mengisi `WEBTERM_BROWSER_ALLOW_HOSTS` (U1); melonggarkan guard SSRF.
- Cmd/Ctrl+klik link menjadi canvas browser (U3).
- Tempel (paste) URL ke canvas.
