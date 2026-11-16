# 32 - Browser yang dikendalikan AI agent (landscape 2026-11)

Topik 2 dari R&D "browser sungguhan di canvas webterm". Tanggal verifikasi: **2026-11-03**.
Label: fakta = ada sumber/URL; `[opini]` = penilaian saya; `[BT]` = belum terverifikasi dari sumber primer.
Dokumen saudara: 31 (referensi eksternal), 33 (cookie), 34 (streaming). Di sini fokus: **siapa mengendalikan browser, lewat protokol apa, dan apakah manusia + agent bisa berbagi satu browser**.

## 0. Ringkasan (5 baris)

1. **CDP (Chrome DevTools Protocol) adalah protokol dominan.** Playwright (Chromium), Puppeteer, browser-use (`cdp-use`), Stagehand v3, agent-browser, Steel, Chrome DevTools MCP, ekstensi (`chrome.debugger`), dan ego-browser (`page.cdp()`) semuanya bermuara ke CDP.
2. **Model kontrol dominan = accessibility snapshot + ref** (`@e1`, `ref_2`, `uid`), bukan screenshot. Screenshot+koordinat tinggal untuk canvas/game/vision-only (computer use, Skyvern, Midscene).
3. **"Manusia + agent satu browser"** sudah dipecahkan 4 cara: (a) browser milik user + izin (ego, Claude in Chrome, ekstensi), (b) CDP attach ke Chrome user (`--autoConnect`), (c) live view yang bisa diklik (Browserbase, Browser Use Cloud, Steel, agent-browser `stream`, `playwright-cli show`), (d) VNC/WebRTC (Skyvern noVNC, Neko). Webterm cocok dengan (c).
4. **Rekomendasi:** webterm jadi *browser host* — satu Chromium terkelola per node, satu endpoint CDP per node (loopback + token) — yang dipakai dua klien: node canvas (screencast + input) dan agent eksternal (Playwright MCP / agent-browser / Chrome DevTools MCP / browser-use lewat `--cdp`). Jangan bangun agent browser sendiri.
5. Risiko terbesar: CDP = kendali penuh (cookie semua konteks, `file://`, unduhan) dan prompt injection dari halaman. Lihat bagian 6.

## 1. Taksonomi

| Sumbu | Pilihan | Contoh |
|---|---|---|
| Koneksi | (1) Launch browser sendiri | Playwright MCP default, agent-browser default (Chrome for Testing), browser-use lokal |
| | (2) Attach CDP ke browser yang berjalan | `--cdp-endpoint`, `--cdp`, `--wsEndpoint`, `--autoConnect` |
| | (3) Ekstensi di browser user | Playwright Extension, Browser MCP, Claude in Chrome, Nanobrowser |
| | (4) Browser khusus agent (Chromium fork + layanan kontrol) | ego (lite) |
| | (5) Cloud browser (CDP URL + live view) | Browserbase, Browser Use Cloud, Steel Cloud, Browserless |
| Observasi | A11y tree + ref | Playwright MCP, CDT MCP, agent-browser, ego, Claude `browser_toolset` |
| | Screenshot + koordinat | Claude/Gemini computer use, Skyvern (vision), Midscene |
| | Bahasa alami `act/observe/extract` | Stagehand |
| | Agent menulis kode/skrip | Browser Harness, ego (`ego-browser nodejs`) |

## 2. Tabel utama (fakta dari GitHub API / npm / PyPI / docs, 2026-11-03)

