# PLAN ENV-MINIMAL (b2) — Matriks tes, tes boot `env -i`, risiko, stop-gate, rollback

Lanjutan `ENV-MINIMAL-b.md` (kontrak §0-§7). ID WS = (a) §6. Perintah baku: `TMPDIR=/tmp/st npm run typecheck` · `TMPDIR=/tmp/st npm test` · `TMPDIR=/tmp/st bun test --no-env-file src/server/<berkas>.bun.test.ts` (macOS: batas `sun_path` 104). Semua tes yang menyentuh disk memakai `mkdtemp` di `/tmp`, `WEBTERM_DATA_DIR`/`HOME` palsu; DILARANG menyentuh `~/.webterm-server` atau membaca `.env` nyata (S3). Aturan asersi: nilai token/secret TIDAK boleh muncul di keluaran, jadi tes membaca nilai dari berkas lalu menegaskan `not.toContain(nilai)` pada stdout/stderr/log/respons (kecuali respons `enable`/`rotate`).

## 8. Matriks tes per WS (berkas | asersi kunci minimum)

### 8.1 W0

| WS | Berkas tes | Asersi kunci |
|---|---|---|
| EM-01 hostcheck | `hostAllow.test.ts` (baru) | `buildAllowedHosts({host:'127.0.0.1',port:8700,env:{}})` mengizinkan `localhost:8700`, `127.0.0.1:8700`, `[::1]:8700`; menolak `evil.example:8700`, kosong, array 2 elemen; bind `0.0.0.0` TIDAK menambah `0.0.0.0` ke himpunan; `ALLOWED_HOSTS='a.example, B.EXAMPLE:9000,*.x,http://y,'` -> `a.example` (port apa pun) dan `b.example:9000` (tepat) lolos, `ignored===2`; 33 entri valid -> hanya 32 dipakai; `a.example.` (titik akhir) = `a.example`; `safeHostForLog('a\r\nb'.repeat(200))` tanpa CR/LF dan panjang <= 253 |
| EM-01 | `auth.host.test.ts` (baru; `auth.test.ts` 470 baris TIDAK diubah) | rebinding `Host: evil.example:8700`+`Origin: http://evil.example:8700` -> `authorize` false saat allowlist ada, true saat `undefined`; `Host: 127.0.0.1:8700` tanpa Origin -> true; fungsi-penyedia yang mengembalikan `undefined` -> perilaku lama; `denyReason` = `'host'`; Origin lintas-situs tetap `'origin'` (urutan tak berubah) |
| EM-02 token-bootstrap | `tokenBootstrap.test.ts` (baru, vitest + `mkdtemp`) | env `' tok…32+ '` -> `{token trim,'env',false}` dan berkas TIDAK dibuat; tanpa env + tanpa berkas + host `0.0.0.0` -> berkas ada, `statSync(...).mode & 0o777 === 0o600`, dir `0o700`, token cocok `TOKEN_SHAPE`, panjang 43, `created===true`; start kedua pada dir sama -> token identik, `created===false`; loopback + tanpa berkas -> `{undefined,'none'}` dan tak ada berkas/dir dibuat; berkas ada tapi isi `'abc'` -> melempar, pesan memuat path TANPA isi; berkas mode 0644 -> melempar (store `read` null) dan berkas tak diubah; env + berkas ada -> `'env'` menang; `generate` injeksi dipakai; `persistToken` menolak bila baca-ulang beda (stub); pesan galat tak memuat token |
| EM-03 data-perms | `config.perms.bun.test.ts` (baru) | dir baru 0700; dir lama 0755 milik uid -> 0700 sekali per proses; DB 0600 (dan `-wal`/`-shm` tak lebih longgar `[BT]`); chmod gagal (dir read-only) -> tidak melempar, stderr tanpa nilai env; `:memory:` tak disentuh |
| EM-04 registry-clean | `envRegistry.invariants.test.ts` (+10), `envRegistry.test.ts` | `BOOTSTRAP_ONLY_KEYS` panjang 11 dan memuat `WEBTERM_ALLOWED_HOSTS`; PUT `WEBTERM_ALLOWED_HOSTS` -> `bootstrap_only`; 4 kunci mati ada di `RETIRED_KEYS`, registry 62 entri; override lama kunci pensiun tetap di blob (F8) dan state tak memuatnya; `redactSecrets` tanpa `CHANNEL_HMAC_SECRET` |
| EM-05 dotenv-hygiene | `dotenvFiles.test.ts` (baru), `ptyShell.test.ts` (+45), `envSettings.dotenvNotice.test.ts` (baru) | `dotenvKeys` dengan `read` injeksi: `.env`=`A=1\nB=2\nexport C=3`, env `{A:'1',B:'9',C:'3'}` -> `{A,C}` (B ditimpa shell); `NODE_ENV=production` membaca `.env.production` bukan `.env.development`; berkas > 256 KiB dilewati; `ptyEnv`: `TELEGRAM_BOT_TOKEN` selalu hilang; kunci `FOO` asal `.env` hilang; `OPENAI_API_KEY` asal `.env` TETAP; `PATH`/`HOME` asal `.env` TETAP; kunci non-`.env` (`FOO` dari shell) TETAP; `WEBTERM_*`/`NODETERM_*`/`PORT`/`HOST` tetap tersapu seperti dulu; notis: `.env` ada + 2 kunci registry bersumber env -> tepat 1 `warn` memuat `count:2` dan nama kunci, `not.toContain` nilai; `.env` tidak ada -> 0 warn; dua kali panggil -> tetap 1 |
| EM-06 tooling-flags | tidak ada kode; verifikasi perintah | `grep -n "no-env-file" package.json CLAUDE.md` memuat `test:bun`; `build:binary` memuat `--no-compile-autoload-bunfig`; `npm run test:bun` hijau pada cwd yang punya `.env` palsu di `/tmp` (kunci sentinel tak terlihat tes) |
| EM-07 provenance | `envSettings.state.test.ts` (+40) | override ≠ env -> `envShadowed===true`; override == env -> properti TIDAK ada; tanpa env -> tidak ada; secret override + env ada -> `true` tanpa nilai di JSON (`JSON.stringify(state)` tak memuat sentinel); `*_FILE` terpasang -> sumber `env`; snapshot lama utuh (`toEqual` entri tanpa shadow) |
| EM-08 files-defaults | `envRegistry.files.test.ts` (+20) | 4 flag baca-saja default `on`, `MUTATE`/`UPLOAD` `off`; env `WEBTERM_FILES_VIEWERS=off` dan override `off` menang; `filesFlagOn` selaras |

