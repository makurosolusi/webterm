# 34 — Browser sungguhan di canvas webterm: opsi streaming & arsitektur

Topik 4 R&D "browser di canvas". Konteks: webterm = server Bun + klien React Flow v12, dibuka lewat browser biasa (sering jarak jauh). Tak ada `<webview>` seperti nodeterm (Electron), jadi tampilan browser harus datang dari proses di sisi server (atau mesin lain) lewat jaringan. Label: **fakta** (sumber di tabel/kutipan), `[opini]` (penilaian), `[BT]` (belum terverifikasi).

## 1. Fakta repo webterm yang menentukan desain

| Fakta | Sumber | Dampak |
|---|---|---|
| Tipe node = union tertutup `'terminal'\|'agent'\|'files'\|'editor'`; `WsNode` flat dengan field opsional per-kind | `src/shared/workspace.ts:404`, `:421-441` | Tambah `'browser'` + field `url?`/`profileId?` (opsional → board lama tetap valid) |
| Peta tipe = konstanta modul (identitas harus stabil, remount = kehilangan state) | `src/client/nodeTypes.tsx:1-4` | `BrowserNode` didaftar di sana, pakai `memo` |
| Satu WS `/ws` multiplex PTY, pesan **JSON teks** | `src/shared/protocol.ts`, `src/server/index.ts:152-188` | Frame JPEG via JSON = base64 (+33%) dan berebut socket dengan PTY → pakai jalur biner terpisah |
| `upgradeRoute` hanya meloloskan `pathname === WS_PATH`; selain itu `destroy` (prod) | `src/server/upgradeRouting.ts` | Jalur WS baru harus ditambah di sini; gate `allowed()` (origin + token) otomatis berlaku |
| Gate: `sameOrigin` + token root; token node hanya allowlist; capability `wcap_*` hanya `/api/control/*` | `src/server/auth.ts:95-171` | Agent mengendalikan browser lewat `/api/control/browser/...` (capability), bukan port CDP mentah |
| Server = `node:http` + paket `ws` (sudah dependency), jalan di Bun | `src/server/index.ts:1-4`, `package.json` | Klien CDP mentah cukup pakai `ws` yang ada — **nol dependency baru** |
| Pola React Flow untuk konten interaktif: `nodrag nowheel` (+ `nokey` agar Backspace/ketik tak menghapus/pan node) | `TerminalCore.tsx:342`, `EditorNode.tsx:274-280` | Wajib di permukaan browser |
| `minZoom 0.01`, `maxZoom 2`; `onlyRenderVisibleElements` tidak dipakai | `App.tsx:379-380`; grep kosong | Node di luar viewport tetap ter-mount → perlu deteksi visibilitas sendiri |
| Server default loopback; off-loopback wajib token; ada `WEBTERM_TRUST_PROXY` | `auth.ts:29-50`, `envRegistry.platform.ts` | Remote lazim di belakang TLS proxy → `wss://`, secure-context untuk Clipboard API terpenuhi |
| nodeterm sudah punya predikat pure discard (`BROWSER_DISCARD_MS=5 menit`; jangan discard bila loading/audible/`driven`) | `nodeterm-web/src/renderer/nodes/browser-discard-policy.ts` | Salin logika murni ini; `driven` = lease agent |

## 2. Opsi A — Chromium server-side + CDP screencast (rekomendasi)

Server menjalankan Chromium (headless) lalu bicara CDP lewat WebSocket. Fakta dari `browser_protocol.json` (devtools-protocol master, dibaca hari ini):

- `Page.startScreencast {format: jpeg|png, quality, maxWidth, maxHeight, everyNthFrame, maxFramesInFlight, sendLastFrame}` — eksperimental; event `Page.screencastFrame {data(base64), metadata, sessionId}`; **wajib** `Page.screencastFrameAck {sessionId}` agar frame berikutnya datang; ada `Page.screencastVisibilityChanged`.
- Input: `Input.dispatchMouseEvent {mousePressed|mouseReleased|mouseMoved|mouseWheel, x, y, button, buttons, clickCount, modifiers, deltaX, deltaY}`, `Input.dispatchKeyEvent {keyDown|keyUp|rawKeyDown|char, key, code, text, windowsVirtualKeyCode, modifiers, ...}`, `Input.insertText` & `Input.imeSetComposition` (eksperimental), `Input.dispatchTouchEvent`.
- Ukuran viewport: `Emulation.setDeviceMetricsOverride {width,height,deviceScaleFactor,mobile,...}` (varian `Page.` sudah DEPRECATED).
- Dialog: `Page.javascriptDialogOpening` (halaman macet sampai dijawab), `Page.windowOpen` (popup).
- Puppeteer 25.x punya `page.screencast()` ("Works in Chrome 153+", pptr.dev) dan Playwright punya kelas `Screencast` — jalur resmi, tapi lihat Rule 10 di §8.

