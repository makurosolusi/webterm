# RND-58: Persetujuan sadar di dalam app menggantikan "Dikunci" lewat env

Basis `chore/envmin-int` 620b9cf. `[V]` = kode dibaca (TERVERIFIKASI), `[A]` = ASUMSI.

## 0. Ringkasan

1. "Dikunci" hari ini = `rootGate` = "ada `WEBTERM_TOKEN` terkonfigurasi" (`envSettings.runtime.ts:53`, `envSettings.service.ts:111`, `envSettings.state.ts:80`). Itu bukan env dan bukan restart: itu token. `[V]`
2. Kunci itu tidak membendung penyerang nyata mana pun yang tidak sudah dibendung gerbang Host/Origin/token. Ia bisa dilewati oleh PTY anak dengan dua `curl` (bagian 5). Nilainya friksi, bukan keamanan. `[V]`
3. Pengganti yang aman dan sederhana: lapisan "grant" tipis di atas penyimpanan override yang sudah ada (SQLite `app`, hot-apply ke `process.env` lewat `apply()`). Pembaca flag (~100 kunci) tidak disentuh. `[V]`
4. Kerja berat hanya di modul yang dirakit sekali saat boot (browser, autonomy, CA2); orchestrator HTTP dan files sudah hot.

## 1. THREAT MODEL

### 1.1 Apa yang sebenarnya menjaga permukaan sekarang

| Lapisan | Bukti | Menahan |
|---|---|---|
| Allowlist Host (hanya saat tanpa token) | `auth.ts:36-39`, `index.ts:105` | DNS-rebinding ke loopback terbuka |
| `sameOrigin` (Origin harus = Host; `null` ditolak; `Sec-Fetch-Site` cross/same-site ditolak) | `auth.ts:86-98` | CSRF / WebSocket hijack dari halaman web |
| Token root (non-loopback wajib; loopback opt-in) | `index.ts:98-113`, `tokenAccess.api.ts` | Jaringan, pengguna lain |
| Token node hanya untuk 3 keluarga path | `auth.ts:120-126` | Agent yang memakai kanal resmi tak bisa menyentuh settings/fs//ws |
| `rootGate` untuk kunci `dangerous` | `envSettings.service.ts:111` | Lihat 1.2 |
| `WEBTERM_ENV_SETTINGS=off` | `envSettings.service.ts:55,150` | Operator menolak SEMUA perubahan runtime (veto sungguhan) |

### 1.2 Siapa yang dibendung "Dikunci" (tepatnya: kunci `dangerous` butuh token)

| Penyerang | Dibendung oleh "Dikunci"? | Alasan |
|---|---|---|
| Jaringan luar | Redundan | Non-loopback selalu punya token (L3). Kunci dangerous tidak menambah apa pun. |
| Halaman web jahat (CSRF/rebinding) | Redundan | Sudah ditolak `sameOrigin` + Host untuk SEMUA `/api`, bukan hanya dangerous. |
| Pengguna lain (uid berbeda) di mesin sama, loopback terbuka | TIDAK | `/ws` terbuka tanpa token = shell dengan uid server (`auth.ts:69-71`: tanpa token `tokensMatch` selalu true). Dangerous tidak menambah apa pun karena shell sudah ada. Mereka juga bisa memanggil `enable` lebih dulu (TOFU). |
| Agent/PTY anak (uid sama) | TIDAK | Bagian 5: dua `curl` melewati kunci. Lagipula ia sudah punya shell. |
| Agent lewat kanal resmi (token node / capability) | YA, tetapi bukan karena flag | Rute settings tidak ada di `isNodeTokenPath` (`auth.ts:120-126`), jadi bagian ini adalah batas nyata yang HARUS dipertahankan. |
| Pihak ketiga via kanal jarak jauh (Telegram -> central -> run) | Sebagian | Dibendung oleh flag kanal sendiri + ledger approval, bukan oleh kunci dangerous. |
| Salah klik / salah konfigurasi | YA | Ini fungsi nyata kunci: kemampuan tidak menyala tanpa niat. |

### 1.3 Jawaban atas pertanyaan inti

