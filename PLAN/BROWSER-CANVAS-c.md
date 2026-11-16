# PLAN BROWSER-CANVAS (c) — Keamanan, rollout, risiko

Lanjutan `-a`/`-b`.

## 6. Keamanan dan aturan global

### 6.1 Model ancaman dan kontrol

| Ancaman | Kontrol (konkret) | Pemilik | Bukti |
|---|---|---|---|
| SSRF: Chromium (di host server) menjangkau webterm `127.0.0.1:PORT`, metadata cloud, LAN | Chromium dipaksa lewat `--proxy-server=http://127.0.0.1:<port-acak>` ke proxy lokal yang me-resolve DNS SENDIRI, memvalidasi IP hasil resolve, lalu menyambung ke IP itu (menutup DNS-rebinding). Tolak loopback/RFC1918/CGNAT/link-local/ULA/mapped-IPv4/0.0.0.0. `--proxy-bypass-list=<-loopback>` agar localhost tak lolos bypass bawaan `[BT]`. Lapis-2 `Fetch.enable` hanya untuk skema (tak melihat IP) | WS-02 | test ssrf.ip + proxy (bun) + manual #3 |
| Skema berbahaya `file:`/`chrome:`/`javascript:`/`data:`/`view-source:`/`devtools:` | Validasi di `browser.url.ts` pada semua pintu (nav klien, verb agent, `WsNode.url` saat restore) + `Page.frameNavigated` dicek ulang; navigasi lolos? tidak -> `about:blank` + `blocked` | WS-00/02 | test url + navigation.guard |
| Port CDP bocor = kendali browser + cookie | Pilihan utama `--remote-debugging-pipe` bila `Bun.spawn` bisa memberi fd tambahan `[BT, spike S0]`; cadangan `--remote-debugging-port=0` loopback + baca `DevToolsActivePort` (risiko residu: proses lokal se-user dapat menyambung — setara akses shell user yang sudah ada; dicatat R-2). Tidak pernah `0.0.0.0` | WS-01 | test flags + spike manual |
| Profil Chrome asli user disentuh | `--user-data-dir` selalu di bawah `dataDir()/browser/profiles/<workspaceId>`; Chrome >=136 mengabaikan debugging di data-dir default (selaras). Tes: path di luar `dataDir()` ditolak | WS-01/03 | test flags |
| Sandbox | Tanpa `--no-sandbox`; Chromium non-root. Di container root: `browser_sandbox_unavailable` -> pesan jelas, TIDAK jatuh ke `--no-sandbox` otomatis | WS-01 | test flags |
| Akses ke `/ws/browser` dan `/api/browser/*` | Lewat `allowed()` (origin + token root). Node-token tidak punya jalur (default-deny `isNodeTokenPath`); tes WS-11 membuktikan | WS-04/08/11 | test |
| Agent membaca/menghapus cookie | Allowlist CDP default-deny + wrapper tunggal + tes struktural; agent hanya `listAuthenticatedDomains` (nama domain) via status/central R0 | WS-07 | test struktural |
| Prompt injection dari halaman | Konten snapshot = data tak tepercaya, dibungkus + `provenance:'untrusted-web'`; tidak pernah dieksekusi; `Runtime.evaluate` hanya templat internal; aksi konsekuensial lintas-origin butuh persetujuan (P-10); ref basi ditolak | WS-07 | test |
| Konten asing memengaruhi webterm (XSS) | Konten hanya sebagai piksel di `<canvas>`; tak ada HTML asing di DOM webterm; teks yang ditampilkan (judul, dialog) dirender sebagai teks (bukan `dangerouslySetInnerHTML`) | WS-06/09 | test jsdom |
| Izin perangkat | Kamera/mic/geolokasi/notifikasi ditolak (`Browser.setPermission` deny / flag); tidak ada Clipboard otomatis | WS-01 | test |
| Download/upload | Download ditolak (P-9); chooser tak dicegat | WS-01 | test |
| Kebocoran log (Rule 12) | Log browser hanya `{nodeId, hostname, event}`; tidak pernah URL berquery, cookie, isi frame, teks ketikan. `cookieRedact` satu-satunya pembentuk log cookie | semua | canary test + grep |
| Eksfiltrasi lewat WebRTC/IP | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` `[BT]` | WS-01 | spike |
| Proxy lokal jadi open relay | Bind `127.0.0.1` port acak; hanya meneruskan ke IP publik/allowlist; menolak metode selain CONNECT/GET-absolute; tidak ada kredensial | WS-02 | test |

### 6.2 Cookie (Rule 7)

| Aturan | Implementasi |
|---|---|
| Cookie = secret kelas tertinggi (sesi = akun) | Nilai tak pernah ke log, respons API, DOM klien, atau argumen CLI. Preview menampilkan domain + jumlah. Konten import hanya di memori (`COOKIE_PREVIEW_TTL_MS`) |
| Penyimpanan | Format internal Playwright-`storageState`; AES-256-GCM, IV acak per berkas; kunci 32 byte di `SecretStore` (`WEBTERM_BROWSER_VAULT_KEY`, KEY_SHAPE huruf kapital); blob `dataDir()/browser/vault/<workspaceId>.enc` mode 0600, dir 0700 |
| Cakupan & umur | Per `workspaceId`; TTL 7 hari (env); hapus manual per domain/semua; sapuan kedaluwarsa saat start |
| Sumber yang DIBOLEHKAN | Login manual di node; upload `storageState`/`cookies.txt` oleh user (fase flag terpisah). DILARANG: baca store browser harian, attach ke Chrome harian |
| Peringatan UX | Dialog menjelaskan: "cookie = akses akun penuh", pilih domain, tak ada impor massal default, tombol hapus. Teks di i18n/konstanta, bukan literal tersebar |
| Agent | Tidak bisa membaca nilai; hanya tahu domain mana yang terautentikasi |
| `.gitignore` (Rule 7) | Rule 7 minta cek: folder `browser/` ada di bawah data dir di luar repo; WS-11 menambah pola `*.enc` bila belum ada |

### 6.3 Aturan global per WS

| Rule | Penerapan |
|---|---|
| 8 File Health | Batas per jenis pada tabel §3.1 `-a`; jangan menambah ke file >80% tanpa pecah; `workspace.ts` 464 baris -> WS-11 hanya tambah <10 baris kohesif, jika lebih ekstrak |
| 10 Dependency | NOL dependency baru. Klien CDP mentah di `ws` (sudah ada). Alternatif ditolak: `puppeteer-core` (Apache-2.0, ditunda: tak perlu di jalur streaming, besar), `playwright-core` (Apache-2.0, ditunda), `chrome-remote-interface` (MIT, ~9 bln tanpa update, hanya pembungkus). Chromium tidak dibundel. WS yang ingin menambah paket = BERHENTI, lapor orkestrator. Audit paket tak berubah |
| 11 Error | Tak ada `catch {}` kosong; throw dengan konteks (`method`, `nodeId`, penyebab); pola per lapisan: host melempar `BrowserError` ber-kode, gateway/route memetakan ke `{t:'error'}`/status HTTP; klien memetakan ke pesan UI. Diagnosis-dulu pada bug |
| 12 Logging | Hanya hostname/ID; tidak ada `console.log` sisa; level `warn` untuk blokir SSRF (tanpa URL penuh) |
| 13 Performa | Satu proses Chromium per profil; stream hanya bila ada penonton; backpressure + drop; batas live; tidak ada loop N+1; endpoint daftar domain terbatas |
| 15 Hardcoded | Seluruh nilai di `browser.contract.ts` / env registry; path lewat `dataDir()`; pesan UI lewat konstanta; port proxy acak (bukan literal) |
| 16 Docs | WS-11 memperbarui README hanya bagian run/setup/env baru + `docs/decisions/browser-canvas.md` (alasan: server-side CDP, SSRF proxy, tanpa dependency); jangan menulis ulang narasi |
| 17 Debt | `TODO(browser): … — issue #n` wajib konteks; pengecualian P-8/9 (popup, download) dicatat sebagai keterbatasan di decision doc, bukan stub kosong; flag eksperimental `Page.startScreencast` dikomentari + versi Chromium teruji |
| Flag | `WEBTERM_BROWSER*` default OFF; fitur baru tak terlihat di UI saat off |
| Identitas | Nama terlihat `webterm`; `WEBTERM_*`, `x-webterm-node-token`, `webterm:` adalah nama protokol webterm. Kode yang mirip referensi eksternal (`shouldDiscard`) ditulis ulang, bukan disalin (lihat `RND/91-AUDIT-KODE-SALINAN.md`) |

