# 34-b — Browser streaming: opsi B-E, keamanan, dependency, implikasi

Lanjutan `34-BROWSER-STREAMING-ARSITEKTUR-a.md` (fakta repo §1 dan opsi A §2). Label: fakta / `[opini]` / `[BT]` belum terverifikasi.

## 3. Opsi B — WebRTC/VNC (noVNC, KasmVNC, Xpra, Neko)

Browser berjalan di desktop virtual (Xvfb/Wayland di container); gambar dikirim sebagai video/RFB.

| Proyek | Lisensi & status (GitHub API, 2026-11-03) | Transport | Catatan |
|---|---|---|---|
| noVNC | inti MPL-2.0 (LICENSE.txt), push terakhir 2026-10-23; release v1.7.0 2026-04-28 | RFB di WebSocket | Klien JS bisa di-embed ke node (`<canvas>`); butuh server VNC + Xvfb |
| KasmVNC | **GPL-2.0**, aktif 2026-11-02 | RFB+WebP, WS | Copyleft kuat → jalankan sebagai proses terpisah saja; proyek webterm BUSL-1.1 `[opini: konsultasikan]` |
| Xpra | **GPL-2.0**, aktif 2026-11-02 | protokol sendiri, HTML5 client | Window per aplikasi (bukan seluruh desktop) — cocok teorinya, berat operasional |
| Neko (m1k1o) | Apache-2.0, aktif 2026-10-28 | **WebRTC** (video+audio), multi-user | Satu container per browser; README: "virtual browser WebRTC… multiple users" |

| Aspek | A (CDP) | B (WebRTC/VNC) |
|---|---|---|
| Audio | tidak ada | ada (Neko/WebRTC) |
| Latensi/FPS | baik untuk UI, video sedang | terbaik (H.264/VP8) untuk video |
| Platform | Chromium apa saja (macOS dev OK) | praktis **Linux/Docker**; macOS desktop VNC mengirim seluruh layar, bukan per-window `[opini]` |
| Remote | satu port HTTP/WS (ikut TLS proxy webterm) | WebRTC butuh UDP/TURN/ICE → sulit di balik proxy |
| Resource per node | 1 page | 1 desktop + Chromium + encoder (jauh lebih berat; container per node) |
| Agent | CDP asli, DOM/AX | tetap perlu CDP di browser dalam container (Neko/Chromium bisa dipasangi `--remote-debugging-port` `[BT]`) → arsitektur ganda |
| Auth ke webterm | otomatis (gate yang sama) | layanan kedua dengan auth sendiri → celah |
| Hit-testing di canvas ber-scale | rumus §2.2 | sama (rect-based), tapi RFB/WebRTC video punya letterbox/aspect → hitung sendiri |
| Dependency baru | 0 | Docker/Xvfb/Neko = infrastruktur baru, lisensi GPL (Kasm/Xpra) |

`[opini]` Pakai B hanya sebagai **fase lanjutan opsional** bila audio/video berat jadi kebutuhan nyata ("Neko sebagai backend alternatif di balik antarmuka BrowserHost yang sama").

## 4. Opsi C — Reverse proxy + iframe

| Aspek | Penilaian |
|---|---|
| Cara | webterm mem-proxy URL target, menghapus `X-Frame-Options`/`Content-Security-Policy: frame-ancestors`, menulis ulang URL/JS/cookie; ditampilkan di `<iframe>` |
| Batas keras | Penulisan ulang JS/`fetch`/WebSocket/service worker rapuh; `top`-detection dan anti-bot/login (Google, bank) memblokir; cookie `SameSite`/pihak ketiga pecah; **tanpa CDP → agent tak bisa mengendalikan** |
| **Keamanan** | Konten asing ber-origin webterm = XSS ke localStorage/token WS dan seluruh `/api` (PTY!). Wajib origin terpisah (subdomain/port lain) + `sandbox` tanpa `allow-same-origin`. Server proxy juga SSRF langsung |
| Pustaka | Ultraviolet / Scramjet (ekosistem Titanium Network) `[BT: status, lisensi]` |
| Verdict | **Tolak** untuk "browser sungguhan". Satu pengecualian murah: node **preview** `<iframe sandbox>` untuk dev server milik user yang memang tak mengirim XFO — bukan browser, tak butuh server tambahan, tapi dari mesin jarak jauh `localhost:5173` tak terjangkau tanpa proxy path `[BT]` |

