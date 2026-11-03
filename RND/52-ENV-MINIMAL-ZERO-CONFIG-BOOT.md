# RND 52 — Jalur boot tanpa env, run-pertama tanpa `.env`, penyimpanan secret

Topik 2 dari 3. Saudara: `51-ENV-MINIMAL-INVENTORY.md` (inventaris kunci), `53-ENV-MINIMAL-CONFIG-LAYERS.md` (lapisan konfigurasi, migrasi). Asumsi lintas-topik `[BT]`, opini `[opini]`.

Basis: worktree `rnd-envmin` (branch `chore/rnd-env-minimal`, dari `main` `a3cf9ce`), Bun 1.4.2 (macOS arm64). Lihat juga `RND/39-ENV-REGISTRY-AUDIT.md`.

## 1. Bukti uji nyata (boot tanpa env)

Semua uji: `env -i PATH=/usr/bin:/bin` (+ hanya variabel yang disebut), cwd direktori kosong di `/tmp/envmin-rnd`, `WEBTERM_DATA_DIR`/`HOME` ke `/tmp`, port acak, proses dihentikan sesudahnya. Tidak ada `.env` pengguna yang dibaca; `.env` uji (U7) dibuat sendiri dengan nilai dummy. `~/.webterm-server` tidak disentuh.

| ID | Skenario | Hasil teramati |
|---|---|---|
| U1 | Dev (`NODE_ENV` kosong), hanya `PORT` + `WEBTERM_DATA_DIR` | Boot OK < 6 dtk. Log: `dev+HMR, token off: loopback only`. `GET /api/workspaces` 200 `[]` tanpa kredensial. |
| U2 | Prod (`NODE_ENV=production`), loopback | Boot OK. `GET /` 404 (aset kosong: `distAssets.generated.ts` stub 2 baris, wajar tanpa build); `/api/workspaces` 200. |
| U3 | Prod, `HOST=0.0.0.0`, tanpa token | Proses KELUAR kode 1: `HOST="0.0.0.0" is reachable from other machines ... Set WEBTERM_TOKEN ...` (`auth.ts:55`). Tetapi `webterm.db` SUDAH terbuat di data dir (efek samping impor `db.ts`, sebelum `resolveToken`). |
| U4 | Tanpa `HOME`-override: `HOME=/tmp/envmin-rnd/home`, `PORT=abc`, tanpa `WEBTERM_DATA_DIR` | Data dir = `$HOME/.webterm-server` (dibuat otomatis). `PORT=abc` diam-diam jadi 8700 (`serverConfig.ts:10`). |
| U5 | Port sudah dipakai | Crash `Uncaught exception: Error: Failed to start server. Is port N in use?` + cuplikan kode; tanpa pesan ramah/exit code terdokumentasi. |
| U6 | Dev, loopback tanpa token: `PUT /api/settings/env` set `WEBTERM_TELEGRAM_BOT_TOKEN` (nilai palsu berbentuk benar) | 200. Terbentuk `data/secrets/` mode `drwx------` + `secrets/WEBTERM_TELEGRAM_BOT_TOKEN` mode `-rw-------`. Nilai TIDAK ada di `webterm.db` (`grep -c` = 0). |
| U6b | Sama, set `WEBTERM_ORCHESTRATOR_RUN=on` (kunci `dangerous`) | **403 `token_required`**. Tanpa token root, fitur berbahaya tak bisa dinyalakan lewat UI. |
| U7 | `.env` uji (cwd) berisi `PORT=1`, `WEBTERM_TOKEN=dummytok`, `OPENAI_API_KEY=dummy-not-real` | Bun memuat SEMUA ke `process.env`. `ptyEnv()` (`ptyShell.ts:79`) membuang `PORT`/`WEBTERM_*` tetapi `OPENAI_API_KEY` **diwariskan ke PTY**. `bun --no-env-file` dan cwd lain: tidak dimuat. |
| U8 | Binary uji `bun build --compile` (skrip 1 baris) di cwd ber-`.env` vs cwd kosong | Binary memuat `.env` dari cwd (terbukti); help `bun build`: `--compile-autoload-dotenv` default **true**, `--compile-autoload-bunfig` default **true**, `--compile-autoload-tsconfig`/`-package-json` default false, tersedia `--no-compile-autoload-*`. |
| U9 | Probe Host/Origin, loopback tanpa token | `Origin` asing → 403. `Host: evil.example:P` + `Origin: http://evil.example:P` (pola DNS rebinding) → **200**. Tanpa Origin (proses lokal mana pun) → 200. |
| U10 | `Bun.secrets` set/get/delete di macOS | Round-trip OK 291 ms (async). Entri uji dihapus. |