| Item | Arsitektur | Kontrol | Lisensi | Rilis terakhir (push terakhir) | Embed / stream tampilan |
|---|---|---|---|---|---|
| **browser-use** (lib) | Python; dep `cdp-use==1.4.5`, **tanpa playwright** di `pyproject.toml`; browser lokal/cloud/CDP remote | LLM loop; DOM/a11y + screenshot `[BT detail serialisasi]` | MIT | 0.13.14, 2026-10-26 (2026-11-02) | Cloud: live preview URL + human-in-the-loop (docs.browser-use.com/llms.txt); lokal: tak ada |
| **Browser Harness** (browser-use) | Skill + CLI; CDP ke Chrome user; MCP opsional | Agent menulis helper Python | MIT | v0.1.13, 2026-09-04 (2026-11-02) | Tidak ada (pakai Chrome user) |
| **Browser Use Cloud** | SaaS; browser CDP + agent API v4 | agent hosted / CDP | proprietary SaaS `[BT]` | $0.02/jam (README) | Live view + takeover + rekaman |
| **ego (lite) / ego-browser** | Chromium fork (lokal 0.6.2.5, chromium 156.0.8078.74) + layanan CLI; macOS | REPL `ego-browser nodejs`: a11y snapshot `@N`, selector, `mouse/keyboard`, `page.cdp()` | gratis, closed `[BT lisensi]` (Citro Labs) | skill guide v2.2.0, 2026-10-16 | Jendela browser asli; kursor agent + label terlihat |
| **Playwright MCP** | Node; Playwright; stdio / HTTP(SSE) `--port` | A11y snapshot; `--caps vision,pdf,devtools` | Apache-2.0 | v0.0.84, 2026-10-31 (2026-11-01) | `--extension` (tab user), `--cdp-endpoint`; tanpa viewer |
| **Playwright CLI** (`@playwright/cli`) | CLI + skills, token-hemat | perintah shell; `state-save/load`, `cookie-list` | Apache-2.0 | v0.1.23, 2026-10-31 | **`playwright-cli show`**: dashboard grid screencast hidup + kendali manual |
| **Stagehand** (Browserbase) | TS SDK v4.3.0 (npm 2026-10-20), dep npm: zod, @browserbasehq/sdk, otel, **tanpa playwright**; python SDK | `act/observe/extract` bahasa alami + `agent`; selector nyata kembali ke kode | MIT | stagehand-server-v3/v3.7.7, 2026-10-23 | lokal `localBrowser.launch({userDataDir})` atau Browserbase |
| **Browserbase** | SaaS cloud; session + **Contexts** (cookie/auth persisten) | CDP ke Playwright/Puppeteer/Stagehand | proprietary SaaS `[BT]` | n/a | **Live View interaktif** (`debuggerFullscreenUrl`, bisa di-embed, desktop+mobile) |
| `browserbase/mcp-server-browserbase` | MCP resmi | - | Apache-2.0 | v3.0.0 2026-03-31; **repo diarsipkan** | - |
| **Steel** (`steel-browser`) | Fastify + Puppeteer + CDP; Docker; REST sessions; stealth/proxy/ekstensi | Playwright/Puppeteer/Selenium connect ke CDP | Apache-2.0 | v0.5.5-beta, 2026-10-31 (2026-11-02) | UI session viewer: `Page.startScreencast` + `Input.dispatchMouseEvent/KeyEvent` lewat WebSocket (`api/src/plugins/browser-socket/casting.handler.ts`) |
| **agent-browser** (Vercel Labs) | CLI Rust + daemon, CDP; Chrome for Testing; engine Lightpanda/Obscura; provider cloud | `snapshot -i` + `@e1`; `stream`, `dashboard`, `state`, `auth`, `confirm/deny` | Apache-2.0 | v0.41.1, 2026-11-01 (2026-11-03) | **WebSocket stream** frame JPEG + terima input; "pair browsing" (docs agent-browser.dev/streaming) |
| **Chrome DevTools MCP** (Google) | Node + Puppeteer; MCP + CLI; `--wsEndpoint` (+header), `--browserUrl`, `--autoConnect` | uid dari snapshot; trace/network/console/Memory/WebAuthn | Apache-2.0 | v1.12.0, 2026-10-22 | Tidak ada; Chrome resmi saja; **statistik penggunaan dikirim ke Google** (opt-out) |
| **Browser MCP** (`BrowserMCP/mcp`) | Ekstensi + daemon; Playwright via ekstensi (`debugger`) | MCP `browser` tool | Apache-2.0 | tanpa GitHub release (push 2026-11-03) | Chrome user, tab sendiri |
| **Claude in Chrome** | Ekstensi + native messaging host; Chrome/Edge (+Brave/Arc/Vivaldi/Opera terdeteksi) | Claude Code / panel samping | closed | n/a | Jendela Chrome user; **tab group** milik sesi; jeda di login/CAPTCHA (code.claude.com/docs/en/chrome) |
| **Anthropic `browser_toolset_20260801`** | Toolset client-side: 27 tool (navigate, read_page, left_click, screenshot, ...) dijalankan executor *milikmu*; tak ada di Managed Agents | a11y ref `ref_N` **dan** koordinat viewport | API | docs | Terserah executor |
| **Anthropic `computer_toolset_20260801`** | 17 tool; screenshot + koordinat; desktop penuh | vision | API | docs | VM/container milikmu |
| **Gemini Computer Use** | Tool client-side; screenshot + aksi; safety policy + opt-in scan prompt injection (ai.google.dev/gemini-api/docs/computer-use) | vision | API | docs | executor milikmu |
| **Skyvern** | Python; Playwright-compatible SDK + vision LLM + workflow builder; SQLite/Postgres | vision + DOM | **AGPL-3.0** | v1.0.56, 2026-10-14 (2026-11-03) | **noVNC** untuk takeover manusia (`skyvern-frontend/src/util/novncGestureCrashGuard.ts`) |
| **Midscene** | TS; vision-first; dep `puppeteer-core` | screenshot -> aksi | MIT | v1.17.5, 2026-11-02 | playground lokal |
| **Nanobrowser** | Ekstensi Chrome multi-agent `[BT arsitektur]` | - | Apache-2.0 | v0.3.0, 2026-10-15 | di dalam browser |
| **Lightpanda** | Browser baru (Zig), bukan Chromium; CDP server | CDP | **AGPL-3.0** | 1.0.2, 2026-10-23 | tanpa render visual `[BT]` -> tak bisa screencast |
| **Browserless** | Chromium-as-a-service, CDP/Playwright | - | `NOASSERTION` di GitHub; cek sendiri `[BT]` | v2.58.2, 2026-11-02 | live debugger `[BT]` |
| **Neko** (`m1k1o/neko`) | Desktop virtual + browser, **WebRTC**, multi-user | manusia (bukan agent) | Apache-2.0 | v3.2.0, 2026-10-15 | WebRTC |
| **KasmVNC** | VNC web (noVNC fork) | manusia | GPL-2.0 | v1.5.2, 2026-10-24 | HTML5 |
| Puppeteer / Playwright (lib) | CDP (+WebDriver BiDi di Puppeteer: dep `chromium-bidi`) | API kode | Apache-2.0 | puppeteer-core 25.16.0 (2026-10-22); playwright-core 1.64.1 (2026-10-14) | - |

