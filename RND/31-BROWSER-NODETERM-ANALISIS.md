# 31 — Browser sungguhan di canvas: bagaimana nodeterm melakukannya, dan celah webterm

Status: R&D baca-saja. Referensi: `nodeterm-web` (HEAD `6637f61`, 2026-10-27, `package.json` v0.4.5, Electron `^42.11.12` di `package.json:227`). Path nodeterm di bawah relatif ke `nodeterm-web/`; path webterm relatif ke worktree `rnd-browser`. `[BT]` = tak terverifikasi; `[opini]` = penilaian.

## 1. Jawaban singkat

nodeterm bisa menampilkan browser sungguhan karena **bukan HTML biasa**: ia memakai tag Electron `<webview>`, yaitu proses Chromium *terpisah* (satu guest `webContents` per node) yang ditempel ke DOM renderer oleh proses main. Fitur lanjutan (login bertahan, popup jadi node, kontrol agent, hibernasi) bertumpu pada dua kemampuan Electron: (a) **partition/session** per guest, (b) **`webContents.debugger` (CDP) di proses main**. Di Server Edition (web) nodeterm sendiri **tidak punya** browser node yang berfungsi — itu dinyatakan permanen (lihat 3.3).

## 2. Bagaimana tepatnya nodeterm menampilkan browser

### 2.1 Rantai render

| Lapis | Fakta | Sumber |
|---|---|---|
| Izin tag | `webviewTag: true` di `webPreferences` jendela utama; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, `plugins: true` | `src/main/index.ts:1311-1322` |
| Elemen | `<webview src partition allowpopups>` dirender React di `div.browser-node__view.nodrag.nowheel` | `src/renderer/nodes/BrowserSurface.tsx:304-316` |
| Node chrome | `BrowserNode` = header + `NodeResizer` + `BrowserSurface`; handle `flow-in`/`flow-out` tak terlihat untuk tali agent | `nodes/BrowserNode.tsx:22-100` |
| Toolbar | back/forward/reload/stop/address bar memanggil metode elemen (`goBack`, `goForward`, `reload`, `stop`, `canGoBack`) | `BrowserSurface.tsx:15-27, 278-303` |
| Navigasi | digerakkan atribut `src`, bukan `loadURL` (webview tanpa `src` tak pernah emit `dom-ready`) | `BrowserSurface.tsx:60-65` |
| Event guest | `did-start-loading`, `did-stop-loading`, `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-fail-load` | `BrowserSurface.tsx:174-179` |
| Persist | hanya `data.url` + `data.title` ke node; riwayat di store `useBrowserHistory` | `BrowserNode.tsx:84-89` |