### 8.2 W1-W4

| WS | Berkas tes | Asersi kunci |
|---|---|---|
| EM-09 default-invariants | `envRegistry.defaults.test.ts`, `envModuleRead.test.ts` (baru) | tiap default registry == default pembaca (daftar tersurat, selisih = gagal); grep statis: `^(export )?const .* = .*process\.env` pada berkas non-bootstrap = daftar putih eksplisit (hari ini: `launchLine.ts`, `agentStatusAuth.ts`, `logger.ts`, `logBus.ts`) |
| EM-10 legacy-alias | `telegramSender.legacy.test.ts` (baru) | token via alias lama tetap bekerja; tepat 1 `warn` per proses (panggil 3x); `warn` tanpa nilai token; `WEBTERM_TELEGRAM_BOT_TOKEN` menang atas alias |
| EM-11 flag-dialect | `envFlag.test.ts`, `channelsMasterGate.dialect.test.ts` | tabel `parseFlag`: `on ON 1 true ' on '`->on, `off 0 false`->off, `'' yes onn`->undefined; `flagOn('onn')===false`; `WEBTERM_CHANNELS` `1`->on, `0`->off, `maybe`->fail-closed; `LOG_FILE` `0/false/off` mati, kosong menyala; tes statis: tiga kunci keamanan tetap `=== '1'` |
| EM-12 import-env | `envSettings.import.test.ts` (baru), `envSettings.api.test.ts` (+40) | dry-run tidak menulis apa pun (blob override sebelum == sesudah); `add/same/conflict/skip` untuk .env sintetis `A` valid baru, `B` sama, `C` beda, `HOST=1`; `HOST`/`PORT`/`WEBTERM_TOKEN` -> `skip/bootstrap`, nilai tak valid -> `skip/invalid`; kunci `dangerous` tanpa `rootGate` -> `skip/needs_root` dan setelah apply TIDAK tertulis; dengan `rootGate` -> tertulis; apply atomik (satu kunci memicu galat tulis secret -> rollback, `applied` tak naik); secret masuk `secrets/` 0600 bukan DB; `JSON.stringify(respons)` tak memuat nilai sentinel mana pun; `.env` hilang -> `found:false`; body mencoba `path:'/etc/passwd'` -> diabaikan; > 64 KiB -> 413; terkunci -> status sama dengan PUT |
| EM-13 central-flag | `centralHost.test.tsx` (+15) | panel mengikuti state server `WEBTERM_CENTRAL_CHAT`; state belum termuat = off; tanpa `import.meta.env` tersisa (`grep` di tes statis) |
| EM-14 boot-wiring | `boot.zeroenv.bun.test.ts` (baru), `serverConfig.bun.test.ts`, `listenError.test.ts`, `auth.test.ts` (hanya penghapusan) | §9 |
| EM-15 token-optin | `tokenAccess.api.test.ts` (baru), `control/mount.rootToken.test.ts` `[BT seam]` | lihat tabel 8.3 |
| EM-16 docs | tidak ada kode | `.env.example`: tepat 9 kunci bootstrap aktif/komentar, nol kunci non-bootstrap (skrip `grep` di verifikasi); README net karakter <= 0 |