### 2.1 Alur data

```
Chromium (headless, 1 proses, N Target/page)
   ^ CDP/WS (ws://127.0.0.1:<port>/devtools/page/<id>)   <- hanya server webterm
BrowserHost (server)  --binary WS /ws/browser (auth sama)-->  BrowserNode (canvas)
   screencastFrame -> [type=1|idLen|id|seq|JPEG]              <canvas> drawImage(createImageBitmap)
   <- {t:'ack',seq} -> Page.screencastFrameAck                pointer/key/wheel -> JSON {t:'mouse',x,y,...}
```

- Pesan biner satu socket bersama `/ws/browser`: header kecil (tipe, id node, seq) + JPEG mentah (tanpa base64). Input klien → server: JSON kecil teks. `[opini]` socket terpisah dari `/ws` agar frame besar tak menunda output PTY (head-of-line).
- **Backpressure**: ack ke Chromium dikirim ketika klien meng-ack frame (bukan saat frame diterima server), plus `maxFramesInFlight` kecil (1-2) dan buang frame bila `ws.bufferedAmount` tinggi. Tanpa ini, link lambat → memori server membengkak.
- **Hanya stream bila ada penonton**: tidak ada subscriber / node tak terlihat → `Page.stopScreencast` (CPU & bandwidth nol, halaman tetap hidup untuk agent).

### 2.2 Koordinat input di canvas ber-transform (inti masalah)

React Flow menaruh node di dalam `.react-flow__viewport` ber-`transform: translate() scale(z)`. Akibatnya `offsetX/offsetY` (koordinat lokal *tanpa* transform) dan lebar CSS elemen **bukan** piksel layar.

Rumus yang tahan semua zoom/pan (tanpa rotasi):

```
rect = canvasEl.getBoundingClientRect()      // SUDAH termasuk scale z (hasil transform)
x_page = (e.clientX - rect.left) / rect.width  * viewportCssW   // viewportCssW = lebar yang dikirim ke setDeviceMetricsOverride
y_page = (e.clientY - rect.top)  / rect.height * viewportCssH
```

Tidak butuh nilai `z` sama sekali; xterm memakai prinsip serupa `[opini, belum dibaca di kode xterm]`. Catatan:

| Hal | Perlakuan |
|---|---|
| Ukuran halaman vs ukuran layar node | Viewport Chromium = ukuran konten node dalam **CSS px node** (sebelum zoom), via `ResizeObserver` (debounce ~150 ms) → `setDeviceMetricsOverride`. Zoom canvas hanya menskalakan `<canvas>` oleh CSS. Teks tetap tajam bila `deviceScaleFactor` mengikuti `z*devicePixelRatio` (batasi ≤2) |
| Zoom kecil (z<0.3) | Frame mahal & tak terbaca: turunkan `maxWidth`/`quality`, atau berhenti stream dan tampilkan frame terakhir/thumbnail (§2.4) |
| Wheel | `nowheel` mencegah pan/zoom canvas, tapi listener React `onWheel` pasif → pasang `addEventListener('wheel', h, {passive:false})` agar `preventDefault()` bekerja. Ctrl+wheel/pinch = zoom canvas, jangan diteruskan (konvensi sama dengan tulisan Terminal/Editor) |
| Drag node vs klik halaman | permukaan `nodrag`; drag node hanya lewat header `NodeChrome`; `NodeResizer` di tepi |
| Fokus & keyboard | permukaan `tabIndex=0` + `nokey` (pola `EditorNode.tsx:274`), `keydown` → `dispatchKeyEvent` (`rawKeyDown`+`char`, bitmask modifier Alt=1 Ctrl=2 Meta=4 Shift=8 per dokumen CDP), `preventDefault` agar Tab/Space tak lari ke React Flow |
| IME (CJK/Android) | `<textarea>` tersembunyi di bawah kursor; `compositionupdate` → `Input.imeSetComposition`, `compositionend` → `Input.insertText` |
| Paste | event `paste` → baca `clipboardData.getData('text')` → `Input.insertText` (tak perlu izin Clipboard API) |
| Copy | tangkap Ctrl/Cmd+C → server `Runtime.evaluate('getSelection().toString()')` → klien `navigator.clipboard.writeText` (butuh secure context: `localhost` atau HTTPS) |
| Kursor | screencast tak membawa kursor OS; ambil `cursor` CSS elemen di bawah titik (`Runtime.evaluate`, throttle) atau tunda `[opini: tunda ke fase 2]` |
| Touch/tablet | `touchstart/move/end` → `Input.dispatchTouchEvent` bila `PointerEvent.pointerType==='touch'` |
| Resolusi `metadata` frame | gunakan `deviceWidth/deviceHeight/offsetTop/pageScaleFactor` dari `screencastFrame.metadata` untuk validasi pemetaan bila ada banner/emulasi `[BT: perlu uji]` |