## 5. Opsi D — Ekstensi / bridge ke browser lokal user

Ekstensi MV3 memakai `chrome.debugger` (CDP ke tab user) atau `tabCapture`, merelay screencast + input via WS ke webterm.

| Pro | Kontra |
|---|---|
| Profil asli, login & cookie sudah ada (tanpa impor — kurangi risiko dokumen 33) | Pengguna harus memasang ekstensi; Chrome menampilkan infobar "sedang di-debug" `[BT]` |
| Fidelity & performa = browser asli user | Tab tetap di jendela user — canvas hanya cermin; remote webterm → ekstensi menyambung ke server publik (auth/konsen) |
| Playwright MCP & Claude in Chrome sudah memakai pola ini `[BT: lihat dok 32]` | Layanan worker MV3 ditidurkan; review store; hanya Chromium-family |

`[opini]` Fase 3: "Attach tab lokal" sebagai sumber alternatif untuk `BrowserHost`, memakai kontrak frame/input yang sama dengan opsi A (ekstensi menggantikan Chromium terkelola).

## 6. Opsi E — Shell Electron/Tauri (paritas nodeterm)

| Aspek | Penilaian |
|---|---|
| Electron `<webview>` | Paritas terdekat (nodeterm: `BrowserSurface.tsx`, partition, discard) — fakta repo referensi |
| Masalah | webterm sengaja **web channel** (server Bun + browser biasa, bisa jarak jauh). Shell Electron memaksa instalasi desktop dan memutus model "buka dari mana saja"; binary jadi ganda (`build:binary` sekarang `bun --compile`) |
| Tauri | Webview anak bersifat native overlay, tidak ikut `scale()` DOM React Flow → pemetaan zoom/pan tak bisa dengan CSS `[BT]`; fitur multi-webview berlabel unstable `[BT]` |
| Verdict | Di luar jalur utama. Bila kelak ada shell desktop, `BrowserHost` lokal (opsi A tanpa jaringan) tetap lebih sederhana daripada `<webview>` |

## 7. Keamanan (khusus opsi A, berlaku A/B/D)

| Risiko | Mitigasi (konkret) |
|---|---|
| **SSRF**: Chromium di host server menjangkau `127.0.0.1:8700` (webterm sendiri!), metadata cloud `169.254.169.254`, LAN | Jalankan Chromium via `--proxy-server` ke proxy penyaring lokal yang me-resolve DNS sendiri & menolak rentang privat/loopback/link-local (menutup DNS-rebinding); `--proxy-bypass-list=<-loopback>` agar localhost tidak lolos bypass bawaan `[BT: semantik flag]`. Daftar izin eksplisit (allowlist) untuk "dev server lokal" per node. Cegat `Fetch.enable` hanya sebagai lapis ke-2 (tak melihat IP). Lebih kuat: netns/container tanpa rute internal |
| `file://`, `chrome://`, `view-source:`, `devtools://` | Tolak skema selain `http/https` di tahap navigasi (`Page.navigate` + `Page.frameNavigated`/`Fetch`); jangan mengandalkan flag Chromium saja |
| Port CDP mentah | `--remote-debugging-pipe` bila memungkinkan, atau port acak loopback; bocor = kendali penuh browser **+ cookie**. Chrome ≥136 mengabaikan `--remote-debugging-port` pada data-dir default; wajib `--user-data-dir` non-default (developer.chrome.com/blog/remote-debugging-port) → untungnya sejalan dengan profil terkelola, **jangan** pernah menunjuk profil Chrome asli user |
| Sandbox Chromium | Jangan `--no-sandbox`; jalankan sebagai user non-root; di container butuh `--cap`/seccomp yang sesuai `[BT]` |
| Auth & origin | Jalur `/ws/browser` melewati `allowed()` yang sama (origin + token); token tak boleh di URL halaman yang dimuat; per-node token tidak boleh membuka endpoint browser (root/capability saja) |
| Halaman memengaruhi agent (prompt injection) | Konten halaman = data tak tepercaya; verb agent mengembalikan teks terbungkus & ditandai; aksi sensitif (kirim form di domain berbeda) lewat gerbang persetujuan yang sudah ada (`approvalHuman*`) `[opini]` |
| Clipboard/download | Download ke folder terkurung bernama-aman; clipboard hanya lewat aksi pengguna eksplisit |
| Kebocoran log | Jangan log URL berquery/ cookie/ frame; hanya hostname (Rule 12) |