### 8.3 EM-15 `tokenAccess.api.test.ts`

| Kasus | Asersi |
|---|---|
| `enable` dari peer loopback, source none | 200; body `{token}` cocok `TOKEN_SHAPE`; `Cache-Control: no-store`; berkas 0600 berisi token yang sama; `getTokenState().source==='file'`; `process.env.WEBTERM_TOKEN` sama; request berikutnya tanpa token 401/403, dengan token 200; `rootGate()` benar |
| `enable` dua kali / konkuren | kedua 409 `already_enabled` (yang kalah), tepat 1 berkas, tepat 1 token valid |
| peer bukan loopback (`remoteAddress` `10.0.0.5`) | 403 `loopback_only`; `X-Forwarded-For: 127.0.0.1` diabaikan; state tak berubah |
| gagal tulis (dir read-only) | 500 `token_persist_failed`; source tetap none; tak ada berkas parsial; log tanpa token |
| `rotate` dengan token berlaku | 200 token baru ≠ lama; lama 401 seketika; berkas diperbarui; env tersinkron |
| `rotate` source env | 409 `env_managed`, berkas tak dibuat; source none -> 409 `not_enabled` |
| `GET /api/settings/token` | tanpa field nilai; `canEnable` benar hanya none + loopback |
| nilai token di log | sink logger menangkap seluruh entri selama alur: tak ada yang memuat token |
| `mount.rootToken` | setelah `enable`, deps default mengembalikan token baru (getter), bukan `undefined` yang ter-cache |
| `dangerous` setelah enable | PUT `WEBTERM_CENTRAL_AGENTS=on` yang sebelumnya ditolak (rootGate salah) kini lolos dengan token |

## 9. Tes "boot tanpa env" (EM-14, `boot.zeroenv.bun.test.ts`, <=200 baris; dijalankan `bun test --no-env-file`)