Tak teruji (`[BT]`): binary penuh `build:binary` (butuh `vite build`), `Bun.secrets` di Linux headless, data dir tak-tertulis, `bunfig` `preload` pada binary.

## 2. Jalur boot `src/server/index.ts` tanpa env

Urutan nyata (baris dari `index.ts`, `serverConfig.ts`, `auth.ts`):

| # | Langkah | Tanpa env | Catatan |
|---|---|---|---|
| 0 | Bun autoload `.env`/`bunfig.toml` dari **cwd** (sebelum kode kita) | tak ada berkas = no-op | Lihat §4 |
| 1 | Impor modul statis (`db.ts`, `config.ts`, `logs`, ...) | **membuat data dir + `webterm.db` (0644)** | Efek samping sebelum validasi apa pun (U3) |
| 2 | `resolveHostPort(process.env)` `:38` | `127.0.0.1:8700` | `HOST` > `WEBTERM_HOST` > default; `Number(PORT)\|\|8700` menelan nilai ngawur dan `PORT=0` |
| 3 | `resolveToken` `:40` | loopback → `undefined` (tanpa token); non-loopback → throw | `0.0.0.0`, `::`, `127.0.0.2`, `::ffff:127.0.0.1` dianggap non-loopback (aman-gagal) |
| 4 | `writeTokenToEnv` `:43` | `delete process.env.WEBTERM_TOKEN` | Jadi `WEBTERM_TOKEN` di env proses = token yang ditegakkan |
| 5 | `initEnvSettings` `:45` | tabel `app` kosong + `secrets/` kosong → no-op | Secret berkas menang atas env (`envSettings.service.ts:87-91`) |
| 6 | Logging, ledger, kanal, central | semua flag default off → null | Boot bersih |
| 7 | Browser runtime, `applyPtyOptions`, `installContextLink` | context-link shim ditulis ke `<dataDir>/context-links/context.sh` (0700) | OK |
| 8 | `dev = NODE_ENV !== 'production'` `:49` | **default = dev** | `import('vite')` hanya di dev; `vite` ada di `devDependencies` → instalasi prod tanpa dev-deps yang lupa `NODE_ENV` crash [BT, tak diuji]. Binary aman: `--define process.env.NODE_ENV='production'` (`package.json` `build:binary`). |
| 9 | `server.listen(PORT, HOST)` `:241` | OK; EADDRINUSE = crash mentah (U5) | |

**Kesimpulan: boot tanpa env SUDAH berhasil untuk loopback** (dev, prod). Yang kurang bukan "bisa jalan" melainkan (a) keamanan default, (b) fitur yang terkunci tanpa token root, (c) kebersihan `.env`, (d) pesan galat.

## 3. Temuan tak aman / degradasi (tanpa env)

