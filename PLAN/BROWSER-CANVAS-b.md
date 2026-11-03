# PLAN BROWSER-CANVAS (b) — Kontrak lintas-WS dan rencana test

Lanjutan `-a`. Semua tipe/konstanta di bawah DITULIS WS-00 di `src/shared/browser.contract.ts` (+ `browser.wire.ts`) pada W0 dan menjadi sumber tunggal. WS lain mengimpor, tidak menyalin. Perubahan kontrak setelah W0 = permintaan ke orkestrator (bukan edit sepihak).

## 4. Kontrak

### 4.1 Konstanta bernama (Rule 15; nilai literal hanya di sini)

| Nama | Nilai | Catatan |
|---|---|---|
| `BROWSER_KIND` | `'browser'` | nilai tambahan `WsNodeKind` (WS-11 yang menambah ke union) |
| `BROWSER_WS_PATH` | `'/ws/browser'` | jalur upgrade baru |
| `MAX_FRAMES_IN_FLIGHT` | 2 | juga dikirim ke `Page.startScreencast` |
| `JPEG_QUALITY_DEFAULT` | 60 | turun otomatis saat zoom kecil |
| `FRAME_MAX_BUFFERED_BYTES` | 1_048_576 | buang frame bila `ws.bufferedAmount` melewati ini |
| `RESIZE_DEBOUNCE_MS` | 150 | `ResizeObserver` -> `resize` |
| `DSF_MAX` | 2 | batas `deviceScaleFactor` |
| `ZOOM_PAUSE_BELOW` | 0.25 | zoom canvas di bawah ini = `stopScreencast`, tampilkan frame terakhir |
| `LEASE_TTL_MS` | 60_000 | lease agent tanpa aktivitas kembali ke human |
| `HUMAN_IDLE_MS` | 5_000 | `handoff` ditolak 409 bila manusia berinteraksi dalam jendela ini |
| `SNAPSHOT_MAX_CHARS` | 60_000 | teks snapshot dipotong + flag `truncated` |
| `SCREENSHOT_MAX_BYTES` | 2_097_152 | di atas ini: turunkan kualitas, lalu `413 too_large` |
| `COOKIE_BODY_MAX_BYTES` | 1_048_576 | batas body import |
| `COOKIE_PREVIEW_TTL_MS` | 300_000 | `previewId` kedaluwarsa |
| `DEFAULT_MAX_LIVE` / `DEFAULT_DISCARD_MS` / `DEFAULT_COOKIE_TTL_DAYS` | 3 / 300_000 / 7 | default env |

### 4.2 Env (didaftarkan WS-11 di `browser.envRegistry.ts`, grup baru `'browser'`; semua default OFF/aman)

| Kunci | Jenis | Default | Fungsi |
|---|---|---|---|
| `WEBTERM_BROWSER` | flag | off | saklar fitur utama; off = node tak muncul di menu, `/ws/browser` ditolak, `/api/browser/*` 404 |
| `WEBTERM_BROWSER_BIN` | text | kosong | path Chromium; kosong = cari lokasi umum |
| `WEBTERM_BROWSER_MAX_LIVE` | num 1..8 | 3 | batas node live |
| `WEBTERM_BROWSER_DISCARD_MS` | num | 300000 | umur sembunyi sebelum discard |
| `WEBTERM_BROWSER_AGENT` | flag | off | izinkan kendali agent (di atas toggle per node) |
| `WEBTERM_BROWSER_ALLOW_HOSTS` | text | kosong | daftar `host:port` dikecualikan dari blok privat |
| `WEBTERM_BROWSER_COOKIE_IMPORT` | flag | off | aktifkan alur import file |
| `WEBTERM_BROWSER_COOKIE_TTL_DAYS` | num | 7 | umur vault |
Kunci vault `WEBTERM_BROWSER_VAULT_KEY` (huruf kapital, cocok `KEY_SHAPE`) disimpan lewat `SecretStore`, dibuat acak 32 byte saat pertama dibutuhkan; BUKAN env yang diketik user.

### 4.3 Tipe inti (`browser.contract.ts`, ringkas; worker menulis TS lengkap)