Mekanisme: `Bun.spawn(['env','-i', ...pasangan, process.execPath,'--no-env-file','src/server/index.ts'], { cwd: tmpCwdKosong })`. Pasangan HANYA `HOME=<tmp>`, `WEBTERM_DATA_DIR=<tmp>/data`, `PORT=<port bebas hasil listen+tutup>` (+ variabel kasus). `PORT` ada karena `PORT=0` ditolak dan 8700 bisa bentrok; ini satu-satunya env non-isolasi. Kesiapan = polling TCP sampai `GET /api/settings/env` menjawab (batas 15 dtk). `afterAll` mematikan SEMUA anak (`kill` + await exit) agar tak ada proses yatim.

| Kasus | Setup | Asersi |
|---|---|---|
| Z1 loopback tanpa env | tanpa variabel tambahan | server naik; `GET /api/settings/env` 200 tanpa token; `data/` mode 0700; `webterm.db` 0600; TIDAK ada `secrets/WEBTERM_TOKEN`; stderr bersih dari `Error`/`EADDRINUSE`/`throw` |
| Z2 non-loopback tanpa token | `HOST=0.0.0.0` | naik (tidak crash); berkas token 0600 panjang 43; `GET` tanpa token 401/403; dengan `x-webterm-token` 200; stdout+stderr (pipa, bukan TTY) memuat path berkas, TIDAK memuat nilai token |
| Z3 token persisten | boot ulang Z2 pada `data/` yang sama | token berkas identik; tidak dibuat ulang |
| Z4 env menang | `HOST=0.0.0.0` + `WEBTERM_TOKEN=<sentinel 40 karakter>` | token env diterima; TIDAK ada berkas token; keluaran tak memuat sentinel |
| Z5 berkas rusak | tulis `secrets/WEBTERM_TOKEN`='x' lalu boot | proses keluar non-nol dalam batas waktu, pesan memuat path, tak memuat isi; `webterm.db` TIDAK dibuat (urutan §2.4 langkah 4 < 7) |
| Z6 PORT invalid | `PORT=abc` | keluar non-nol, pesan menyebut `PORT` (nilai boleh, bukan secret), tanpa stack mentah |
| Z7 rebinding | Z1 + socket TCP mentah (`Bun.connect`, Host tak bisa diubah via `fetch`) | `Host: evil.example:<port>`+`Origin: http://evil.example:<port>` -> 403 `host_not_allowed`; `Host: localhost:<port>` -> 200 |
| Z8 enable lalu Host | Z1 + `POST /api/settings/token/enable` | 200; lalu `Host: 192.168.1.5:<port>` + token benar -> 200 (allowlist mati setelah token ditegakkan, D-b1) |
| Z9 `.env` di cwd | tulis `.env` sintetis (`WEBTERM_LEDGER=on`, `TELEGRAM_BOT_TOKEN=sentinel`) di cwd tmp, BOOT TANPA `--no-env-file` | notis boot `warn` menyebut nama kunci saja; sentinel tak muncul di keluaran |

Z9 menguji `ptyEnv` secara unit (bukan lewat PTY nyata) karena spawn PTY memerlukan sesi; asersi PTY ada di `ptyShell.test.ts`.

## 10. Risiko dan mitigasi