## 7. Rollout

Seluruh langkah merge ke main HANYA atas perintah eksplisit user. Branch kerja `feature/browser-int`.

| Tahap | Isi | Syarat masuk | Syarat keluar | Rollback |
|---|---|---|---|---|
| S0 Spike & prasyarat (manusia) | Kandidat `Bun.spawn` + Chromium: pipe fd atau port=0; semantik `--proxy-bypass-list`; screencast + ack pada headless; ukuran frame/latensi dasar; WebRTC flag | persetujuan user menjalankan Chromium (Rule 1) | catatan hasil per `[BT]` di `docs/decisions/browser-canvas.md`; keputusan pipe vs port | tidak ada kode dirilis |
| S1 Fondasi server (W0-W1) | kontrak, host, SSRF, vault; flag OFF | S0 selesai atau dikecualikan | semua test hijau + typecheck; review `git diff` orkestrator; tes struktural allowlist/ssrf lulus | revert merge ke `feature/browser-int` |
| S2 Streaming + node (W2 tanpa agent) | gateway, lifecycle, `BrowserNode`; WS-11 versi minimal (menu "New Browser") di integration branch | S1 | uji manual #1, #2, #3, #5 lulus oleh manusia; flag on lokal | flag `WEBTERM_BROWSER=0` mematikan seluruh fitur; node browser lama tampil placeholder "dimatikan" |
| S3 Agent control | lease, verbs, REST, shim, UX; `WEBTERM_BROWSER_AGENT` default OFF | S2 | uji manual #4; tes struktural allowlist lulus; pengujian injeksi (halaman uji berisi instruksi jahat tidak memicu aksi tanpa ref/lease) | matikan flag agent; verb 403 |
| S4 Cookie import file | `WEBTERM_BROWSER_COOKIE_IMPORT` default OFF; dialog UX | S3 | uji manual #6; canary lulus; grep log bersih | matikan flag; hapus vault lewat DELETE |
| S5 Rilis ke main | WS-11 final: docs, CHANGELOG `## [x.y.z]` (Added), checklist pre-deploy Rule 6, laporan Rule 18 | S2-S4 diterima user; perintah merge | merge atas "merge sekarang" | revert merge commit; data profil/vault tidak dimigrasi (nol migration) |
| S6 (kondisional) Central tools | WS-12 setelah `ca2` di main | `ca2` merge + P-12 disetujui | test registry | hapus baris registrasi |
| Fase lanjut | audio (Neko/WebRTC), ekstensi, popup node baru, download/upload, ephemeral profile | permintaan user | — | — |