```ts
type Lease = 'human' | 'agent'
type LiveState = 'live' | 'paused' | 'discarded'
interface BrowserNodeFields { url?: string; agentControl?: boolean }   // field baru WsNode (WS-11)
interface BrowserState { id: string; url: string; title: string; loading: boolean
  canBack: boolean; canForward: boolean; lease: Lease; live: LiveState; blocked?: BlockReason }
type BlockReason = 'scheme' | 'private_host' | 'dns_fail' | 'not_allowed_port' | 'no_binary' | 'disabled' | 'max_live'
type BrowserErrorCode = 'lease_agent' | 'lease_human' | 'human_active' | 'stale_ref' | 'no_binary'
  | 'disabled' | 'blocked' | 'not_found' | 'too_large' | 'bad_request' | 'crashed'
interface BrowserHostApi {              // dipakai gateway (WS-04), lifecycle (WS-05), agent (WS-07)
  open(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState>
  navigate(nodeId: string, url: string): Promise<void>        // lewat navigation.guard; lempar BlockedError
  setViewport(nodeId: string, w: number, h: number, dpr: number): Promise<void>
  startScreencast(nodeId: string, onFrame: (f: Frame) => void): Promise<void>
  stopScreencast(nodeId: string): Promise<void>
  ackFrame(nodeId: string, seq: number): void
  input(nodeId: string, ev: InputEvent): Promise<void>        // tidak mengecek lease; pemanggil yang cek
  cdp(nodeId: string, method: string, params?: object): Promise<unknown>  // HANYA via cdpAllowlist.ts
  discard(nodeId: string): Promise<void>                      // closeTarget, simpan url
  state(nodeId: string): BrowserState | undefined
  onState(cb: (s: BrowserState) => void): () => void
  isLoading(nodeId: string): boolean
}
```

### 4.4 WS biner `/ws/browser` (satu socket per klien, multiplex banyak node)

Server -> klien frame biner: `[0]=type (1=frame)`, `[1]=idLen`, `[2..2+idLen)=nodeId utf8`, `[..+4]=seq uint32 BE`, sisanya = JPEG mentah. Pembuat/penerjemah: `encodeFrame`/`decodeFrameHeader` di `browser.wire.ts` (ID > 255 byte ditolak).

| Arah | Pesan JSON (teks) | Perilaku |
|---|---|---|
| C->S | `{t:'attach',id,w,h,dpr}` | daftarkan penonton; host `open` bila perlu; `startScreencast` bila penonton pertama |
| C->S | `{t:'detach',id}` | hapus penonton; penonton terakhir -> `stopScreencast` |
| C->S | `{t:'ack',id,seq}` | `ackFrame`; tanpa ack tak ada frame berikut |
| C->S | `{t:'resize',id,w,h,dpr}` | `setViewport` (dpr di-clamp `DSF_MAX`) |
| C->S | `{t:'mouse',id,type:'down'\|'up'\|'move'\|'wheel',x,y,button,buttons,clickCount,mods,dx,dy}` | x,y SUDAH koordinat halaman (CSS px viewport) dari `toPagePoint`; ditolak `lease_agent` bila agent memegang lease |
| C->S | `{t:'key',id,type:'down'\|'up',key,code,text,vk,mods}` | `rawKeyDown`/`char`/`keyUp`; mods bitmask Alt=1 Ctrl=2 Meta=4 Shift=8 |
| C->S | `{t:'text',id,text}` / `{t:'ime',id,text,start,end}` | `Input.insertText` / `imeSetComposition` |
| C->S | `{t:'touch',id,type,points[]}` | `dispatchTouchEvent` |
| C->S | `{t:'nav',id,action:'go'\|'back'\|'forward'\|'reload'\|'stop',url?}` | `go` lewat penjaga navigasi |
| C->S | `{t:'copy',id}` | host `getSelection().toString()` -> balasan `copy` |
| C->S | `{t:'dialog',id,accept,text?}` | jawab `Page.handleJavaScriptDialog` |
| C->S | `{t:'takeover',id}` | human ambil lease (membatalkan agent) |
| S->C | `{t:'state',...BrowserState}` | setiap perubahan; juga saat attach |
| S->C | `{t:'dialog',id,kind,message,defaultPrompt?}` | modal webterm; dialog tak dibiarkan hang |
| S->C | `{t:'cursor',id,css}` / `{t:'copy',id,text}` | kursor CSS (throttle) / hasil salin |
| S->C | `{t:'error',id,code:BrowserErrorCode,hostname?}` | tanpa URL berquery |

Validasi: setiap pesan C->S diparse ketat (tipe, angka finite, panjang `text` <= 64 KiB); pesan jelek = `error bad_request`, bukan crash. Origin+token sudah diperiksa `allowed()` sebelum upgrade.