Apakah penguncian env mencegah sesuatu yang tak bisa dicegah dengan persetujuan runtime? **Tidak.** Semua batas nyata (Host, Origin, token, pemisahan token root vs node) hidup di gerbang request dan tetap berlaku identik bila saklar dipindah ke runtime. Yang hilang hanya hambatan "harus mengedit `.env` dan restart", yang tidak menghentikan penyerang mana pun.

Inkoherensi: `WEBTERM_FILES_MUTATE` (hapus/rename file) TIDAK `dangerous` dan bebas diubah tanpa token (`envRegistry.files.ts:55`; `fsApi.ts:130`), sedangkan "Run orkestrator" dikunci; keduanya setara dengan yang shell sudah bisa. `[V]`

Yang tak bisa diberikan env maupun runtime: pencegahan terhadap penyerang yang sudah punya shell uid server (`docs/decisions/env-minimal.md:42`). UI harus jujur soal ini.

## 2. RANCANGAN: "izinkan kemampuan X"

### 2.1 Prinsip: grant = override yang sudah ada, hanya dengan pintu masuk berbeda

Tanpa penyimpanan paralel. `grant(X)` memanggil `service.update` (konteks internal) menulis override flag penyusun X (mis. `ORCHESTRATOR_RUN=on` + `LEDGER=on`); `apply()` menulis ke `process.env` sehingga pembaca per-panggilan langsung melihatnya (`envSettings.service.ts:128-145`). Presedensi stored > env > default tak berubah (L2). `PUT /api/settings/env` untuk kunci `dangerous` menjadi 403 `use_grant` (ganti `token_required`, `service.ts:111`): satu pintu.

### 2.2 API (satu keluarga baru, dipasang SETELAH gerbang `allowed()` seperti `tokenAccessRoute`, `index.ts:154`)

- `GET  /api/settings/capabilities` -> `[{id, state: off|on, source: grant|env|default, tier, consequence, since, by, revocable}]`
- `POST /api/settings/capabilities/:id/grant`  body `{ack: true}` (Tier B: `{ack, typed: "<id>"}`)
- `POST /api/settings/capabilities/:id/revoke`

Urutan cek di handler grant (semua fail-closed):

1. Lolos `allowed()` (Host + Origin + token bila ada).
2. Tolak bila request membawa token node atau `x-webterm-capability` (`human_only`). Ini menjaga batas V3 di bagian 5.
3. Wajib header non-simple `X-Webterm-Consent: <id>`. Halaman lintas-origin tak bisa mengirimnya tanpa preflight, dan server tak punya CORS. Lapisan kedua di atas `sameOrigin`.
4. Bila TIDAK ada token ditegakkan DAN request membawa `Forwarded`/`X-Forwarded-*`/`X-Real-IP`: tolak `proxied_needs_token`. Alasan: `isLoopbackPeer` hanya melihat socket (`tokenAccess.api.ts:20,30-33`); reverse proxy di host yang sama membuat klien jauh tampak loopback. Jangan memakai `WEBTERM_TRUST_PROXY` untuk ini.
5. `WEBTERM_ENV_SETTINGS=off` -> 403 `locked` (veto operator tetap menang).
6. Tulis override, `apply()`, jalankan hook hot-wire (bagian 4), catat audit, respons keadaan baru.

### 2.3 Konfirmasi sadar di UI

Dialog tunggal per kemampuan, satu kalimat konsekuensi dari `dangerNote` registry (mis. `envRegistry.platform.ts:20`). Tier A: tombol "Izinkan"; Tier B: ketik id kemampuan. Dialog muncul "just in time" (klik Run/Browser/Hapus saat belum diizinkan), bukan menyuruh ke Settings: pengguna tak perlu tahu nama flag.

### 2.4 Penyimpanan, pencabutan, audit