Catatan status: tidak ada item di atas yang tampak mati; satu-satunya repo arsip = `mcp-server-browserbase`. Stars (indikator minat, bukan mutu): browser-use ~120k, Playwright ~99k, Puppeteer ~96k, Chrome DevTools MCP ~55k, agent-browser ~45k, Lightpanda ~41k, Playwright MCP ~39k, Stagehand ~26k, Skyvern ~23k, Neko ~23k.
OpenAI computer-use/Operator, Perplexity Comet, Google Mariner: `[BT]` — tidak diverifikasi (halaman docs OpenAI tak terbaca lewat fetch).

## 3. Human + agent berbagi satu browser (inti pertanyaan)

| Pola | Mekanisme (fakta) | Isolasi | Cocok canvas webterm? |
|---|---|---|---|
| **ego TaskSpace** | `taskSpace(name)`; agent hanya menyentuh tab miliknya; `task.handOff()`, `waitForControl()`, `takeOverTaskSpace()`, `userPage()`; tab tanpa label = "unmanaged", harus `adopt`; berhenti bila user mengambil alih | Per-space; tab user dilindungi | Model *kontrak* yang patut ditiru (lease kendali), bukan kodenya |
| **Playwright Extension** | Pilih tab; klien dapat tab group sendiri, hanya lihat tab di grupnya; dialog persetujuan, bisa dilewati dengan `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | Per tab-group | Tidak (butuh Chrome desktop user) |
| **CDP attach Chrome user** | `--autoConnect` (Chrome **144+**): user aktifkan di `chrome://inspect#remote-debugging`, tiap sesi muncul dialog izin + banner "dikendalikan software otomatis" (developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session). Server melihat **semua jendela profil itu** (README Browser Harness) | Tidak ada | Tidak (lokal) |
| **Claude in Chrome** | Ekstensi; tab group sesi; izin per situs; jeda saat login/CAPTCHA | Per tab group | Tidak |
| **Live view cloud** | Browserbase `debuggerFullscreenUrl` (iframe interaktif; use-case: HITL, credential, upload); Browser Use Cloud "open live browser, take over, continue same session" | Per sesi | Ya sebagai *UX referensi* |
| **agent-browser `stream`** | WS per sesi, frame JPEG (1280x720: q80 ~54 KB/frame, q20 ~25 KB, q20@640x360 ~9 KB); terima mouse/keyboard/touch; origin klien harus localhost/127.0.0.1/::1/file:// (selain itu 403 -> perlu proxy) | Per sesi | **Ya, paling dekat** |
| **Playwright CLI `show`** | Dashboard: grid sesi dengan screencast + detail view dengan tab bar dan kendali manual | Per sesi | Ya (UX multi-node = grid sesi) |
| **Steel session viewer** | WS: screencast keluar, `mouseEvent`/`keyEvent` -> `Input.dispatch*` | Per sesi | **Ya, kode referensi opsi A (doc 34)** |
| **VNC / WebRTC** | Skyvern noVNC; Neko WebRTC | Per desktop | Opsi B (doc 34), berat |