| ID | Risiko | P×D | Mitigasi |
|---|---|---|---|
| R-01 | Token berkas diam-diam mengubah perilaku `curl localhost` hanya setelah `enable` (opt-in) | rendah×rendah | `enable` eksplisit; loopback tanpa token tak berubah; dokumentasikan di CHANGELOG |
| R-02 | Downgrade: versi lama mengabaikan `secrets/WEBTERM_TOKEN` -> loopback terbuka lagi tanpa peringatan | sedang×tinggi | catatan rilis + `docs/decisions/env-minimal.md`; tidak ada kode penanganan (versi lama tak bisa diubah) |
| R-03 | `rootToken` ter-cache di `control/mount.ts` basi setelah `enable`/`rotate` | tinggi×sedang | D-b2 getter + tes `mount.rootToken` (EM-15) |
| R-04 | Proses lokal lain menang balapan `enable` | rendah×sedang | setara T1; opsi P+ (b §3.3) bila user menghendaki |
| R-05 | Host allowlist memblokir pengguna proxy-ke-loopback tanpa token | sedang×sedang | `WEBTERM_ALLOWED_HOSTS`; 403 `host_not_allowed` jelas; D-b1 membatasi ke mode terbuka |
| R-06 | Impor `.env` menulis `dangerous`/bootstrap tanpa gerbang | rendah×tinggi | satu-satunya jalur tulis = `service.update()`; tes `needs_root` dan `skip/bootstrap`; stop-gate S4 |
| R-07 | Provenance salah menyapu variabel yang dipakai CLI agen | sedang×sedang | daftar-simpan provider+OS; tes tiga kasus; bila ragu worker melapor, bukan menambah regex |
| R-08 | Perubahan `index.ts` menambah beban file yang sudah > batas Rule 8 | tinggi×rendah | jatah +30/+8, hanya panggilan fungsi; logika di modul baru |
| R-09 | Tes boot flaky (port, waktu start) | sedang×rendah | port bebas dinamis, polling berbatas, kill di `afterAll`, retry nol (flaky = bug, bukan retry) |
| R-10 | Kegagalan chmod di volume Docker/NFS memutus boot | rendah×sedang | chmod best-effort: `warn` satu baris tanpa nilai, tidak melempar (EM-03) |
| R-11 | Token tertulis di keluaran TTY tertangkap multiplexer/rekaman terminal | rendah×sedang | hanya TTY, sekali, bukan log; pengguna dapat memutar lewat `rotate` |
| R-12 | `util.parseEnv` berbeda dari parser Bun untuk kasus tepi (kutip bersarang, interpolasi `${X}`) | rendah×rendah | pratinjau menunjukkan nama/aksi; nilai invalid -> `skip/invalid`; tidak ada interpolasi |
| R-13 | Daftar dokumen (a)/(b)/(c) memakai penomoran EM berbeda | sedang×sedang | (a) §6 otoritatif; orkestrator menyamakan (c) sebelum dispatch |

## 11. Stop-gate (melengkapi S1-S7 di (a) §9; berhenti dan lapor, jangan lanjut gelombang)

| ID | Kondisi |
|---|---|
| S8 | tes lama `auth.test.ts` (selain penghapusan `resolveToken`) atau `service.test.ts:17,31,202` harus diubah agar hijau |
| S9 | `index.ts` melewati jatah (+30 / +8) atau memuat logika selain panggilan fungsi |
| S10 | `env -i` boot (Z1) butuh variabel selain `HOME`, `WEBTERM_DATA_DIR`, `PORT` |
| S11 | nilai token/secret terdeteksi di stdout/stderr/log/ring buffer/respons di luar pengecualian (TTY boot, respons `enable`/`rotate`) |
| S12 | `enable` berhasil dari peer non-loopback, atau bekerja saat source bukan `none` |
| S13 | berkas token rusak membuat server naik terbuka (harus fail-closed, Z5) atau menimpa berkas |
| S14 | provenance menyapu kunci provider atau `PATH`/`HOME` dari PTY |
| S15 | impor menyentuh path selain `<bootCwd>/.env`, atau menulis/menghapus `.env` |
| S16 | gerbang gelombang (typecheck + `npm test` + `bun test --no-env-file src/server/*.bun.test.ts`) merah di branch int |

Gerbang tiap gelombang: tiga perintah di atas, hijau, `git status --short` hanya berkas milik WS, `~/.webterm-server` mtime tak berubah.