- Keadaan: tetap di baris `env_overrides` (`envSettings.store.ts:1-5`, tanpa migrasi). Metadata (`by`, `since`, `consentVersion`) di satu baris `app` baru `capability_grants` (JSON).
- Cabut: tulis override `off` (bukan unset) bila env memasok `on` (stored > env). Bila `ENV_SETTINGS=off`: `revocable=false`, UI: "diatur lewat env". Efektif segera bila gerbang per-panggilan benar (bagian 4).
- Audit: tabel `capability_audit(id, at, capability, action, peer_kind, ua_class)` via `CREATE TABLE IF NOT EXISTS` di `db.ts` (idempoten), dicerminkan ke `slog` (`service.ts:165`) dan ledger bila aktif. Ledger saja tidak cukup: default `off` (`ledgerRuntime.ts:74-77`). Tanpa nilai secret.
- Versi konsekuensi: bila teks konsekuensi/definisi kemampuan berubah, `consentVersion` naik dan Tier B kembali off sampai disetujui ulang.

### 2.5 Yang boleh runtime vs tetap bootstrap

| Kelas | Isi | Alasan |
|---|---|---|
| Runtime Tier A (dipicu manusia di UI) | `orchestrator.run`, `browser`, `files.mutate`, `files.upload` | Dipicu klik manusia; tidak melebihi apa yang shell sudah beri; gerbangnya per-panggilan |
| Runtime Tier B (tanpa pengawasan / dipicu pihak ketiga) | `central.autonomy`, `central.agents=auto`, `browser.agent`, `browser.cookieImport`, `browser.allowHosts`, `opencode.allowTools`, jalur Telegram->run | Boleh runtime, tapi ketik-konfirmasi, default OFF, audit |
| Nilai path yang dieksekusi | `BROWSER_BIN`, `OPENCODE_BIN`, `MEMORY_DIR`, `CONTROL_CWD_ROOTS` | Bukan saklar, tapi primitif eksekusi persisten. Hanya diubah di dalam dialog kemampuan induknya, divalidasi (absolut, ada, executable) |
| **Tetap bootstrap** | `HOST PORT WEBTERM_DATA_DIR WEBTERM_TOKEN WEBTERM_ENV_SETTINGS WEBTERM_ALLOWED_HOSTS WEBTERM_ALLOW_TOKEN_MINT WEBTERM_STRICT_HOOK_AUTH WEBTERM_ALLOW_LOOPBACK_APPROVAL` | Lihat bawah |

Kenapa bootstrap: (a) dibaca sebelum DB ada (L1); (b) mereka ADALAH batas yang dipakai grant, jadi mengubahnya lewat permukaan yang dilindunginya melingkar (sesi dibajak bisa melebarkan `ALLOWED_HOSTS` atau mematikan veto `ENV_SETTINGS`); (c) `STRICT_HOOK_AUTH` dibaca sekali saat modul dimuat (`agentStatusAuth.ts:15`), `ALLOW_TOKEN_MINT` di-cache (`control/mount.ts:49-67`); (d) `HOST/PORT` butuh bind ulang.

## 3. Mode loopback vs jarak jauh

### 3.1 Dua mode, diturunkan (bukan dikonfigurasi)

`local` = bind loopback dan tak ada header forwarded; `remote` = bind non-loopback (token selalu ada, L3) atau forwarded terlihat. Pengguna tak memilih mode.

### 3.2 Apakah grant dibatasi ke origin loopback saja?

Usulan "grant hanya dari loopback + sesi ber-token". Evaluasi: **tidak perlu, dan merugikan.** Pemegang token jauh sudah punya `/ws` = shell (`index.ts:184-213`); memblokir grant tak menutup apa pun dan memaksa pengguna VPS kembali mengedit env. Yang berbeda di `remote` bukan siapa yang boleh, melainkan default dan jejak:

- default semua kemampuan OFF dan tidak ada "Tanya" otomatis;
- Tier B: ketik konfirmasi + audit yang disiarkan ke semua UI terhubung;
- token wajib (sudah dijamin L3), tanpa pengecualian `proxied_needs_token`.

Operator yang ingin melarang grant jarak jauh memakai `WEBTERM_ENV_SETTINGS=off` (tanpa kunci baru).

### 3.3 Kebijakan default per kemampuan

