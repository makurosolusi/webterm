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
hanya token root yang lolos. `/api/control/browser/*` lolos gerbang lewat jalur capability, tetapi handler
menolak dengan 401 bila tidak ada `x-webterm-capability` yang valid. Socket browser terikat ke workspace lewat
query `workspaceId`.

## Capability untuk agent
Verb `browser.read` (status, snapshot, screenshot, wait) dan `browser.act` (navigate, click, type, press,
scroll, handoff, release) dipisah supaya agent baca-saja tidak bisa menggerakkan halaman. Jalur injeksi:
1. Saat PTY agent dibuat, `sessions` memanggil `browser.sessionHook.envFor(sessionId, kind)` yang mencetak dua
   capability (`WEBTERM_BROWSER_READ_CAP`, `WEBTERM_BROWSER_ACT_CAP`) dan menaruhnya di env sesi.
   Nilainya tidak pernah dilog.
2. `installBrowserAgentShim()` (hanya bila flag on) memasang shim yang membaca env tersebut dan memanggil
   `/api/control/browser/:nodeId/:verb`. `WEBTERM_BROWSER_NODE_ID` memilih node default.
3. Pembaruan capability dikerjakan `control/mount.ts`; `sessionHook.release(sessionId)` mencabutnya saat sesi tutup.
4. `applyPtyOptions()` mengganti `sessions.options` secara utuh, jadi ia ikut membawa `browser: activeBrowser()?.sessionHook`.

## Hapus node
Tidak ada pesan "discard" eksplisit di protokol. Hapus node = unmount `BrowserNode` -> detach -> timer discard
lifecycle server (`WEBTERM_BROWSER_DISCARD_MS`) membuang halamannya.

## Cookie
`DELETE /api/browser/:workspaceId/cookies/<domain>`: domain ada di path karena body DELETE tidak dibaca
(`cappedBodyGetter` mengembalikan `''`). Tanpa domain = hapus semua. Vault AES-256-GCM, kunci acak di SecretStore.

## Batasan yang diketahui
- Node browser yang dibuat setelah sesi agent berjalan belum punya capability sampai sesi di-respawn.
- Crash proses (bukan SIGINT/SIGTERM) bisa meninggalkan Chromium yatim.
- `status.version` belum disediakan.
- Throttle mouse-move dan keyCode 229 (IME) di sisi klien belum dikerjakan.
- Chromium nyata TIDAK diuji; test memakai server CDP tiruan (`fakeCdp.testkit.ts`).