| ID | Temuan | Dampak | Sev | Bukti |
|---|---|---|---|---|
| T1 | Loopback tanpa token = **siapa pun yang mencapai 127.0.0.1:PORT** dapat membuka PTY (shell) dan fs API | Pada host multiuser, pengguna lokal lain mendapat shell sebagai pemilik server; proses sesama uid (agent) bebas | Tinggi | U1, U9; `auth.ts:51-61` |
| T2 | Gerbang Origin membandingkan `Origin.host` dengan `Host` request → **DNS rebinding lolos** (kedua header = `evil.example:P`) | Halaman web berbahaya, setelah rebinding, memegang shell lewat `/ws` pada mesin pengguna yang membuka halaman itu | Tinggi `[opini: terbesar]` | U9; `auth.ts:95-107`. Tidak ada allowlist Host (`grep allowedHosts` nol di `src/server`). Pagar Host milik Vite (dev) tidak menjangkau `/api` & `/ws` karena ditangani sebelum `vite.middlewares` (`index.ts:157-161`) `[BT]` |
| T3 | Kunci `dangerous` (14) + `/api/approvals/*` + mint capability butuh `WEBTERM_TOKEN`; tanpa env tidak ada token → terkunci permanen | Pengguna zero-config tak bisa menyalakan orkestrator/central/approval dari UI; satu-satunya jalan = tulis env (menggagalkan tujuan) | Fungsional | U6b; `approvalAuth.ts:13`, `envSettings.runtime.ts:37`, `control/mount.ts:64` |
| T4 | Data dir 0755 dan `webterm.db`/log 0644 (umask); hanya `secrets/` 0700 dan `context-links/` | Workspace, riwayat, log terbaca pengguna lokal lain; backup data dir ikut membawa semuanya | Sedang | U1 `ls -la`; `config.ts:7` `mkdirSync` tanpa `mode` |
| T5 | `.env` di cwd (dev & binary) masuk `process.env`; kunci tak berawalan `WEBTERM_/NODETERM_/PORT/HOST/VITE_/BUN_` mengalir ke **semua PTY** | `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` (nama legacy diterima `telegram.ts:5`) bocor ke setiap shell/agent | Tinggi bila `.env` dipakai | U7; `ptyShell.ts:74` |
| T6 | Binary memuat `bunfig.toml` dari cwd (default true) | `preload` di bunfig = kode arbitrer di server bila dijalankan dari direktori tak tepercaya `[BT: preload pada binary tak diuji]` | Sedang | U8 |
| T7 | Efek samping DB/dir sebelum validasi token (U3) | Server yang menolak start tetap meninggalkan state | Rendah | U3 |
| T8 | `PORT` invalid/0 → 8700 senyap; EADDRINUSE mentah | Salah konfigurasi tak terlihat; port acak mustahil | Rendah | U4, U5; `serverConfig.ts:10` |
| T9 | `.env.example` `HOST=localhost` vs default kode `127.0.0.1` | `listen('localhost')` bisa hanya `::1` `[BT]` | Rendah | `auth.ts:29` |

## 4. Bun otomatis memuat `.env` — dampak & mitigasi

| Aspek | Fakta | Rekomendasi |
|---|---|---|
| Dev (`bun run dev`) | Muat `.env` cwd (Bun docs + U7). `.env*` di `.gitignore` sudah (kecuali `.env.example`). | Pertahankan (kompat); tambah peringatan boot bila `.env` ada (cek keberadaan saja). |
| Binary | `--compile-autoload-dotenv` default true (U8): cwd tempat binary DIJALANKAN, bukan lokasi binary. README mengklaim "runs from any directory; reads a .env from the cwd". | Opsi: bangun dengan `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` setelah jalur impor (topik 53) siap; sebelum itu minimal matikan **bunfig** (tak ada alasan sah). |
| Pewarisan ke PTY | Hanya 6 pola dibuang (`ptyShell.ts:74`). | **Provenance-filter** `[opini]`: pada boot, parse kunci `.env` cwd (hanya nama+nilai untuk dibandingkan, tak dicetak); `ptyEnv` membuang kunci yang nilainya sama dengan `.env`. Denylist `*_KEY/*_TOKEN` ditolak: membuang `GITHUB_TOKEN` sah dari shell peluncur. Catatan: login shell (`-l`) memuat ulang rc pengguna, jadi variabel sah tetap ada. |
| Provider key untuk central | `opencodeOptions.ts:39-43` mengizinkan `*_API_KEY` dari env proses ke child opencode; runtime `claude` membuang `ANTHROPIC_`/`OPENAI_` (`claudeOptions.ts:60`). | Webterm TIDAK perlu memegang kunci provider: CLI punya login sendiri (`claude login`, `opencode auth`). Zero-config = jangan menyimpannya. |

## 5. Rancangan run-pertama tanpa `.env`

### 5.1 Opsi token

| Opsi | Perilaku | Untung | Rugi |
|---|---|---|---|
| A. Status quo | Loopback terbuka, non-loopback crash. | Nol perubahan, kompat penuh. | T1, T2, T3 tetap. |
| B. Token selalu aktif | Bangkitkan + persist; tampil di terminal; semua akses (termasuk loopback) pakai token. | Menutup T1-T3. | Memutus `curl localhost`, skrip/CI/tes yang mengandalkan loopback terbuka, bookmark lama; `sessionStorage` per-tab (`transportToken.ts:7`) → tab baru minta login. Menyimpang dari nodeterm. |
| **D. Bertingkat (rekomendasi)** | (1) Non-loopback tanpa token: **bangkitkan+persist** alih-alih crash. (2) Loopback: tetap terbuka SEBELUM pengguna meminta token; tombol "Aktifkan token akses" di UI/CLI membuat berkasnya (opt-in B). (3) **Host allowlist** menutup T2 pada semua mode. | Zero-config tetap mulus, jalur aman terbuka, T2 tertutup tanpa memutus siapa pun. | Loopback default tetap T1 (mitigasi: data dir 0700). |