### 2.3 Karakteristik

| Aspek | Nilai |
|---|---|
| Latensi | RTT WS + encode JPEG + compositor; lokal ≈ 1 frame (16-50 ms) `[opini]`; remote bergantung RTT, input tak menunggu frame (optimistik-tak-ada, cursor lag terasa >150 ms) |
| Bandwidth | JPEG q≈60, 1280x800 ≈ 60-150 KB/frame, 10-20 fps → ~1-3 MB/s per node aktif `[opini, perlu ukur]`; frame hanya dikirim saat layar berubah (halaman diam ≈ 0) `[BT]` |
| Video/WebGL/Canvas | Fidelity penuh: render oleh Chromium asli. Headless tanpa GPU memakai SwiftShader (WebGL lambat) `[BT]`; FPS video terbatas JPEG+ack (~15-30) |
| **Suara** | **Tidak ada** di screencast. Celah nyata vs nodeterm (webview bersuara). Opsi: terima tanpa suara, atau B (WebRTC) bila audio penting |
| Teks/seleksi/aksesibilitas | Hanya piksel di klien; pencarian-halaman, seleksi native, terjemahan browser tak jalan. Agent tetap punya DOM/AX tree lewat CDP |
| File upload/download | Butuh jalur: `Page.setInterceptFileChooserDialog` → dialog unggah webterm; `Browser.setDownloadBehavior` ke folder terkurung + notifikasi `[BT: nama command persis]` |
| Popup/new tab | `Target.setAutoAttach`/`Page.windowOpen` → buka sebagai node/tab baru atau navigasi di tempat; dialog JS → modal webterm (jangan dibiarkan hang) |

### 2.4 Resource & hibernate

- **Satu proses Chromium, banyak page**; isolasi cookie per node/workspace lewat `Target.createBrowserContext` (konteks seperti incognito) atau **profil persisten** `--user-data-dir=<dataDir>/browser/<profileId>` agar login bertahan (lihat dokumen 33 untuk impor cookie). Satu profil persisten = satu proses Chromium (kunci `SingletonLock`) `[BT: nama file]`.
- Memori: tiap site/renderer ~100-300 MB `[opini/BT]`; wajib **batas** node hidup (env baru mis. `WEBTERM_BROWSER_MAX_LIVE`, default kecil) + antrean "bekukan yang terlama tersembunyi".
- Tiga tingkat: **live** (screencast jalan) → **paused** (terlihat 0, `stopScreencast`, page tetap hidup bila `driven`) → **discarded** (`Target.closeTarget`; simpan `url` saja; cookie selamat di profil, history/scroll/form-state hilang — trade-off sama dengan nodeterm). Predikat discard = salin `shouldDiscard` nodeterm (tidak loading, tidak `driven`, `hiddenMs > 5 menit`, dibaca ulang saat timer menyala).
- Visibilitas di React Flow: `useStore` pada `transform` + bounding node, atau `IntersectionObserver` pada `<canvas>`; ambang zoom → paused. `[opini]` jangan aktifkan `onlyRenderVisibleElements` global (akan unmount terminal & hilang scrollback).

### 2.5 Sesi bersama manusia + agent

Chromium mengizinkan banyak klien CDP ke satu browser (tiap klien `Target.attachToTarget {flatten:true}` → `sessionId` sendiri) `[BT: batas jumlah; perilaku multi-screencast per target]`. Rancangan:

| Peran | Jalur |
|---|---|
| Manusia | Node canvas ↔ `/ws/browser` (screencast + input) |
| Agent | **Bukan** port CDP mentah (siapa pun di host/PTY bisa menyambung & lolos token). Lewat `/api/control/browser/:id/*` (capability `wcap_*`, `auth.ts:136-171`) berupa verb tipis (navigate, snapshot AX, click, type, screenshot), **atau** endpoint proxy WS CDP terautentikasi untuk klien yang bicara CDP (Playwright `connectOverCDP`, ego-browser/agent-browser — lihat dokumen 32) |
| Arbitrasi | *Control lease* per node: `human` / `agent(leaseId, ttl)`. Saat agent memegang lease, input manusia diblokir/ditimpa-dengan-badge ("agent sedang mengemudi"), mengikuti `BrowserDrivingChip` nodeterm; lease = `driven` di predikat discard. Manusia bisa "ambil alih" (CAPTCHA/2FA) |
| Tampilan agent ke manusia | Screencast sama; overlay highlight elemen bisa via `Overlay.highlightNode` `[BT]` |


_Lanjut di `34-BROWSER-STREAMING-ARSITEKTUR-b.md` (opsi B-E, keamanan, dependency, Implikasi untuk webterm)._