| Kemampuan | local | remote | Catatan |
|---|---|---|---|
| `files.mutate` | Tanya (dialog saat klik Hapus pertama), lalu ON | OFF | Sudah hot (`fsApi.ts:130`); L11 mempertahankan off sebagai default awal |
| `files.upload` | Tanya | OFF | idem |
| `orchestrator.run` | Tanya, lalu ON | OFF | Mengimplikasikan ledger (hapus rantai 3 flag) |
| `browser` | Tanya, lalu ON | OFF | |
| `browser.agent`, `cookieImport`, `allowHosts` | OFF | OFF | Tier B |
| `central.autonomy`, `agents=auto`, `opencode.allowTools` | OFF | OFF | Tier B |
| `RUN_REQUIRE_APPROVAL` | bukan lagi saklar: ON otomatis bila ada Tier B aktif | sama | menghapus rantai `RUN_REQUIRE_APPROVAL -> RUN -> LEDGER` |

Catatan: "Tanya" via ledger approval di loopback terbuka buntu: tanpa token approval manusia ditolak kecuali `ALLOW_LOOPBACK_APPROVAL=1` (`approvalAuth.ts:12-15`, `approvalHumanApi.ts:93`). Maka grant memakai dialog sendiri, bukan jalur ledger. `[V]` kode, `[A]` integrasi.

## 4. Gerbang jalur eksekusi dan hot-wire

Kriteria: kemampuan harus dicek PER PANGGILAN di titik eksekusi, bukan saat boot, dan pencabutan harus menghentikan yang sedang berjalan bila berumur panjang.

| Kemampuan | Titik cek sekarang | Status | Pekerjaan | Ukuran |
|---|---|---|---|---|
| `orchestrator.run` HTTP | `extendedApi.ts:76`, `orchestratorRunApi.ts:54`, `orchestratorControlService.ts:49` baca `process.env` per request | **Sudah hot** `[V]` (registry bohong: `restart:'boot'`, `envRegistry.platform.ts:18`) | Koreksi label; ledger lazy: `startLedgerRuntime()` bisa dipanggil lagi dan `activeLedgerRuntime()` dibaca per request (`api.ts:~158`) | S |
| `orchestrator.run` via tool central `task.run` | tool didaftarkan hanya bila flag on saat boot (`registerAll.ts:62`); eksekusi memeriksa ulang (`toolExec.ts:21`, `toolRegistry.ts:36`) | Hanya hot untuk cabut, tidak untuk nyala | Daftarkan selalu, andalkan filter per-panggilan yang sudah ada | S |
| `central.autonomy` | timer dimulai sekali di boot (`index.ts:79`), dan `runItem` memaksa `enabled: true` (`centralAutonomyBoot.ts:77`), sehingga **mencabut RUN tidak menghentikan tick** | Celah pencabutan `[V]` | Cek `orchestratorRunEnabled()` + flag autonomy per tick; start/stop timer lewat hook grant | M |
| `ca2` / `agents` | `bootCa2` mengembalikan null bila flag off, membangun executor sekali (`ca2Boot.ts:121-130`) | Boot-only | Hook grant memanggil ulang `bootCa2`/`stop()`; kandidat ditunda | M-L |
| `browser` | `startBrowserRuntime` null bila off (`browser.runtime.ts:56`); `index.ts:125-136`; WS memakai konstanta `browserRuntime` (`index.ts:188,205,210`) | Rute HTTP/control sudah `activeBrowser()` per panggilan (`api.ts:97`, `control/mount.ts:152`) | Ganti konstanta di `index.ts` dengan `activeBrowser()`; grant memanggil `await startBrowserRuntime`, `setActiveBrowser`, `installBrowserAgentShim`, `applyPtyOptions()` (hook capability sesi, `api.ts:74`); revoke memanggil `shutdown()` (sudah idempoten, memutus gateway lewat `enabled: () => !down`) | M |
| `files.*` | `filesFlagOn` per panggilan (`envRegistry.files.ts:30`, `fsApi.ts:130`) | **Sudah hot** `[V]` | Hanya UI grant; `sweepTrashOnBoot` (`fsBoot.ts:11`) cukup dijalankan sekali saat grant | S |
| Telegram->central | `channelsRuntime`/`centralChat` menangkap `activeRuntime` saat boot (`index.ts:59-61`) | Boot-only | Bergantung keputusan ledger-selalu-aktif (pekerja deps); di luar cakupan ini | L |