## 12. Rollback dan kompatibilitas mundur

| Fitur | Rollback | Data tertinggal / kompat |
|---|---|---|
| Token berkas | hentikan server, hapus `<dataDir>/secrets/WEBTERM_TOKEN`, nyalakan: loopback terbuka lagi. Atau `WEBTERM_TOKEN` env (menang atas berkas) | berkas 0600 tak berbahaya; versi lama mengabaikannya (R-02) |
| `enable`/`rotate` | tak ada `disable` API (sengaja); pakai hapus berkas di atas | - |
| Non-loopback tanpa token | versi lama crash dengan pesan jelas; baru membangkitkan token. Rollback kode = perilaku lama | token yang dibangkitkan tetap di berkas |
| Host allowlist | isi `WEBTERM_ALLOWED_HOSTS` dengan host yang dipakai; revert kode EM-01/EM-14 mengembalikan perilaku lama (parameter opsional `undefined`) | tak ada data |
| `ptyEnv` provenance | revert EM-05; kunci asal `.env` kembali diwarisi PTY | tak ada data |
| Data dir 0700 / db 0600 | `chmod` manual bila perlu cadangan oleh uid lain; kode tak mengembalikan otomatis | izin tetap seperti terakhir diset |
| Impor `.env` | hapus entri hasil impor lewat PUT `unset` atau Settings; `.env` asli tak pernah diubah | blob `app.env_overrides` (format tak berubah) |
| 4 kunci mati dihapus | override lama tetap di blob (F8); registry lama yang dipasang kembali membaca ulang | tak ada |
| `envShadowed` | field opsional; klien lama mengabaikannya | - |
| Flag dialek | `WEBTERM_X=1` kini on (sebelumnya off); rollback = revert EM-11 | catat di CHANGELOG sebagai Changed |
| `EnvEntryV2`/`EnvStateV2` | hanya penambahan field opsional (`envShadowed`, `server.tokenSource` bila dipakai CHENV) | kompat dua arah |
| Skema DB | tidak ada perubahan (Rule 4 tak terpicu) | - |

Perubahan perilaku untuk CHANGELOG (EM-16, satu worker): L3 non-loopback tanpa token membangkitkan token; L4 Host allowlist (mode terbuka); L8 variabel asal `.env` tak masuk PTY; L10 flag `1/true`; L13 izin dir/DB; L9 alias `TELEGRAM_BOT_TOKEN` deprecated.

## 13. Keputusan yang butuh user (default (b) bila diam)

| # | Keputusan | Default (b) | Mengubah keamanan? |
|---|---|---|---|
| U1 | G1: Opsi P (enable dari Settings) vs Opsi R (kode admin) vs pengerasan P+ (kode klaim) | P tanpa P+ | Ya (opt-in; sesudahnya lebih ketat) |
| U2 | D-b1: allowlist Host hanya saat token tak ditegakkan (vs semua mode, (a) L4) | hanya saat tak ada token | Ya (cakupan pagar) |
| U3 | URL ber-token dicetak ke stderr TTY saat token dibangkitkan (L3-4) vs hanya path berkas | cetak (sesuai (a)) | Sedikit (token tampil di terminal) |
| U4 | D4/L11 fitur berkas baca-saja default on | on (usul 51) | Ya (permukaan baca berkas) |
| U5 | D-b2/D-b3: tambah `control/mount.ts` ke EM-15 dan hak hapus-saja `auth.ts` ke EM-14 | ya | Tidak |
| U6 | Provenance `ptyEnv` (L8, D-b5) tetap dikerjakan atau dicabut | kerjakan | Ya (variabel PTY berubah) |

Hal di luar mandat yang diflag (Rule 21): `goldenHarness.ts` memutasi `process.env` tanpa restore; cookie sesi `HttpOnly` sebagai pengganti `?token=`; penutupan WS yang sudah terbuka saat `rotate`.