## 8. Dependency (Rule 10, diverifikasi 2026-11-03)

| Kandidat | Lisensi/aktif | Putusan |
|---|---|---|
| **Klien CDP mentah di atas `ws`** (sudah dependency) | — | **Pilih.** Inti ≈ 40-60 baris: `send(method,params,sessionId)` dengan map id→promise, `on(event)`. Menutup kebutuhan MVP (screencast, input, navigasi). Lebih dari 20 baris tapi tanpa dependency baru, tanpa install ~100 MB browser |
| `puppeteer-core` | Apache-2.0, rilis 2026-11-02, pptr.dev 25.16.0 | Ditunda. Berguna bila agent-driver butuh locator/auto-wait; jangan di jalur streaming |
| `playwright-core` | Apache-2.0, v1.64.1 (2026-10-14), push 2026-11-03 | Ditunda; agent eksternal boleh memakainya lewat proxy CDP kita |
| `chrome-remote-interface` | MIT, push terakhir **2026-02-09** (±9 bln) | Tidak perlu (hanya pembungkus WS CDP) |
| Chromium binary | bukan npm | **Tidak dibundel.** Deteksi `WEBTERM_BROWSER_BIN` / lokasi umum; absen → node menampilkan pesan pemasangan. `[BT]` Chrome 132+ memisahkan headless-shell; gunakan `--headless=new`/binary headless-shell |
| noVNC (MPL-2.0) / Neko (Apache-2.0) | aktif | Hanya fase opsional B |

## 9. Implikasi untuk webterm

**Rekomendasi tegas:** Opsi **A** (Chromium terkelola server-side + CDP screencast + input forwarding via klien CDP mentah di `ws`), satu `BrowserHost` di server dengan antarmuka `attach/detach/frame/input/lease` agar sumber lain (D ekstensi, B Neko) bisa dicolokkan kelak. Tolak C sebagai "browser". E hanya bila ada permintaan desktop eksplisit.

**MVP bertahap (tiap fase = branch `feature/` + test nyata, Rule 2-3):**

| Fase | Isi | Bukti/test |
|---|---|---|
| 0 | `WsNodeKind += 'browser'`, field `url?`; `BrowserNode` placeholder (`nodrag nowheel nokey`); validasi skema URL (`http/https` saja) | vitest jsdom + typecheck |
| 1 | `BrowserHost` (spawn Chromium headless + klien CDP mentah), `/ws/browser` biner (tambah di `upgradeRouting`), screencast + ack + backpressure, mouse/wheel/keyboard/paste, pemetaan koordinat §2.2, `ResizeObserver`→viewport. Satu browser, tanpa profil persisten, **proxy SSRF wajib sejak awal** | `bun test` server (CDP tiruan via `ws` lokal, tanpa Chrome asli); vitest unit untuk fungsi `toPagePoint(rect, client, viewport)` pada beberapa nilai zoom |
| 2 | Hibernate 3-tingkat (salin `shouldDiscard`), batas live node, dialog/popup/unduhan, kursor, IME, copy | test predikat murni + bun test |
| 3 | Agent: lease + `/api/control/browser/*` (capability) dan/atau proxy CDP; chip "agent mengemudi"; profil persisten + impor cookie (dokumen 33) | test kontrak control API; uji manusia-vs-agent |
| 4 (opsional) | Ekstensi lokal (D) atau Neko (B) di balik `BrowserHost` yang sama | — |

**Risiko utama:** (1) SSRF/akses localhost — blocker keamanan sebelum fase 1 dirilis; (2) tanpa audio; (3) memori Chromium per node tanpa batas; (4) fokus/keyboard bentrok dengan shortcut React Flow & aplikasi; (5) API screencast berstatus *experimental* di CDP (bisa berubah; kunci versi Chromium yang diuji).

**Belum terverifikasi `[BT]` (butuh uji nyata, dilarang sekarang):** angka latensi/bandwidth/FPS/RAM; multi-klien CDP + multi-screencast per target; semantik `--proxy-bypass-list=<-loopback>`; nama persis command unduhan/file chooser; perilaku WebGL headless tanpa GPU; apakah `Overlay.highlightNode` cocok untuk highlight agent; Tauri/Electron `<webview>` di bawah `scale()` DOM; status/lisensi Ultraviolet & Scramjet; infobar `chrome.debugger`; `SingletonLock`.