### 4.5 REST `/api/browser/*` (WS-08; hanya token root, node-token ditolak default)

| Metode + path | Body -> respons |
|---|---|
| `GET /api/browser/status` | -> `{enabled, binFound, version?, live, maxLive, agentEnabled, cookieImportEnabled}` |
| `POST /api/browser/:nodeId/agent-control` | `{enabled:boolean}` -> `204` (juga ditulis balik ke `WsNode.agentControl` oleh klien lewat save workspace) |
| `POST /api/browser/:nodeId/lease` | `{holder:'human'}` -> `{lease}` (ambil alih) |
| `GET /api/browser/:workspaceId/cookies/domains` | -> `{domains:[{domain,count,expiresAt?}]}` (tanpa nilai) |
| `POST /api/browser/:workspaceId/cookies/preview` | `{format:'storageState'\|'netscape',content}` (<= `COOKIE_BODY_MAX_BYTES`) -> `{previewId,domains:[{domain,count,hasSession}],expiresAt}`; konten hanya di memori |
| `POST /api/browser/:workspaceId/cookies/commit` | `{previewId,domains:string[]}` -> `{imported,domains:string[]}`; menyuntik ke profil + enkripsi ke vault |
| `DELETE /api/browser/:workspaceId/cookies` | `{domain?}` -> `204`; tanpa `domain` = hapus semua |
Kode galat: `400 bad_request`, `404 not_found|disabled`, `409 lease_*|human_active`, `413 payload_too_large`. Tidak ada endpoint yang mengembalikan nilai cookie.

### 4.6 Kontrol agent `/api/control/browser/:nodeId/:verb` (WS-07 handler; WS-11 menyambung di `control/mount.ts`)

Capability: dua verb baru `browser.read` dan `browser.act`, resource `node:<id>`. Header `Authorization`/capability mengikuti pola `control/*` yang ada [BT: nama header persis dibaca WS-07 dari `controlAuth.ts`].

| Verb URL | Capability | Body -> data |
|---|---|---|
| `status` | read | -> `BrowserState` |
| `snapshot` | read | `{}` -> `{snapId,content,truncated,url}` ; elemen berformat `[e12] button "Kirim"` |
| `screenshot` | read | `{maxWidth?}` -> `{mime:'image/jpeg',base64}` |
| `wait` | read | `{ms?<=10000,selectorRef?,loaded?:true}` -> `{ok}` |
| `navigate` | act | `{url}` -> `{ok}` / `403 blocked` |
| `click` | act | `{ref,snapId}` -> `{ok}`; `409 stale_ref` bila `snapId` basi |
| `type` | act | `{ref,snapId,text,submit?}` |
| `press` | act | `{key}` |
| `scroll` | act | `{dy}` |
| `handoff` | act | `{}` -> `{lease:'agent',ttlMs}`; `409 human_active` |
| `release` | act | `{}` -> `{lease:'human'}` |
Semua respons: `{ok:true,data,provenance:'untrusted-web'}`; `content` snapshot DIBUNGKUS penanda tak tepercaya dan tidak pernah dieksekusi. Aksi tanpa lease agent = `409 lease_human`. `agentControl` off atau `WEBTERM_BROWSER_AGENT` off = `403 disabled`.

Allowlist CDP (`browserAgent.cdpAllowlist.ts`): default-deny, wrapper TUNGGAL `callAllowed(method)`; yang diizinkan: `Page.navigate`, `Page.captureScreenshot`, `DOM.*` baca terbatas, `Accessibility.getFullAXTree`, `Input.dispatch*`, `Runtime.evaluate` HANYA dari templat internal (bukan string agent). DIBLOKIR eksplisit: `Network.getAllCookies`, `Network.getCookies`, `Storage.getCookies`, `Network.clearBrowserCookies`, `Storage.clearCookies`, `Network.setCookie(s)` dari agent, `Fetch.*`, `Browser.*`, `Target.*` (kecuali yang host pakai internal), `Page.setDownloadBehavior`. Tes struktural: grep seluruh `src/server/browser/` bahwa tak ada `.cdp(` / `send(` ke host di luar wrapper dan bahwa daftar blokir kuat.

### 4.7 Status node & lease (aturan satu tempat)