Dokumentasi Electron *"We currently recommend to not use the webview tag and to consider alternatives, like iframe, a WebContentsView, or an architecture that avoids embedded content altogether"* (https://www.electronjs.org/docs/latest/api/webview-tag, dibaca 2026-11). Fondasi nodeterm sendiri berstatus "tidak direkomendasikan".

### 2.2 Partition / session (kunci "login saya tidak hilang")

- Node yang dibuka **user**: tanpa `partition` → berbagi `session.defaultSession` dengan jendela app. Node yang dibuka **agent**: `persist:nt-agent-browser-<projectId>` (per-project, bukan per-node, bukan global). `src/shared/browser-partition.ts:1-45`.
- `partition` hanya dihormati saat *attach*; mutasi sesudahnya diabaikan (probe Electron 42.8.1, dikutip di komentar yang sama). Maka field diset sekali saat node dibuat, tak pernah dimutasi.
- Gerbang saat load: `loadedAgentBrowserPartition` menolak partition apa pun selain yang *persis* dibentuk project ini — `project.json` dianggap input hostile (git-shared). `browser-partition.ts:~48-70`.
- Pelajaran: isolasi jar cookie = fitur keamanan utama (tanpa itu agent membaca login user).

### 2.3 Guest hardening di proses main

`app.on('web-contents-created')` mengeraskan semua guest (`src/main/index.ts:1593-1660`):
- `will-navigate` guest dibatasi `allowGuestNavigation`: hanya `http(s)`, `nt-media://` (jailed), dan `file://` hanya bila halaman sekarang juga `file://` (`src/main/webview-nav.ts`).
- `setWindowOpenHandler` guest: popup **tidak pernah jadi jendela**; hanya `http(s)` diteruskan sebagai event `browserNewWindow` → node browser baru (tali dari node asal). Butuh peta `webContentsId → nodeId` dari `browser.register` yang dipanggil renderer saat `dom-ready` (`BrowserSurface.tsx:196-209`), divalidasi `contents.getType() === 'webview'` sebelum disimpan (`src/main/browser-guest-registry.ts`).
- Tidak ditemukan (grep `src/main`, non-test): `setPermissionRequestHandler`, `setPermissionCheckHandler`, `will-attach-webview`, `session.fromPartition`, `webRequest`. Artinya **izin kamera/mic/geolokasi/notifikasi guest tidak digerbang eksplisit** dan `webPreferences` guest tidak dipaksa; default Electron persisnya `[BT]`.
- Guest tanpa `preload`: tanpa jembatan IPC.

### 2.4 Hibernasi saat tersembunyi ("Browser Memory Saver")

| Aspek | Fakta | Sumber |
|---|---|---|
| Alasan | tiap `<webview>` = satu proses renderer Chromium; canvas tak membatasi jumlah node | `nodes/browser-discard-policy.ts:1-8` |
| Ambang | `BROWSER_DISCARD_MS = 5 * 60_000`; `shouldDiscard = enabled && !loading && !audible && !driven && hiddenMs > 5 mnt` | `browser-discard-policy.ts:33-51` |
| Deteksi tersembunyi | `IntersectionObserver` pada root surface; timer `+1000 ms` slack; saat timer jalan, ukur ulang `getBoundingClientRect` (bukan percaya observer) | `useDiscardWhenHidden.ts:87-160` |
| Pengecualian | sedang load, sedang bersuara (`isCurrentlyAudible()` dibungkus try/catch), **sedang disetir agent (lease)**; dicoba ulang tiap 60 s | `useDiscardWhenHidden.ts:14, 126-132` |
| Cara membuang | **unmount elemen `<webview>`** (mengosongkan `src` tidak mematikan guest) → `DiscardedPlate` | `BrowserSurface.tsx:305-330` |
| Restore | saat terlihat lagi: `src = locationRef` (URL terakhir yang benar-benar dimuat, bukan isi address bar); cookie selamat karena partition sama; **stack back/forward, scroll, state form hilang** | `BrowserSurface.tsx:232-241`, policy baris 29-31 |
| Echo restore | `did-navigate` hasil restore ditelan (one-shot, dicocokkan URL) agar sekadar *melihat* node tak mengotori project | `BrowserSurface.tsx:121-145` |
| Setting | `browserMemorySaver` default `true`; dibaca ulang saat timer menembak | `src/shared/types.ts:2171, 2550`, `useDiscardWhenHidden.ts:122` |
| Ganti project | pool *keep-alive*: elemen webview tak boleh di-unmount **atau dipindah/di-reorder** (DOM move membunuh guest, terukur Electron 42.x); node project lain dirender sebagai "ghost" `display:none` di ekor daftar node | `lib/webviewKeepAlive.ts:1-30`, `state/webviewKeepAlive.ts` |

### 2.5 Error plate

`did-fail-load` → `isReportableFailure(isMainFrame, code)` (subframe dan `ERR_ABORTED=-3` diabaikan) → `describeLoadFailure` memetakan ±22 kode `net_error_list.h` ke kalimat + petunjuk + `retryable` (`nodes/webviewError.ts:43-94`). Plate **menutup** halaman error bawaan Chromium; hanya `did-start-loading` yang menghapusnya (bukan `did-navigate`, karena Chromium menavigasi ke halaman error di URL yang sama) — `BrowserSurface.tsx:108-113`. Teks tanpa istilah Electron → **bisa dipakai ulang apa adanya**.

### 2.6 Bagaimana agent menyetir browser (hanya Electron desktop)

Agent memanggil verb `browser` lewat shim canvas-control → hook server → main (`src/core/canvas-control-core.ts:433-475`, `src/core/browser-verb.ts`). Arsitektur:

| Komponen | Peran | Sumber |
|---|---|---|
| Verb | `open-browser` membuat node (tercatat milik pemanggil); `browser --node <id> <1 aksi>`: `nav, read(text/map/links/title), click, type, press, scroll, wait, screenshot, cookies`. Semua flag wajib bernilai; tepat satu aksi per panggilan | `browser-verb.ts:46-82`, `main/browser-open-claim.ts` |
| Transport | `webContents.debugger` (CDP) pada guest; attach malas saat verb pertama, detach idle `LEASE_IDLE_MS=60 s` | `main/browser-lease.ts:39`, `browser-cdp-send.ts` |
| Gerbang CDP | **default-deny allowlist (metode, validator-parameter)**, satu-satunya jalur `sendCommand` (dijaga tes struktural). Dikecualikan: `Runtime.evaluate`, domain `Debugger`, `Fetch`, `Security`, `Storage`/`IndexedDB`/`DOMStorage`, `DOM.getOuterHTML`, `Network.getAllCookies`, `Page.bringToFront`, hampir semua `Emulation` | `main/browser-cdp-allowlist.ts:1-30, 99-` |
| Skrip sisi-halaman | hanya entri tabel `NT_SCRIPTS` (string literal beku, tanpa interpolasi, murni *reader*) lewat `Runtime.callFunctionOn` dengan argumen skalar | `main/browser-nt-scripts.ts:1-30` |
| Model kontrol | **peta DOM + `@ref`** (`--read map` → role, nama aksesibel, href, titik tengah viewport), bukan screenshot. Ref terikat satu node + satu "generasi navigasi"; ref basi **ditolak**, tidak di-resolve ulang | `browser-refs.ts:1-15`, `browser-nt-scripts.ts` (`readMap`) |
| Input | `Input.dispatchMouseEvent` (koordinat harus dalam viewport), `Input.dispatchKeyEvent` (hanya 12 tombol bernama), `Input.insertText` ≤8192 | `browser-cdp-allowlist.ts` (ALLOW), `browser-verb.ts:46-60` |
| Izin berlapis | verb `browser` wajib identitas `verified`; agent kind harus control-capable; **switch per-project, default OFF** (user saja yang bisa nyalakan, dibaca live tiap panggilan); ledger kepemilikan (pemanggil hanya bisa menyetir node yang ia buka; "tak ada" = "bukan milikmu" agar tak jadi oracle enumerasi); node yang di-Stop user ditombstone | `main/browser-drive.ts:1-35`, `main/browser-control-ledger.ts` |
| Indikator | chip "driving" di header node selama lease aktif + tombol Stop | `nodes/BrowserNode.tsx:57`, `nodes/BrowserDrivingChip.tsx` |
| Cookies | hanya **baca** satu domain, dengan trace ke board-log **sebelum** baca (fail-closed); tak ada verb tulis (`COOKIE_WRITE_METHODS` tak terjangkau) | `main/browser-cookies.ts:1-30`, `browser-cdp-allowlist.ts:76-83` |
| Screenshot | PNG ke path **dijail** ke direktori project (realpath parent + `lstat`) | `main/browser-screenshot.ts:1-15` |
| Hibernasi vs lease | lease hidup = node tak boleh di-discard | `browser-discard-policy.ts:12-20` |

Tes: `test/acceptance/control-verb-disposition.test.ts` hanya disposisi verb; semantik drive di `src/main/browser-*.test.ts`.

## 3. Ketergantungan Electron: apa yang tak bisa dipindah

### 3.1 Tabel pemisahan

| Kemampuan | Bergantung Electron? | Alasan / padanan web |
|---|---|---|
| `<webview>` (proses Chromium tertempel di DOM) | **Ya, mutlak** | Di Chrome biasa `<webview>` hanyalah elemen tak dikenal; tag ini hanya ada bila `webviewTag:true`. Padanan web: *stream* dari Chromium di server (lihat 5) |
| Partition `persist:` per node | **Ya** (`session.fromPartition`) | Padanan: `--user-data-dir`/BrowserContext per node di server |
| `will-navigate` / `setWindowOpenHandler` guest | **Ya** | Padanan: CDP `Page.frameRequestedNavigation`/`Target.targetCreated` + `Fetch`/`Page.navigate` intercept di server |
| CDP via `webContents.debugger` | **Ya** (transportnya); **protokolnya tidak** | CDP adalah protokol Chromium; di server Chromium sendiri membuka `--remote-debugging-port`/pipe |
| `isCurrentlyAudible()`, zoom halaman, context menu native | Ya | padanan CDP `[BT]`; AutoFill macOS hilang |

### 3.2 Yang bisa dipakai ulang (tanpa Electron)

| Aset | Berkas | Catatan |
|---|---|---|
| Kebijakan discard (konstanta + predikat murni) | `browser-discard-policy.ts` | murni TS; `driven` = lease agent |
| State machine "hidden → discard → restore" | `useDiscardWhenHidden.ts` | hanya butuh `IntersectionObserver` + `useSettings`; **fire-time re-check** dan "retry 60 s" patut ditiru |
| Pemetaan error → plate | `webviewError.ts`, `WebviewErrorPlate.tsx`, `DiscardedPlate.tsx`, `WebviewLoadingBar.tsx` | kode `ERR_*` sama bila server Chromium yang melapor (`Page.navigate` → `errorText`) |
| Normalisasi alamat | `src/shared/browserUrl.ts` (29 baris), `nodes/browserUrl.ts` (search-or-url) | satu sumber untuk address bar **dan** allowlist |
| Peta ref DOM + generasi navigasi | `browser-refs.ts` (122 baris, murni) | konsep ref-basi-ditolak wajib dibawa |
| Allowlist CDP (pola, bukan daftar) | `browser-cdp-allowlist.ts` | murni TS, tak impor Electron; pola (metode, validator) + wrapper tunggal + tes struktural |
| NT_SCRIPTS (reader murni) + tes sumber | `browser-nt-scripts.ts` + `.source.test.ts` | murni; berjalan di halaman via `callFunctionOn` |
| Ledger kepemilikan, lease, tombstone | `browser-control-ledger.ts`, `browser-lease.ts` | `DebuggerLike` (`browser-cdp-send.ts:13-20`) antarmuka sempit; WebSocket CDP bisa memenuhinya |
| Partition per-project + gerbang load | `browser-partition.ts` | konsep portabel (profil dir) |
| Trace-sebelum-baca cookie | `browser-cookies.ts` | portabel (sink audit: SQLite) |

Lisensi: nodeterm **BUSL-1.1** (`LICENSE`); Additional Use Grant melarang menawarkan ke pihak ketiga sebagai hosted/embedded — webterm bukan fork nodeterm (dibuat dari nol, hanya terinspirasi; CLAUDE.md webterm); nodeterm adalah repo referensi berlisensi BUSL-1.1, jadi kode yang disalin-adaptasi darinya tetap terikat syarat itu.

### 3.3 Server Edition nodeterm sengaja menyerah

- `BROWSER_UNSUPPORTED_CLAUSE`: *"a browser node here renders in your own browser tab, which this server has no debugger for"* (`src/server/control-unsupported.ts:32-41`). Verb `browser` dijawab penolakan permanen bernama `control-unsupported-on-this-edition` agar model tidak retry.
- Bridge web membuat `browser.*` jadi `noop` ("no `<webview>`, no CDP") `src/renderer/bridge/stubs.ts:235-246, 681-683`; dev-ports ditolak karena "halaman akan dimuat di mesin viewer, tempat port server tak ada" (`stubs.ts:312-319`).
- `src/renderer/electron-webview.d.ts` hanya mendeklarasikan `webview` ke JSX; tidak ada fallback iframe di `BrowserSurface`. Satu-satunya `<iframe>` di renderer: viewer PDF di `EditorNode` dan `LocalFilePreviewModal`.
- **Kesimpulan**: nodeterm **tidak menyelesaikan** masalah webterm; menyalin `BrowserSurface` menghasilkan kotak kosong. Nilainya: referensi desain keamanan dan UX.

## 4. Keadaan webterm sekarang

| Pertanyaan | Temuan | Bukti |
|---|---|---|
| Tipe node | `terminal`, `agent`, `files`, `editor` — **tidak ada web/browser** | `src/client/nodeTypes.tsx:13-17`, `src/shared/workspace.ts:404` |
| iframe / webview | satu-satunya `<iframe>`: pratinjau PDF (blob URL) di `EditorNode` | `src/client/EditorNode.tsx:142-143, 268` |
| Chromium/CDP/puppeteer/playwright di dependency | **tidak ada** (dependencies: React 19, `@xyflow/react`, xterm, monaco, `ws`, dll) | `package.json` |
| Server | `node:http` di atas Bun + `ws`; satu jalur upgrade `/ws` (PTY) lewat `upgradeRoute`; auth Origin + token | `src/server/index.ts:1,112,152-169`, `src/server/auth.ts:1-12` |
| Header framing | server webterm tak mengirim `X-Frame-Options`/`frame-ancestors` (grep `setHeader`) | `src/server/*.ts` |
| Kontrol node oleh agent | token kapabilitas in-memory (sha256) dengan verb `node.spawn/prompt/wait/close/read`, `plan.read`, `approval.*`; **tak ada verb browser** | `src/server/control/capabilities.ts:12-27` |
| Persistensi node | `WsNode` satu blob JSON di SQLite → tambah `kind`/field = **nol migration** | `src/shared/workspace.ts:420` |
| Chrome node | `NodeChrome.tsx` (toolbar, maximize, collapse, komentar) sudah generik | `src/client/NodeChrome.tsx` |

**Celah** (urut dampak): (1) tak ada permukaan render browser; (2) tak ada Chromium terkelola di server; (3) tak ada verb browser di `control/`; (4) tak ada model sesi/cookie browser; (5) tak ada kebijakan discard node berat non-PTY; (6) tak ada guard SSRF untuk URL dari user/agent.

## 5. Mengapa `<iframe>` biasa tidak cukup

| Hambatan | Mekanisme | Dampak di canvas webterm |
|---|---|---|
| `X-Frame-Options` / CSP `frame-ancestors` | Situs besar (Google, GitHub, bank, X, LinkedIn) mengirim `X-Frame-Options: DENY/SAMEORIGIN` atau `frame-ancestors`; browser menolak render di frame lintas-origin. MDN: XFO usang tapi `frame-ancestors` menggantikannya dan sama mengikat | Frame kosong "refused to connect"; tak ada API untuk tahu pasti (event `load` tetap menyala) |
| Cookie pihak ketiga | Di dalam iframe lintas-situs, cookie situs tujuan berstatus *third-party*; `SameSite=Lax` default membuang cookie di sub-resource lintas situs; Safari/Firefox memblokir cookie pihak ketiga secara default `[BT: kebijakan Chrome 2025-2026 berubah-ubah; verifikasi sebelum bergantung]` | Login user di tab lain **tidak ikut**; login di dalam frame tidak menempel → "node browser selalu logged-out" |
| Same-origin policy | Induk (webterm) tak bisa membaca DOM, URL akhir, title, atau error muatan iframe lintas-origin | Tak ada judul/URL untuk node, tak ada deteksi gagal-muat, tak ada back/forward terkontrol |
| Tanpa CDP | Halaman dalam iframe tak punya debugger yang dikendalikan server; JS induk tak bisa `click`/`type`/`screenshot` ke dalamnya | Agent **tidak bisa menyetir**; ini inti kebutuhan |
| Mixed content / localhost | Webterm HTTPS tak bisa membingkai `http://`; `localhost:3000` dimuat di mesin *viewer* (alasan sama dengan `stubs.ts:312-319`) | Dev server agent di server tak terjangkau |
| Sandbox iframe | `sandbox` ketat memutus login/popup; longgar (`allow-same-origin allow-scripts`) berbahaya | Trade-off buruk di kedua arah |
| Proxy balik (strip header) | Mengatasi XFO tapi merusak cookie `Secure/SameSite`, service worker, CSP, WebSocket situs, dan melewatkan kredensial lewat server | Buntu untuk situs ber-login `[opini]`; opsi C topik 34 |

## 6. Implikasi untuk webterm

**Rekomendasi tegas**

1. **Jangan** meniru `<webview>` dan **jangan** jadikan iframe jalan utama. Pola setara untuk web adalah: *Chromium terkelola di server* (satu BrowserContext/profil per node atau per workspace) yang ditampilkan ke node lewat stream (CDP screencast/WebRTC; detail di topik 4) dan **dikendalikan lewat CDP dari server**. Satu protokol (CDP) melayani manusia *dan* agent, sehingga "berbagi satu sesi" gratis. `[opini]`
2. Tambah `kind: 'browser'` di `WsNodeKind` dengan field `url`, `title`, `profileId` (nama konteks) — nol migration. Node baru didaftarkan di `nodeTypes.tsx` (konstanta modul; jangan bentuk di render).
3. **Bawa pola keamanan nodeterm, bukan kodenya mentah**: allowlist CDP default-deny dengan wrapper tunggal + tes struktural; reader-only NT_SCRIPTS; ref basi ditolak; switch per-project default OFF; ledger kepemilikan (agent hanya menyetir node yang ia buka); trace-sebelum-baca cookie; screenshot dijail; chip "driving" + Stop. Tambah yang nodeterm *tidak punya* karena server kita menghadap jaringan: **guard SSRF** (blok `localhost`, RFC1918, link-local, `file:`, metadata cloud) pada `Page.navigate` dan pada redirect, serta penolakan eksplisit kamera/mic/geolokasi/notifikasi guest (celah di 2.3).
4. **Pakai ulang murni**: `webviewError.ts` + plate, `browserUrl.ts`, `browser-discard-policy.ts` + `useDiscardWhenHidden.ts` (ambang 5 menit, "tidak mid-load, tidak bersuara, tidak sedang disetir"), pola `browser-refs`/`browser-verb`. Ambil lewat salin-dan-adaptasi dengan atribusi (BUSL), bukan impor lintas repo.
5. Discard di webterm berarti **menutup Chromium target/context server-side**, bukan unmount elemen; restore dari `url` (profil persisten menjaga cookie). Wajib karena RAM Chromium per node mahal dan canvas webterm tak membatasi jumlah node.
6. Dokumen 32 dan 34 menentukan stack, 33 model profil. Jangan kode sebelum satu keputusan stack (raw CDP via WebSocket vs `puppeteer-core`/`playwright-core`, Rule 10).

**Risiko**
- Chromium di server = permukaan serangan baru (RCE lewat bug renderer, SSRF, eksfiltrasi lewat halaman). Wajib: jalankan tanpa root, `--user-data-dir` terpisah dari profil user asli, sandbox Chromium nyala (jangan `--no-sandbox` di host biasa), batas RAM/CPU per konteks, jaringan egress dibatasi.
- Prompt injection dari halaman saat agent menyetir sesi ber-login: pola nodeterm mengurangi, tak menghilangkan (trace "bukan anti-tamper", `browser-cookies.ts:14-27`).
- Latensi stream dan hit-test canvas ber-zoom: topik 34.

**Belum terverifikasi `[BT]`**
- Perilaku default izin guest Electron tanpa permission handler (tidak diuji, hanya grep absen).
- Apakah `<webview>` di Chrome biasa murni elemen tak dikenal (kesimpulan dari komentar `stubs.ts` + dokumentasi Electron; tidak diuji, dilarang menjalankan browser).
- Status cookie pihak ketiga Chrome per 2026-11 dan perilaku Safari/Firefox saat ini.
- Apakah ada tes acceptance nodeterm yang menggerakkan browser sungguhan; hanya sebagian kecil `test/` dibaca.
- Cakupan Additional Use Grant BUSL-1.1 terhadap webterm; lifecycle discard PTY webterm.