Aturan: baca env efektif di titik eksekusi, jangan di-cache di closure boot. Satu tes per kemampuan: nyalakan -> OK; cabut -> 503/`*_off` tanpa restart.

## 5. Self-escalation

Vektor, urut dari yang paling parah:

| # | Vektor | Bukti | Hasil | Cegah |
|---|---|---|---|---|
| V1 | PTY anak memanggil `POST /api/settings/token/enable`: hanya cek peer loopback; tanpa Origin dan tanpa token dianggap sah | `tokenAccess.api.ts:66-74`; `auth.ts:96-98` (Origin kosong = klien non-browser, diizinkan) | Agent mendapat root token, lalu `PUT` dangerous (`rootGate` = token ada, `envSettings.runtime.ts:53`) dan approval manusia (`approvalAuth.ts:12`). **Kunci "Dikunci" runtuh dengan 2 request.** `[V]` dari kode, tidak dicoba | Lihat 5.1 |
| V2 | Baca `<dataDir>/secrets/WEBTERM_TOKEN` | 0600 uid sama; diakui di `env-minimal.md:42` | Sama dengan V1 | Tak bisa dicegah perangkat lunak (uid sama) |
| V3 | Token node (`$WEBTERM_TOKEN` agent, `sessions.ts:81`) ke rute settings/grant | `isNodeTokenPath` hanya `agent-status`, `context-link`, `control/*` (`auth.ts:120-126`); root token disapu dari PTY (`ptyShell.ts:91`) | Ditolak. Batas nyata | Pertahankan; grant menambah tolak eksplisit (2.2 langkah 2) |
| V4 | Tool central (LLM) mengubah settings | Pencarian `envSettings/settings/env/settings/token` di `central/ channels/ control/ orchestrator/` kosong `[V]` | Tidak ada tool yang menyentuh setelan | Tes statis: tak ada tool mengimpor modul settings/grant |
| V6 | Reverse proxy lokal membuat klien jauh tampak loopback | `tokenAccess.api.ts:20,30` | Jauh bisa `enable` dan, kini, `grant` | `proxied_needs_token` (2.2 langkah 4) |

### 5.1 Mitigasi V1 (urut dari murah ke kuat)

1. **Murah, wajib:** `enable` dan `grant` menolak request tanpa `X-Webterm-Consent` dan `Sec-Fetch-Site: same-origin`. `curl` polos gagal. Friksi, bukan batas: agent yang sengaja bisa memalsukan header.
2. **Kode klaim sekali pakai (P+, ditunda: `env-minimal.md:46`)** untuk Tier B dan `enable`: server mencetak kode ke stdout TTY saja (bukan `createLogger`, yang menulis file terbaca agent), manusia mengetiknya di dialog. Preseden referensi eksternal: `setupToken()` dicetak ke konsol, dikonsumsi sekali (`referensi-eksternal/src/server/auth.ts:199-219`). Satu-satunya mekanisme yang tak terjangkau agent uid-sama (stdout proses lain tak terbaca tanpa ptrace). Tanpa TTY (layanan) turun ke butir 1. `[A]` bagian stdout.

Jujur untuk UI: pada loopback terbuka, persetujuan melindungi dari kesalahan dan agent yang terinjeksi lewat kanal resmi, BUKAN dari proses uid-sama yang bermusuhan.

## 6. Pembanding referensi eksternal (`/Users/bip/Documents/spawn/referensi-eksternal`)