| Dari -> ke | Syarat |
|---|---|
| human -> agent | `handoff` + `agentControl` + env agent + tidak ada input human dalam `HUMAN_IDLE_MS` |
| agent -> human | `release`, `takeover` (UI), atau tak ada aktivitas `LEASE_TTL_MS` |
| lease agent aktif | input manusia ditolak `lease_agent`; node dianggap `driven` (tidak boleh discard) |
| discarded -> live | `attach` mana pun: buka target baru dari `WsNode.url` (history/scroll hilang; cookie selamat di profil) |
`shouldDiscard({loading,driven,hiddenMs,discardMs})` murni = `!loading && !driven && hiddenMs >= discardMs`; dibaca ulang saat timer menyala (salin nodeterm `browser-discard-policy.ts`).

### 4.8 Koordinat (`browser.coords.ts`)

`toPagePoint(rect:{left,top,width,height}, client:{x,y}, viewport:{w,h}) => {x,y}` = `((client.x-rect.left)/rect.width)*viewport.w` (idem y). Rect berasal dari `canvas.getBoundingClientRect()` yang SUDAH berskala; zoom tidak dibaca. `rect.width/height <= 0` -> `null` (event dibuang).

## 5. Rencana test

Runner: `TMPDIR=/tmp/st npm test` (vitest, node default, jsdom per-file via pragma) · `TMPDIR=/tmp/st bun test src/server/**/*.bun.test.ts` (Bun-only: `ws` nyata, SQLite, fs) · `TMPDIR=/tmp/st npm run typecheck`. Jebakan macOS: path unix socket > 104 char; selalu `TMPDIR=/tmp/st`. Test TIDAK menjalankan Chromium; CDP ditiru oleh `fakeCdp.testkit.ts` (WS lokal yang menjawab method yang dipakai dan memancarkan `Page.screencastFrame`).

| WS | Test wajib (assertion nyata) |
|---|---|
| 00 | `encodeFrame`/`decodeFrameHeader` roundtrip (id 0 dan 255 byte, seq 0 dan 2^32-1, id 256 ditolak); `toPagePoint` pada zoom 0.1/1/2 dan rect tergeser, rect 0 -> null; `browser.url`: tolak `file:`,`chrome:`,`javascript:`,`data:`,`view-source:`,`devtools:`, terima `http(s)`, `hostOnly('https://a.com/x?token=1')==='a.com'`; `shouldDiscard` tabel kebenaran |
| 01 | `cdp.client`: korelasi id->promise, event `on`, timeout, error CDP jadi `Error` ber-konteks (method+id), socket putus -> semua pending reject; `chromium.flags`: tak pernah memuat `--no-sandbox`, selalu `--user-data-dir` non-default, `--proxy-server` terisi; `browserHost`: `open` mengirim urutan `Target.createTarget`/`attach`/`setDeviceMetricsOverride`; ack diteruskan hanya setelah `ackFrame`; target tutup -> state `crashed`; peta input: modifier bitmask, `rawKeyDown`+`char` |
| 02 | `ssrf.ip`: tolak 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16 (metadata), 100.64/10, fc00::/7, fe80::/10, IPv4-mapped `::ffff:127.0.0.1`, 0.0.0.0; terima IP publik; `ssrf.proxy` (bun, server tujuan lokal): CONNECT ke host yang di-resolve ke loopback ditolak 403 walau nama publik (DNS stub rebinding: resolve pertama publik, kedua privat -> tetap koneksi ke IP yang sudah divalidasi), allowlist `host:port` dilewatkan, port webterm (`PORT`) tak pernah lolos meski ada di allowlist; skema non-http ditolak di `navigation.guard` |
| 03 | vault: roundtrip enkripsi, tamper 1 byte -> gagal dekripsi (bukan data korup), file mode 0600 dan dir 0700, kedaluwarsa TTL (jam injeksi), kunci hilang -> data tak terbaca dengan error ber-konteks; parser: `storageState` valid, cookies.txt Netscape (baris `#HttpOnly_`), JSON rusak -> galat tanpa membocorkan isi, batas ukuran; `cookieRedact`: keluaran hanya `{workspaceId,domains,count,action}` — tes menyuntik nilai canary dan memastikan canary tak muncul di log/galat |
| 04 | gateway (bun): attach memicu `startScreencast` sekali untuk 2 penonton; detach terakhir `stopScreencast`; tanpa `ack` frame ke-3 tidak terkirim (maxInFlight=2); `bufferedAmount` tinggi -> frame dibuang, memori tidak tumbuh; pesan malformed -> `error bad_request` dan socket hidup; `mouse` saat `lease_agent` ditolak; flag off -> upgrade ditolak |
| 05 | predikat + timer dengan jam palsu: tidak discard saat loading/driven; node ke-4 saat `MAX_LIVE=3` -> yang tersembunyi tertua di-pause/discard, bila semua terlihat -> `blocked:'max_live'`; attach ke discarded memulihkan dari url |
| 06 | jsdom: `BrowserNode` punya `nodrag nowheel nokey`; wheel non-passive + `preventDefault`; Ctrl+wheel tidak diteruskan; `keydown` Tab/Space `preventDefault`; ResizeObserver debounce -> satu `resize`; `compositionend` -> `text`; paste -> `text` tanpa Clipboard API; `stream` menggambar frame dan mengirim `ack` setelah draw; komponen tidak meng-`console.log` URL |
| 07 | lease: transisi tabel §4.7 dengan jam palsu (`HUMAN_IDLE_MS`, `LEASE_TTL_MS`); verbs terhadap `fakeCdp`: `click` dengan `snapId` basi -> `stale_ref`; `snapshot` terpotong di `SNAPSHOT_MAX_CHARS` + `truncated`; konten dibungkus penanda; allowlist struktural (§4.6) dan tes bahwa `Network.getAllCookies` ditolak; handler: tanpa capability 401/403, capability verb salah 403, `agentControl` off 403 |
| 08 | route (bun, DB/fs sementara): flag off -> 404; node-token ditolak (gerbang auth lama); `preview` tidak menulis ke disk; `commit` dengan `domains` subset hanya menyuntik subset; respons tidak pernah memuat nilai cookie (canary); `DELETE` menghapus vault; `413` untuk body > batas |
| 09 | jsdom: dialog cookie menampilkan DOMAIN + jumlah saja (canary nilai tak ada di DOM), tombol Import nonaktif sebelum pilih domain, peringatan teks jelas; chip "agent mengemudi" menampilkan Stop dan memanggil `takeover`; banner diblokir menampilkan hostname saja |
| 10 | shim: skrip hanya memuat nama env (`NODETERM_NODE_ID`,`NODETERM_PORT`), tidak ada nilai token; SKILL.md memuat peringatan konten tak tepercaya; idempoten saat ditulis dua kali |
| 11 | typecheck exhaustiveness `Record<WsNodeKind,…>`; `toFlow`/`toWsNode` roundtrip `url`,`agentControl`; `upgradeRoute('/ws/browser')` lolos hanya saat flag on; env registry memuat kunci baru dengan default off; `browser.integration.bun.test.ts`: `fakeCdp` + gateway + REST + control, skenario end-to-end tanpa Chromium; board lama (tanpa node browser) tetap termuat |
| 12 | registry memuat `browser.status` (R0) dan `browser.act` (R2) hanya bila flag on; validasi argumen; handler memakai verb kontrol (bukan CDP langsung) |