**TIDAK boleh diklaim selesai tanpa bukti:** (1) "render halaman benar di Chromium nyata" tanpa uji manual #1; (2) "SSRF tertutup" tanpa tes proxy + uji manual #3 (khususnya `[BT]` bypass-list); (3) "latensi/FPS/bandwidth/RAM" tanpa pengukuran (#8); (4) "aman dari prompt injection" — hanya "kontrol didefinisikan + diuji sintetis"; (5) "cookie tidak bocor" tanpa canary + grep log; (6) "berjalan remote/TLS" tanpa #7; (7) "multi-klien CDP/multi-screencast" (`[BT]`); (8) "fitur selesai" tanpa typecheck+test hijau yang dijalankan sendiri oleh orkestrator; (9) laporan worker tanpa `git diff` (laporan bisa fiktif, memori `worker-laporan-fiktif`).

## 8. Risiko dan pertanyaan terbuka

| ID | Risiko / pertanyaan | Dampak | Mitigasi |
|---|---|---|---|
| R-1 | `Page.startScreencast` berstatus experimental; bisa berubah | stream rusak setelah upgrade Chromium | kunci/catat versi teruji; isolasi di `browserHost.service.ts`; pesan "versi tidak teruji" |
| R-2 | CDP via port loopback (bila pipe tak bisa) terjangkau proses lokal | kendali browser oleh proses se-user | prefer pipe; port acak; dokumentasikan; spike S0 |
| R-3 | `--proxy-bypass-list=<-loopback>` dan perilaku bypass `[BT]` | SSRF ke loopback lolos | tes manual #3 wajib; lapis-2 `Fetch`; opsi netns/container sebagai hardening lanjutan |
| R-4 | DNS rebinding / alamat IPv6-mapped | SSRF | resolve-sendiri + sambung ke IP tervalidasi; tes mapped/rebinding |
| R-5 | Memori Chromium per node | host kehabisan RAM | `MAX_LIVE`, discard, stream hanya bila ada penonton |
| R-6 | Tanpa audio; WebGL headless lambat `[BT]` | kekurangan fungsi vs referensi eksternal | dokumentasikan; fase B opsional |
| R-7 | Keyboard bentrok dengan shortcut React Flow/aplikasi | input hilang/node terhapus | `nokey`, `preventDefault`, test jsdom; uji manual |
| R-8 | IME/touch/clipboard di mobile | UX buruk | textarea tersembunyi, fase bertahap; manual #7 |
| R-9 | Prompt injection mengarahkan agent ke aksi merusak | akun user | default OFF, lease, konfirmasi konsekuensial, allowlist CDP, ref basi |
| R-10 | `workspace.ts` 464 baris mendekati batas | pelanggaran Rule 8 | WS-11 tambah <10 baris; ekstrak tipe browser ke `browser.contract.ts` |
| R-11 | Chrome versi pengguna berbeda (flag/headless-shell) | peluncuran gagal | deteksi versi, pesan jelas; `--headless=new` `[BT]` |
| R-12 | `ca2` belum di main (tool central) | WS-12 tertunda | kondisional W5; jangan membuat tool sebelum registry ada |
| R-13 | Ukuran bandwidth remote | node lambat | `quality` turun saat zoom kecil, `ZOOM_PAUSE_BELOW`, fps cap via `everyNthFrame` (angka `[BT]`) |
| R-14 | Profil persisten dikunci satu proses (`SingletonLock`, `[BT]`) | dua server memakai data dir sama | satu proses per profil dalam satu server; deteksi lock -> pesan jelas |

| Pertanyaan terbuka untuk user | Default bila tak dijawab |
|---|---|
| P-5 apakah dev server lokal (mis. `localhost:5173`) harus bisa dibuka dari node? | tidak; isi `WEBTERM_BROWSER_ALLOW_HOSTS` manual |
| P-3 apakah import file cookie dibutuhkan di rilis pertama? | tidak (S4 terpisah, flag off) |
| P-4 apakah kendali agent perlu di rilis pertama? | tidak aktif secara default; kode ada, flag off |
| Audio penting? | tidak di MVP |
| Server tempat webterm berjalan: mesin lokal user atau VPS publik? (menentukan keseriusan SSRF/metadata) | asumsikan mungkin publik: SSRF proxy wajib sejak S1 |