Prioritas sumber token (D): `WEBTERM_TOKEN` env (menang, kompat) > `<dataDir>/secrets/WEBTERM_TOKEN` > bangkitkan hanya jika non-loopback > tanpa token. Ada berkas = token ditegakkan, juga di loopback (itu mekanisme opt-in).

### 5.2 Spesifikasi bootstrap token

| Butir | Keputusan |
|---|---|
| Bangkit | `randomBytes(32).toString('base64url')` (43 karakter), sekali. Konsisten dengan kunci vault cookie yang sudah dibangkitkan+dipersist di `secrets/` (`browser/cookieVault.store.ts:57`). |
| Lokasi | `<dataDir>/secrets/WEBTERM_TOKEN` lewat `createFileSecretStore` (dir 0700, berkas 0600, tulis atomik temp+rename, mode saat dibuat — `envSecrets.store.ts:28-60`). Kunci bootstrap-only + bukan spec registry → `apply()` tidak menyentuhnya. |
| Berkas ada tapi mode salah/rusak | **Gagal keras** dengan pesan berisi path + perintah `chmod 600`; JANGAN membangkitkan ulang diam-diam (`read()` mengembalikan `null` untuk mode salah, `envSecrets.store.ts:47`, sehingga pemanggil harus membedakan "absen" vs "tak terbaca"). |
| Urutan | Perlu `dataDir()` saja, tidak perlu DB, jadi bisa jalan di `index.ts:40` sebelum `resolveToken` tanpa menyentuh urutan `initEnvSettings`. Sebelum itu pindahkan efek samping DB (T7) atau terima sebagai batasan. |
| Tampil | URL `http://HOST:PORT/?token=<nilai>` ditulis LANGSUNG ke stderr **hanya bila `process.stderr.isTTY`**, SEKALI saat token baru dibangkitkan atau saat start bila token berasal dari berkas. TIDAK lewat `createLogger` (log berkas di `<dataDir>/logs`, README menjanjikan tanpa query string/secret). Non-TTY (systemd/Docker): cetak hanya path berkas + cara membacanya. Klien sudah menghapus `?token=` dari address bar dan menyimpan di sessionStorage (`api.ts:31-39`); layar Login sudah ada (`Login.tsx`, 403 saat boot, `App.tsx:41`). |
| Rotasi | Hapus berkas + restart → token baru; tombol "Putar token" `[opini]`. |
| Anak/PTY | Tidak berubah: `ptyEnv` membuang `WEBTERM_*`; sesi agent mendapat token NODE (`sessions.ts:81`), bukan root. Token root TIDAK ditulis ke disk anak (`index.ts:121-124`). |
| UX lanjutan (fase 2) | `sessionStorage` per-tab memaksa tempel token tiap tab baru. Opsi: cookie `HttpOnly; SameSite=Strict` diset saat halaman dimuat dengan `?token=` `[opini]`; sentuh `auth.ts` + klien, ukuran M, putuskan terpisah. |

### 5.3 Host allowlist (penutup T2)

Terima `Host` hanya bila: nama = host bind efektif, `localhost`, `127.0.0.1`, `[::1]` (dengan atau tanpa `:PORT`), atau entri `WEBTERM_ALLOWED_HOSTS` (kunci bootstrap baru, opsional, untuk reverse proxy; usulan untuk topik 51). Terapkan di `authorize()` bersama `sameOrigin`, jadi `/api` dan `/ws` tertutup sekaligus. Regresi: akses via IP LAN/mDNS/proxy butuh `WEBTERM_ALLOWED_HOSTS`; pesan galat harus menyebut Host ditolak.

## 6. Penyimpanan secret tanpa `.env`

Inventaris secret yang dipegang/diterima webterm:

| Secret | Sumber sekarang | Tempat sekarang |
|---|---|---|
| Root token | env `WEBTERM_TOKEN` | memori (+ `process.env`) |
| Token bot Telegram | env `WEBTERM_TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN` atau Settings (U6) | Settings → `secrets/` 0600 (sudah) |
| Secret webhook Telegram | env, `..._FILE` atau Settings | `secrets/` (sudah); `..._FILE` didukung `channelSecret.ts:70` |
| Kunci vault cookie | dibangkitkan otomatis | `secrets/` (sudah) |
| Token node/capability `wcap_*` | dibangkitkan, memori | memori — benar, jangan dipersist |
| Kredensial runtime central | tidak ada milik webterm; CLI `claude`/`opencode` memegang login sendiri | di luar webterm (§4) |

Pembanding mekanisme:

| Mekanisme | Keamanan | Kompleksitas | Zero-config / headless | Backup & portabilitas | Vonis |
|---|---|---|---|---|---|
| **Berkas 0600 di `secrets/`** (ada) | Perlindungan = izin OS; terbaca proses sesama uid dan root; ikut backup dir bila disalin | Nol, sudah teruji (`envSecrets.store.test.ts`, vault) | Ya, Docker/Linux/macOS/Windows* | Mudah (volume) | **Pakai sebagai satu-satunya penyimpan** |
| Kolom SQLite terenkripsi | Kunci enkripsi harus disimpan di suatu tempat (berkas 0600 lagi) → keamanan efektif sama, kompleksitas naik | Tinggi (KDF, rotasi, migrasi, ganti engine) | Ya | DB + kunci terpisah | Tolak |
| `Bun.secrets` (Keychain/libsecret/Credential Manager) | Terenkripsi OS, antar-uid terisolasi; **dokumen resmi: "new and experimental, may change", "not very useful for deployment secrets"** | API async saja (boot kita sinkron: `initEnvSettings` `index.ts:45`); Linux butuh daemon secret-service (tak ada di server/Docker); macOS dapat memunculkan prompt Keychain, ACL terikat identitas biner (build ulang = prompt lagi) `[BT]` | Tidak untuk headless | Tidak ikut backup/pindah mesin | Tolak sebagai utama; opsional fase-2 `[opini]` |
| Konvensi `*_FILE` | Setara berkas; cocok Docker/K8s secret | Kecil; baru ada untuk webhook secret | Ya (opsional) | Mengikuti orkestrator | Perluas ke `WEBTERM_TOKEN_FILE` (S), bukan prioritas |
| Variabel env / `.env` | Terlemah: diwariskan (T5), terlihat di `ps e`/`/proc` | Nol | Ya | Mudah bocor | Sisakan sebagai override |

\* Windows: izin POSIX tidak berlaku; `chmod` dilewati (`hooksPaths.ts:30`) → di Windows keamanan berkas = ACL profil `[BT]`. Webterm ini berorientasi macOS/Linux.

Catatan `Bun.secrets` terverifikasi dari dokumen resmi (bun.com/docs/runtime/secrets, diambil 2026-11): `get/set/delete({service,name[,value]})` async, `persist: "local"|"enterprise"` hanya Windows, batas panjang 2048-4096 byte. WebSearch/WebFetch gagal saat riset, dokumen diambil lewat `curl`; status "stabil" tidak terbukti, hanya label "experimental".

## 7. Model ancaman

| Penyerang | Apa yang bisa dibaca/dilakukan (default tanpa env) | Mitigasi dalam rancangan |
|---|---|---|
| Pengguna lokal lain (host bersama) | Shell via loopback terbuka (T1); baca `webterm.db`/log 0644 (T4) | Data dir 0700 + db 0600 (W3); token opt-in (D) |
| Halaman web jahat di browser pengguna | DNS rebinding → `/ws` shell (T2) | Host allowlist (W1) |
| Peretas jaringan (bind non-loopback) | Token sniffing bila HTTP polos; brute-force tak ada throttle di gerbang root `[BT]` | Token 256-bit; wajib TLS reverse proxy (docs); `WEBTERM_ALLOWED_HOSTS` |
| Proses sesama uid (agent/shell di dalam PTY) | Sudah punya shell; dapat membaca `secrets/*` & `webterm.db` | Tidak ada pertahanan nyata di model ini (sama uid); jangan mengklaimnya. Pisah uid/container jika perlu |
| Pencuri backup/dump data dir | Token bot, kunci vault + blob cookie (kunci dan blob satu dir) | Docs: backup `secrets/` dienkripsi; pisahkan kunci vault dari blob `[opini]` |
| Orang di belakang bahu / log | Token di terminal & URL | Cetak hanya TTY, sekali; klien membuang `?token=` dari bar; tidak masuk log |
| `.env` terlupa di cwd | Kunci tak berawalan mengalir ke PTY (T5) | Provenance-filter (W4), peringatan boot |