**Gerbang korektness (tiap WS sebelum lapor):** `TMPDIR=/tmp/st npm run typecheck` · `TMPDIR=/tmp/st npm test` · `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts src/server/browser/*.bun.test.ts` (glob, bukan daftar nama) · `wc -l`/`wc -m` file yang disentuh dalam batas Rule 8 · grep canary secret/PII di log. Orkestrator memverifikasi `git diff` (laporan worker bisa fiktif).

**Uji manual butuh manusia (JANGAN diklaim lulus oleh worker/orkestrator):**
1. Chromium nyata terpasang: node terbuka, halaman render, klik/ketik/scroll akurat pada zoom 0.3/1/2 dan setelah pan; tombol Back/Forward.
2. Login situs nyata, restart server, login bertahan (profil persisten).
3. SSRF: buka `http://127.0.0.1:<PORT>`, `http://169.254.169.254`, `http://[::1]`, host DNS-rebinding uji -> semuanya diblokir; domain publik jalan; allowlist dev server jalan.
4. Agent mengemudi: handoff, chip tampil, input manusia terkunci, Stop/ambil alih bekerja, TTL kembali ke human.
5. Hibernate: sembunyikan node >5 menit (set env kecil), kembali -> dipulihkan; batas live 3.
6. Import cookie: preview menampilkan domain saja, commit subset, log server tidak memuat nilai (grep manual), hapus vault.
7. Remote lewat TLS proxy + token: `wss://` jalan, copy ke clipboard (secure context), IME/paste, perangkat sentuh.
8. Beban: 3 node live + video; ukur CPU/RAM/bandwidth (angka `[BT]` di R&D belum terukur).