- Verb kanvas destruktif: dialog konfirmasi manusia; pembebasan per sesi aplikasi hanya di memori ("bukan jalan pintas"), pembebasan permanen hanya di Settings > Agents berlabel permanen (`src/renderer/state/controlConfirm.ts:1-60`, `src/shared/control-confirm.ts:1-40`). Prinsip yang sama dengan Tier A/B di sini: konfirmasi di titik penggunaan, cakupan lebih lebar butuh langkah lebih sadar, selalu dapat dicabut.
- Mode server headless (tanpa dialog) memakai opt-in env `WEBTERM_SERVER_CANVAS_CONTROL=1` (`referensi-eksternal/src/server/index.ts:871`): env dipakai hanya bila tak ada manusia untuk dikonfirmasi; webterm punya UI web.
- Bukti kepemilikan out-of-band: `setupToken` dicetak ke konsol, sekali pakai (`server/auth.ts:199-219`). Model untuk 5.1 butir 2.
- Per aturan proyek (tiru referensi eksternal): dialog di titik pakai + opt-in terlihat/dapat dicabut; bukan env-only.

## 7. REKOMENDASI TEGAS

1. **Hapus syarat token dari kunci `dangerous`; ganti dengan rute grant (2.2).** Kenapa: kunci itu menahan nol penyerang nyata dan runtuh lewat V1 (bagian 1, 5). Risiko: pada loopback terbuka tidak ada batas baru terhadap uid-sama (sudah begitu). Ukuran: M.
2. **Pindah ke runtime sekarang (sudah hot di kode):** `orchestrator.run` (HTTP), `files.mutate`, `files.upload`; koreksi label `restart:'boot'` yang salah untuk RUN (`envRegistry.platform.ts:18`). Kenapa: biaya nyaris nol. Risiko: rendah. Ukuran: S.
3. **Hot-wire berikutnya:** `browser` (konstanta `index.ts:188-210` -> `activeBrowser()`, start/stop di hook grant) lalu `central.autonomy` (cek per tick; tutup celah pencabutan `centralAutonomyBoot.ts:77`). Risiko: lifecycle Chromium saat revoke; tes start/stop/start. Ukuran: M masing-masing.
4. **Tetap bootstrap:** 9 kunci L1 (termasuk `ENV_SETTINGS` sebagai veto operator). Jangan tambah kunci ke-10. Kenapa: batas kepercayaan tak boleh diubah lewat permukaan yang dilindunginya. Ukuran: 0.
5. **Perlakukan `enable` token dan grant Tier B dengan bukti out-of-band (kode sekali pakai di konsol TTY; fallback header-consent bila tanpa TTY).** Kenapa: satu-satunya mitigasi V1 yang bukan sekadar friksi; presedennya ada di referensi eksternal. Risiko: server tanpa TTY turun ke friksi saja. Ukuran: M.
6. **Audit durabel `capability_audit` + `consentVersion` (2.4).** Kenapa: ledger default off tak bisa jadi satu-satunya jejak; Tier B harus minta persetujuan ulang bila definisi berubah. Risiko: skema baru idempoten (Rule 4). Ukuran: S-M.
7. **Tolak grant tanpa token bila ada header forwarded (V6)** dan tambah tes statis bahwa tak ada def tool central yang mengimpor modul settings/grant (V4). Ukuran: S.
8. **Jadikan ledger selalu aktif dan turunkan `RUN_REQUIRE_APPROVAL` dari saklar menjadi akibat Tier B** (kerja bersama R&D deps). Kenapa: menghapus rantai 3 flag di keluhan awal. Risiko: ledger on mengubah footprint DB. Ukuran: M.

Urutan: (2) -> (1)+(6)+(7) -> (5) -> (3) browser -> autonomy -> (8). Tiap langkah di branch sendiri.

## 8. PERTANYAAN UNTUK USER

1. Terima batas jujur bahwa pada loopback terbuka persetujuan tidak melindungi dari proses uid-sama yang bermusuhan (sama seperti shell hari ini)? **Default saran: ya**, dengan teks jujur di dialog.
2. Setelah Tier A diizinkan di mode `local`, apakah tetap "Tanya" tiap sesi atau ON permanen sampai dicabut? **Default saran: ON sampai dicabut**, Tier B selalu butuh persetujuan ulang saat `consentVersion` naik.
3. Apakah `enable` token pada loopback harus ikut meminta kode konsol (menutup V1) walau memperlambat pemakaian pertama? **Default saran: ya bila ada TTY, tidak bila tanpa TTY.**