Pelajaran: yang menjaga manusia dan agent tak saling menimpa bukan teknologi stream, melainkan **aturan kepemilikan** (ego: berhenti saat user ambil alih; Playwright Extension: grup per klien; agent-browser: `confirm/deny`).

## 4. Catatan per item penting

**ego-browser (terpasang di mesin ini; hanya `--version`, `help`, `skill` dibaca):**
- `ego-browser 0.6.2.5`, chromium 156.0.8078.74, node v24.22.1. Subcommand: `import list|--browser`, `skill`, `upgrade`, `nodejs -e`, `--ego-server-name=<name>` (pilih "layanan browser" bernama -> beberapa instans).
- Skrip agent jalan di Node tertanam; API kecil **bukan Playwright** (`click/fill/press/snapshot/screenshot/goto/waitFor*/evaluate/fetch/cdp`); instruksi eksplisit: jangan impor Playwright. Satu skrip bisa merangkai banyak langkah (kurangi round-trip) dan diakhiri `snapshot`.
- Snapshot = a11y tree dengan ref `@N`; locator `loc=role:`, `loc=css:`, `text=`, xpath. Aksi menolak target ambigu (harus tepat 1 match).
- Satu **TaskSpace** per tujuan user; nama unik; halaman berlabel permanen `p1,p2..`; ada anggaran halaman; `finish({keep})` menutup.
- Bukti desain anti-deteksi: sesi halaman menyembunyikan console dari CDP; `egoAutomated.disable` mematikannya (situs bisa mendeteksi CDP lagi).
- Kursor agent + label 3-6 kata terlihat untuk aksi pointer (transparansi bagi manusia).
- `import --browser chrome|edge|brave|comet|opera|vivaldi|yandex|firefox|zen|arc|dia [--profile ...]` mengimpor profil (bahas di doc 33). `--clear-existing-profiles` merestart Ego.
- Hanya macOS (`references/install.md`); lisensi/sumber `[BT]` (situs: lite.ego.app, "Built by Citro Labs", gratis).
- Relevansi webterm: **bukan** kandidat embed (jendela native, closed), tetapi *API kontrak* (TaskSpace, handOff, label, ref) = desain yang layak ditiru.

**Playwright MCP / CLI:** pindah arah resmi ke CLI+SKILLS untuk coding agent karena hemat token (README Playwright MCP). Opsi relevan: `--cdp-endpoint`, `--cdp-header`, `--isolated`, `--storage-state`, `--user-data-dir`, `--shared-browser-context` (klien HTTP berbagi konteks), `--allowed-origins/--blocked-origins` ("**bukan batas keamanan**", tak memengaruhi redirect), `--allowed-hosts`, file `file://` diblokir default. Profil persisten hanya bisa dipakai satu instans.