## 8. Implikasi untuk webterm

**Rekomendasi tegas**
1. Boot tanpa env sudah jalan untuk loopback; jangan menulis ulang boot. Perbaiki tiga celah nyata: Host allowlist (T2), data dir/db 0700/0600 (T4), pewarisan `.env` ke PTY (T5).
2. Token: Opsi D. Non-loopback tanpa token membangkitkan + persist (bukan crash); loopback tetap terbuka sampai pengguna opt-in lewat UI/berkas. Penyimpan secret = berkas 0600 yang sudah ada; `Bun.secrets` dan SQLite terenkripsi ditolak.
3. Bunfig autoload dimatikan di binary segera; dotenv autoload dimatikan HANYA setelah impor `.env` (topik 53) tersedia.
4. Tambah satu tes `bun test` "boot tanpa env" (spawn `index.ts`, `env -i`, port acak, tmp data dir) sebagai gerbang regresi: loopback 200, `HOST=0.0.0.0` exit 1, Host liar 403.

**Risiko**: Host allowlist memutus akses via IP LAN/proxy (mitigasi `WEBTERM_ALLOWED_HOSTS` + pesan jelas). Token persisten di volume ephemeral Docker berubah tiap start (docs: mount `WEBTERM_DATA_DIR`). Urutan efek samping impor (T7) bisa membuat token ter-bootstrap sebelum `dataDir` final bila refactor ceroboh. Perubahan `ptyEnv` provenance bisa membuang variabel yang pengguna harapkan; kompat: hanya kunci yang nilainya identik dengan `.env`.

**Keputusan yang perlu user** (default usulan)
| # | Pertanyaan | Default |
|---|---|---|
| K1 | Loopback tanpa token tetap default? | Ya (Opsi D); B hanya opt-in |
| K2 | Cetak URL ber-token di terminal TTY? | Ya, hanya TTY, sekali, tidak masuk log |
| K3 | Binary: matikan autoload dotenv? | Tunggu impor (topik 53); bunfig dimatikan sekarang |
| K4 | `Bun.secrets` sebagai backend opsional? | Tidak sekarang |
| K5 | Tambah `WEBTERM_ALLOWED_HOSTS` (bootstrap-only) ke registry? | Ya; mohon topik 51/53 menampungnya |

**Workstream usulan** (nama | berkas milik | ukuran)
| WS | Isi | Berkas milik | Ukuran |
|---|---|---|---|
| W1 `boot-hostcheck` | Host allowlist di `authorize()` + tes rebinding | `src/server/auth.ts`, `auth.test.ts` | S |
| W2 `boot-token-bootstrap` | Bangkitkan/persist/baca token, pesan TTY, tes `env -i` boot | `src/server/tokenBootstrap.ts` (baru) + tes, `index.ts` (hanya baris 38-45 area) | M |
| W3 `boot-perms` | `mkdirSync(..., {mode:0o700})`+chmod, db 0600, pindahkan efek samping sebelum validasi bila murah | `src/server/config.ts`, `db.ts`, tes | S |
| W4 `boot-dotenv-hygiene` | Peringatan `.env`, provenance-filter `ptyEnv`, flag `build:binary` (bunfig) | `src/server/ptyShell.ts`, `package.json` (`build:binary`), tes | M |
| W5 `boot-errors` | `PORT` invalid dan EADDRINUSE ramah, HOST default konsisten | `src/server/serverConfig.ts`, `index.ts` (listen error), tes | S |
| W6 `ui-token-optin` | Tombol "Aktifkan/Putar token" di Pengaturan + (fase 2) cookie sesi | `src/server/settingsApi.ts`, klien Pengaturan | M |
| W7 `docs-envmin` | README, `.env.example` (kecil), CHANGELOG, docs keamanan/TLS — satu worker di akhir | `README.md`, `.env.example`, `CHANGELOG.md` | S |

Urutan: W1, W3, W5 paralel → W2 → W4 → W6 → W7. Stop-gate: typecheck, `npm test`, `bun test src/server/*.bun.test.ts`, tes boot-tanpa-env hijau. Nama `WEBTERM_TOKEN`, `x-nodeterm-node-token`, `NODETERM_*` tidak diubah.