**agent-browser:** daemon per `--session`, tutup otomatis 1 jam idle. Keamanan opt-in (default **tanpa batasan**): auth vault (password tak masuk konteks LLM), domain allowlist, action policy, `--content-boundaries` (penanda nonce untuk memisahkan output tool dari konten halaman; diakui "defense-in-depth"), konfirmasi otomatis-tolak setelah 60 dtk, non-TTY auto-deny. Config proyek `./agent-browser.json` hanya menerima kunci aman (trust filter).

**Chrome DevTools MCP:** dukung resmi hanya Chrome/Chrome for Testing; `--wsEndpoint` + `--wsHeaders` (mis. `Authorization: Bearer`) cocok bila endpoint CDP webterm di balik token; "mengekspos isi browser ke klien MCP".

**Anthropic:** `browser_toolset_20260801` = executor milik aplikasi (nothing runs on Anthropic's side); screenshot tak di-downscale API (harus ukuran konsisten, skala balik koordinat); handler `navigate` wajib tolak skema selain http/https; rekomendasi: kontainer minim hak, profil kosong, allowlist domain di lapisan jaringan + cek ulang setelah redirect, blok loopback/link-local/private, `javascript_exec` & `file_upload` default mati, konfirmasi manusia sebelum aksi konsekuensial (cek di executor *sebelum tiap panggilan*, karena satu giliran bisa memuat banyak).

## 5. Benchmark (vendor, berbias)

Browser Use menjalankan 100 dari 200 tugas BU Bench V2.1 (README browser-harness, diukur 2026-10-14; satu agen Codex, semua alat memakai browser cloud yang sama): Browser Harness 60.4, Playwright MCP 0.0.83 60.0, Chrome DevTools MCP 1.10.1 61.0, agent-browser 0.39.1 56.3 (skor rubrik 0-100); **semua selisih berpasangan CI 95% mencakup nol**. Median token input: 2.1M / 4.4M / 6.7M / 3.3M. Kesimpulan yang sah: *skor setara; biaya token berbeda*; pembuat benchmark = pembuat salah satu alat -> `[opini]` anggap indikatif.

## 6. Keamanan

| Ancaman | Fakta | Mitigasi yang dipakai pihak lain |
|---|---|---|
| Prompt injection dari halaman | Diakui semua vendor (Anthropic: classifier + steer; Gemini: scan opt-in; agent-browser: content boundary) | Pisahkan konten halaman dari instruksi; baca dari a11y/teks render, bukan DOM mentah; konfirmasi manusia untuk aksi konsekuensial; akun berhak minimal |
| CDP = kendali penuh | `Browser.*`, `Storage.*`, `Fetch`, `Page.setDownloadBehavior`; CDT MCP: "inspect, debug, modify any data" | Endpoint loopback + token; jangan bagikan URL CDP; pertimbangkan proxy yang menyaring method `[opini]` |
| Chrome profil asli | Sejak **Chrome 136**, `--remote-debugging-port/pipe` **diabaikan pada data dir default**; wajib `--user-data-dir` non-standar (kunci enkripsi berbeda) (developer.chrome.com/blog/remote-debugging-port). Chrome 144+: `--autoConnect` dengan dialog izin | Pakai profil terkelola terpisah |
| SSRF / jaringan internal | Anthropic: blok loopback/link-local/private di jaringan | Allowlist di lapisan jaringan, bukan di prompt |
| Deteksi otomasi | ego menyembunyikan CDP console; Steel/Browser Use jual stealth | Di luar scope MVP |
| Telemetri | CDT MCP kirim usage stats ke Google (opt-out `--no-usage-statistics` `[BT nama flag]`) | Matikan bila dipakai |
| Lisensi | Skyvern & Lightpanda **AGPL-3.0**; webterm **BUSL-1.1** | Jalankan sebagai proses terpisah milik user, jangan di-bundle `[opini, bukan nasihat hukum]` |

## 7. Implikasi untuk webterm

**Rekomendasi tegas**
1. **Satu protokol kontrol: CDP di atas WebSocket.** Semua alat agent yang relevan (Playwright MCP `--cdp-endpoint`, agent-browser `--cdp`, Chrome DevTools MCP `--wsEndpoint`, browser-use/Browser Harness via CDP URL, Stagehand) bisa attach. Ini membuat webterm *agent-agnostic*; tak perlu SDK.
2. **Webterm = browser host, bukan agent.** Server Bun: spawn Chromium (profil terkelola `--user-data-dir` di bawah `WEBTERM_DATA_DIR`, bukan profil asli user - wajib sejak Chrome 136), simpan CDP port loopback, dan buka proxy WS terautentikasi per node. Dua klien: (a) UI node: `Page.startScreencast` (+`screencastFrameAck`) -> WS -> `<canvas>`/`<img>`, input via `Input.dispatchMouseEvent/KeyEvent/insertText` (pola Steel + agent-browser; `dispatchMouseEvent`/`dispatchKeyEvent` non-eksperimental, tetapi `startScreencast`, `screencastFrameAck`, `insertText`, `imeSetComposition` berstatus *experimental* di browser_protocol.json - risiko drift); (b) agent eksternal lewat proxy CDP.
3. **Auth endpoint CDP memakai skema token node yang sudah ada** (`x-webterm-node-token` / `WEBTERM_NODE_ID`, nama protokol baku), sehingga agent di terminal node (Claude Code, Codex) otomatis dapat URL CDP node-nya lewat env. Nama env baru = keputusan desain `[opini]`.
4. **Lease kendali** (tiru ego `handOff/waitForControl`): state per node `controller: human|agent|none`; UI menampilkan siapa yang pegang; saat manusia mengetik/klik, agent diberi sinyal berhenti atau input agent ditunda; kursor/label agent di overlay (ego: label 3-6 kata).
5. **Dependency (Rule 10):** CDP itu JSON-RPC ~ <200 baris di Bun (WebSocket native); host tidak butuh `puppeteer-core` (25.16.0, dep `ws`, `chromium-bidi`, ...) maupun `playwright-core`. Biarkan agent membawa Playwright/Puppeteer sendiri. Pertimbangkan `chrome-remote-interface` 0.34.0 hanya bila malas menulis klien (rilis terakhir 2026-02-09).
6. **Jangan** embed ego/Skyvern/Lightpanda: ego closed + macOS, dua lainnya AGPL. Boleh didokumentasikan sebagai klien opsional.
7. **Default aman:** blok skema selain http/https, blok private/loopback/link-local/metadata di lapisan jaringan (proxy keluar), `file://` mati, unduhan ke direktori terisolasi per node, `javascript_exec`/upload tak diekspos ke agent tanpa opt-in, konfirmasi manusia untuk aksi konsekuensial, token CDP tak pernah dicatat di log (Rule 7/12).

**Risiko**
- Banyak klien CDP pada satu target: dua `Emulation.setDeviceMetricsOverride` atau dua screencast saling menimpa viewport/fokus; satu pemilik viewport (node) `[opini]`.
- Memori Chromium per node (angka: doc 34); butuh discard/hibernate seperti referensi eksternal.
- Playwright MCP `--allowed-origins` bukan batas keamanan; allowlist harus di proxy webterm.
- Pergeseran tool: Playwright MCP sendiri menyarankan CLI+SKILLS untuk coding agent; versi MCP masih `0.0.x` (belum stabil).

**Belum terverifikasi `[BT]`**
- Lisensi/sumber ego (lite); lisensi Browserless & Browserbase/Browser Use Cloud (SaaS); arsitektur Nanobrowser; kemampuan screenshot Lightpanda.
- Serialisasi observasi browser-use (DOM vs a11y vs vision) di v0.13.
- Detail OpenAI CUA/Operator, Perplexity Comet, Google Mariner; flag opt-out telemetri CDT MCP.
- Perilaku multi-klien CDP pada satu target (konflik screencast/emulation) - butuh uji eksperimen, tidak dilakukan (dilarang menjalankan browser).
- Firefox: CDP dicabut dalam favor WebDriver BiDi `[BT, dari memori]`; implikasi: pilih Chromium saja untuk MVP.
