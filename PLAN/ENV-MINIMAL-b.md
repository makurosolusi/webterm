# PLAN ENV-MINIMAL (b) — Kontrak teknis: token, Host, ptyEnv, impor `.env`, G1

Seri: (a) `ENV-MINIMAL-a.md` (keputusan L1-L15, peta EM-01..16, kepemilikan berkas) · (b) ini · (b2) `ENV-MINIMAL-b2.md` (matriks tes, tes boot `env -i`, risiko, stop-gate, rollback) · (c) PREAMBLE + spek tempel. Dokumen ini TIDAK mengulang (a): hanya kontrak yang dipatuhi worker. Label: `[V]` diverifikasi di worktree · `[BT]` worker cek dulu. Tanpa kode produksi: tanda tangan tipe dan tabel perilaku saja. ID WS = penomoran (a) §6; bila (c) berbeda, (a) menang.

## 0. Deviasi dan tambahan terhadap (a) — orkestrator putuskan sebelum dispatch

| ID | Temuan | Usul (b) |
|---|---|---|
| D-b1 | (a) L4 menerapkan allowlist Host di SEMUA mode. Dengan token ditegakkan, rebinding tak berbahaya (penyerang tak punya token) tetapi pengguna LAN/proxy-ke-loopback yang sah ikut diblokir | Allowlist aktif HANYA saat `tokenState.source === 'none'` (dievaluasi per request, jadi mati sendiri setelah `enable`). Mengganti ke "selalu" = ubah satu kondisi di EM-14 |
| D-b2 | `control/mount.ts:64` men-cache `rootToken: process.env.WEBTERM_TOKEN` di `defaultDeps` (modul). Setelah `enable`/`rotate` runtime, nilai basi: route mint tak muncul / token lama dipakai `[V]` | EM-15 memiliki `src/server/control/mount.ts`, ganti ke properti getter (`get rootToken()`), maks +3 baris. Berkas ini TIDAK ada di tabel kepemilikan (a) §7 |
| D-b3 | `auth.ts:51 resolveToken` (melempar) mati setelah `bootstrapToken` dikabel; Rule 17 melarang kode mati. Pemilik `auth.ts` = EM-01 (W0) | EM-14 (W2) diberi hak HAPUS-SAJA di `auth.ts` (`resolveToken`, -14 baris) dan kasus terkait di `auth.test.ts` (hanya penghapusan) |
| D-b4 | "<=9 kunci bootstrap" vs 10 kunci `BOOTSTRAP_ONLY_KEYS` + `WEBTERM_ALLOWED_HOSTS` = 11 di registry | Sesuai (a) L1: 9 DIDOKUMENTASIKAN; `WEBTERM_HOST` dan `WEBTERM_TELEGRAM_API_BASE` tetap dibaca, tak didokumentasikan. `envRegistry.invariants.test.ts:195` `toHaveLength(10)` -> 11 (EM-04) |
| D-b5 | 51 D5 (jangan sapu kunci provider) vs filter provenance 52 W4 (menyapu semua kunci asal `.env`) | Daftar-simpan provenance = kunci provider + kunci OS (§5). Selalu sapu `TELEGRAM_BOT_TOKEN` |
| D-b6 | Pembangkitan otomatis webhook secret (tabel 51) bertabrakan dengan "secret tak pernah di respons API" | TIDAK dibangkitkan. Mode poll (default bila bot token ada) tak butuh |

## 1. Konstanta bernama (Rule 15; tak ada literal di tempat pakai)

| Nama | Nilai | Berkas | Catatan |
|---|---|---|---|
| `TOKEN_SECRET_KEY` | `'WEBTERM_TOKEN'` | `tokenBootstrap.ts` | nama berkas di `<dataDir>/secrets/`; lolos `KEY_SHAPE` `[V]` |
| `TOKEN_BYTES` | `32` | idem | 32 byte acak -> base64url 43 karakter, tanpa padding |
| `TOKEN_SHAPE` | `/^[A-Za-z0-9_-]{32,128}$/` | idem | validasi isi berkas (setelah `trim`) |
| `SECRETS_DIR_MODE` / `SECRET_FILE_MODE` | `0o700` / `0o600` | `envSecrets.store.ts` `[V]` | sudah ada; EM-02 tidak mengubah store |
| `ALLOWED_HOSTS_KEY` | `'WEBTERM_ALLOWED_HOSTS'` | `hostAllow.ts` | |
| `ALLOWED_HOSTS_MAX` | `32` | idem | entri valid maks; lebihnya diabaikan + dihitung |
| `HOST_ENTRY_SHAPE` | `/^(\[[0-9a-f:]+\]\|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/` | idem | setelah `trim` + lowercase + buang titik akhir; tanpa skema/path/wildcard/`*` |
| `ALWAYS_ALLOWED_HOSTS` | `['localhost','127.0.0.1','[::1]']` | idem | |
| `HOST_LOG_MAX` | `253` | idem | panjang Host yang boleh masuk log |
| `DOTENV_MAX_BYTES` | `256 * 1024` | `dotenvFiles.ts` | lebih besar = dilewati |
| `TOKEN_ENDPOINT` | `'/api/settings/token'` | `tokenAccess.api.ts` | + `/enable`, `/rotate` |
| `IMPORT_ENDPOINT` | `'/api/settings/env/import'` | `envSettings.api.ts` | body max = `SETTINGS_BODY_MAX_BYTES` (64 KiB) `[V]` |
| `TOKEN_BODY_MAX_BYTES` | `1024` | `tokenAccess.api.ts` | body enable/rotate diabaikan; lebih = 413 |

## 2. Token: format berkas, prioritas, algoritma bootstrap

### 2.1 Format dan izin

| Aspek | Kontrak |
|---|---|
| Lokasi | `<dataDir>/secrets/WEBTERM_TOKEN` (store yang sama dengan secret registry dan browser runtime; kunci bukan kunci registry, jadi overlay Settings tak pernah membaca/menimpanya) |
| Isi | satu string `TOKEN_SHAPE`, tanpa newline wajib (baca selalu `trim`) |
| Izin | berkas 0600, dir 0700, tulis atomik temp + `rename` (`wx`) = perilaku `createFileSecretStore` `[V]`. Tidak ada perubahan store |
| Bukan | bukan kolom DB, bukan `app.env_overrides`, tidak ada di cadangan `webterm.db`. Tidak ada migrasi (Rule 4 tak terpicu) |

### 2.2 Tipe (`src/server/tokenBootstrap.ts`, EM-02; <=200 baris)

```ts
export type TokenSource = 'env' | 'file' | 'none'
export interface TokenState { readonly token: string | undefined; readonly source: TokenSource; readonly created: boolean }
export function bootstrapToken(i: { host: string; env: NodeJS.ProcessEnv; secretsDir: string; generate?: () => string }): TokenState
export function getTokenState(): TokenState            // holder modul; awal { undefined, 'none', false }
export function setTokenState(next: TokenState): void  // HANYA bootstrap, enable, rotate
export function tokenFilePath(secretsDir: string): string
export function mintToken(generate?: () => string): string  // TOKEN_BYTES acak -> base64url
export function persistToken(secretsDir: string, token: string): void  // tulis + baca-ulang + cocokkan, melempar bila beda
```

`generate` hanya seam tes. `created` = true bila proses ini yang membuat berkas (untuk cetak TTY sekali).

### 2.3 Algoritma `bootstrapToken` (urut, berhenti di langkah pertama yang cocok)

| # | Kondisi | Hasil | Efek samping |
|---|---|---|---|
| 1 | `env.WEBTERM_TOKEN` setelah `trim` tak kosong | `{token, 'env', false}` (env menang, L3-3) | tidak menyentuh berkas |
| 2 | berkas ada (`existsSync(tokenFilePath)`) | baca; valid `TOKEN_SHAPE` -> `{token, 'file', false}` | tak ada |
| 2b | berkas ada tetapi `read()===null` atau bentuk tak valid | LEMPAR `token file unreadable or malformed: <path>` (path, bukan isi). FAIL-CLOSED: jangan diam-diam buka akses dan jangan timpa | tak ada |
| 3 | tak ada berkas DAN `!isLoopbackHost(host)` | `mintToken` -> `persistToken` -> `{token,'file',true}` | membuat dir 0700 + berkas 0600 |
| 4 | tak ada berkas DAN loopback | `{undefined,'none',false}` (terbuka sampai `enable`) | tak ada |

Absen vs tak terbaca dibedakan dengan `existsSync` + `read()===null` (store mengembalikan `null` untuk keduanya `[BT]`). Dua proses start bersamaan: `rename` atomik, pemenang terakhir menang; karena `persistToken` membaca-ulang, kedua proses memakai isi yang ada di disk (bukan nilai lokalnya). `isLoopbackHost` diimpor dari `auth.ts` `[V]`.

### 2.4 Urutan efek samping saat boot (EM-14 mengabelkan; dilarang diubah urutannya)

| # | Langkah | Alasan urutan |
|---|---|---|
| 1 | `resolveHostPort(env)` (+ `parsePort` bila EM-14 memasukkannya) | murni; galat sebelum menyentuh disk (T7/T8) |
| 2 | `recordDotenvBoot(cwd, env)` (§5) | HARUS sebelum overlay Settings, yang memutasi `process.env` |
| 3 | `dataDir()` (mkdir 0700 / chmod, EM-03) | tempat berkas token |
| 4 | `bootstrapToken` -> `setTokenState` -> `writeTokenToEnv(state.token)` | seluruh pembaca `process.env.WEBTERM_TOKEN` melihat bentuk kanonik; token tak valid berhenti SEBELUM DB dibuat (T7) |
| 5 | cetak TTY (hanya bila `created`) | lihat 2.5 |
| 6 | bangun `allowedHosts` (§4) | butuh host, port, env |
| 7 | `initEnvSettings()` (DB pertama dibuka) | overlay dimulai; `base` = snapshot env final |
| 8 | sisanya (logging, ledger, kanal, central, browser, PTY) | tak berubah |

Aturan import: tidak ada modul non-bootstrap yang boleh membaca `WEBTERM_TOKEN` pada level modul atau meng-cache hasilnya (satu-satunya pelanggar `[V]`: `control/mount.ts:64`, D-b2). `approvalAuth.ts` membaca per panggilan (aman), `envSettings.runtime.ts` `rootGate` membaca per panggilan (aman: otomatis benar setelah `writeTokenToEnv`).

### 2.5 Keluaran

| Kasus | Kanal | Isi |
|---|---|---|
| `created` dan `process.stderr.isTTY` | `process.stderr.write` langsung (BUKAN `logger`, jadi tak masuk ring buffer/berkas log) | satu baris: `webterm: access token created at <path> (0600). Open: http://<host>:<port>/?token=<token>` (L3-4) |
| `created`, bukan TTY | `logger.info` | HANYA path berkas dan panjang; nilai token tak muncul |
| log listen (`index.ts:243`) | `logger.info` | tetap `on: len=N` / `off: loopback only`; tambah `source` |

## 3. Celah G1 (kunci `dangerous` di loopback tanpa token) — kontrak Opsi P

Keputusan produk sudah di (a) §4 (P direkomendasikan, R alternatif, keputusan user). (b) hanya menetapkan kontrak P dan satu opsi pengerasan.

### 3.1 Endpoint (EM-15, `tokenAccess.api.ts` <=150 baris, dipasang lewat `settingsApi.ts` +6)

| Metode + path | Prasyarat | Hasil | Galat |
|---|---|---|---|
| `GET /api/settings/token` | gerbang normal | `{ enforced: boolean, source: 'env'\|'file'\|'none', canEnable: boolean }` (`canEnable` = source none DAN peer loopback). Tanpa nilai | - |
| `POST /api/settings/token/enable` | source `none`; PEER loopback; lolos `authorize` + Host allowlist; body <= `TOKEN_BODY_MAX_BYTES` | 200 `{ token }` SEKALI; header `Cache-Control: no-store`, `Pragma: no-cache` | 409 `already_enabled`; 403 `loopback_only`; 500 `token_persist_failed` (state tak berubah); 413 |
| `POST /api/settings/token/rotate` | source `file` DAN token berlaku (gerbang normal) | 200 `{ token }` baru SEKALI; token lama tidak berlaku detik itu | 409 `env_managed` (source env); 409 `not_enabled` (none) |

Peer loopback = `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`}; header `X-Forwarded-For` TIDAK dipakai (T-peer). Pada bind non-loopback, source tak pernah `none`, jadi `enable` selalu 409.

### 3.2 Urutan efek samping `enable` (sinkron di satu tick supaya atomik; bila `persistToken` async -> penjaga `enabling` modul, permintaan kedua 409)

| # | Langkah | Gagal -> |
|---|---|---|
| 1 | cek source `none` + peer loopback | 409/403, tanpa efek |
| 2 | `mintToken()` | - |
| 3 | `persistToken(secretsDir, token)` | 500, state tetap `none`, tak ada berkas parsial (rename atomik) |
| 4 | `setTokenState({token,'file',true})` | - |
| 5 | `writeTokenToEnv(token)` (`rootGate` benar, `dangerous` terbuka, mount.ts getter) | - |
| 6 | `logger.info('auth.token_enabled', { source:'file' })` tanpa nilai | - |
| 7 | respons 200 (satu-satunya tempat nilai keluar di luar TTY boot; pengecualian S5 yang disengaja) | - |

Batas jujur (dokumentasikan, jangan klaim lebih): (1) proses lokal sebagai uid yang sama dapat memanggil API terbuka sebelum `enable` dan dapat membaca berkas sesudahnya: tak dilindungi, setara T1 hari ini, tidak ada eskalasi baru. (2) Koneksi WebSocket yang sudah terbuka sebelum `enable`/`rotate` tetap hidup sampai tutup (gerbang dicek saat upgrade). (3) Token per-node (`NODETERM_NODE_TOKEN`) tidak terpengaruh. (4) Tidak ada `disable` via API; kembali ke terbuka = hentikan server, hapus `secrets/WEBTERM_TOKEN`, nyalakan lagi (§rollback di b2).

### 3.3 Pengerasan opsional "P+" (usul, default OFF)

Kode klaim sekali pakai: saat boot source `none`, bangkitkan kode 8 karakter di memori (TTL 30 menit, 5 percobaan, `timingSafeEqual`), cetak ke stderr TTY; `enable` wajib `{ code }`. Menutup proses lokal yang menang balapan pertama pada mesin multi-pengguna, dengan biaya satu langkah salin-tempel. Tidak diimplementasikan di W3 kecuali user memintanya; kontrak P di atas tetap valid (tambah field body opsional).

### 3.4 Kontrak untuk UI (ditangguhkan ke CHENV; DU-4/DU-6)

`GET /api/settings/token` + dua POST di atas; klien menyimpan token ke `sessionStorage['webterm.token']` seperti `api.ts` hari ini `[V]`; 401/403 `host_not_allowed` dibedakan dari 401 token lewat `error`. Tidak ada perubahan `Login.tsx` di plan ini.

## 4. Allowlist Host (EM-01 murni; EM-14 kabel) + `WEBTERM_ALLOWED_HOSTS`

```ts
// src/server/hostAllow.ts (EM-01, <=80 baris)
export interface HostAllowlist { readonly names: ReadonlySet<string>; readonly withPort: ReadonlySet<string>; readonly ignored: number }
export function buildAllowedHosts(i: { host: string; port: number; env: NodeJS.ProcessEnv }): HostAllowlist
export function hostAllowed(hostHeader: string | string[] | undefined, list: HostAllowlist): boolean
export function safeHostForLog(hostHeader: unknown): string   // buang karakter kontrol, potong HOST_LOG_MAX
```

| Aturan | Perilaku |
|---|---|
| Himpunan | `ALWAYS_ALLOWED_HOSTS` ∪ host bind efektif (bila bukan wildcard `0.0.0.0`/`::`) ∪ entri valid `WEBTERM_ALLOWED_HOSTS` (CSV) |
| Normalisasi | `trim`, lowercase, buang titik akhir; Host request dipisah port; IPv6 pakai kurung. Entri tanpa port = port apa pun; entri `host:port` = tepat |
| Ditolak | Host kosong/hilang, ganda (array), tak lolos `HOST_ENTRY_SHAPE`. Entri ngawur diabaikan dan dihitung di `ignored`; boot `warn` satu kali dengan JUMLAH saja |
| Tempat | `authorize()` menerima `allowedHosts?: HostAllowlist \| (() => HostAllowlist \| undefined)`; `undefined` = perilaku lama persis. `denyReason` diperluas `'origin'\|'token'\|'host'`; `authorizeRequest` meneruskan. Berlaku juga di jalur upgrade WS (`allowed()` `[V]` dipakai keduanya) |
| Kapan aktif (D-b1) | EM-14 memberi fungsi yang mengembalikan list HANYA bila `getTokenState().source === 'none'`; selain itu `undefined` |
| Respons | 403 `{ "error": "host_not_allowed" }`; header Host tidak dipantulkan; log `warn` memuat `safeHostForLog` saja |
| Registry | `WEBTERM_ALLOWED_HOSTS` masuk `BOOTSTRAP_ONLY_KEYS` (EM-04); API menolaknya `bootstrap_only`. Env saja, karena mengubahnya lewat API = penyerang melonggarkan pagar sendiri |

## 5. Provenance `ptyEnv` (EM-05)

```ts
// src/server/dotenvFiles.ts (<=100 baris)
export interface DotenvBoot { readonly cwd: string; readonly keys: ReadonlySet<string> }
export function dotenvKeys(i: { cwd: string; env: NodeJS.ProcessEnv; read?: (path: string) => string | null }): ReadonlySet<string>
export function recordDotenvBoot(cwd: string, env: NodeJS.ProcessEnv): DotenvBoot   // sekali, sebelum overlay
export function getDotenvBoot(): DotenvBoot
export const PTY_KEEP_FROM_DOTENV: (key: string) => boolean   // lihat tabel
```

| Aspek | Kontrak |
|---|---|
| Berkas yang dicek | `.env`, `.env.local`, dan `.env.production` bila `env.NODE_ENV==='production'` selain itu `.env.development` (cermin Bun `[V 53 §6]`); dibaca dalam memori, `> DOTENV_MAX_BYTES` dilewati, nilai tak pernah dicetak/di-log |
| Parser | `util.parseEnv` (`node:util`, ada di Bun 1.4.2 `[V 53]`); nol dependensi |
| Himpunan `keys` | kunci yang nilai terparse SAMA dengan `env[key]` saat boot (shell menang atas `.env` pada Bun, jadi kunci yang ditimpa shell tidak masuk) |
| Mengapa sebelum overlay | overlay memutasi `process.env`; setelah itu nilai tak lagi cocok dan provenance hilang |
| `ptyEnv(source, { interactive, platform?, strip? })` | `strip` default = `getDotenvBoot().keys`. Sapu bila `LEAKED_ENV.test(k)` ATAU `k === 'TELEGRAM_BOT_TOKEN'` (regex ditambah) ATAU (`strip.has(k)` DAN `!PTY_KEEP_FROM_DOTENV(k)`) |
| `PTY_KEEP_FROM_DOTENV` | `PROVIDER_ENV_ALLOWLIST` (`central/runtime/opencodeOptions.ts` `[V]`) ∪ kunci OS `PATH HOME SHELL USER LOGNAME LANG LC_* TERM TMPDIR SSH_AUTH_SOCK`. Bila mengimpor opencodeOptions menimbulkan siklus/beban `[BT]`, worker meneruskan daftar lewat `opts.keep` dan melapor |
| Bukan | tidak menyentuh `execRunner.scrubExecEnv`/`claudeOptions`/`opencodeOptions` (sudah allowlist `[V 51]`); tidak menyentuh `pty.ts` |
| Notis boot (EL-03) | `envSettings.runtime.ts` +16 baris: bila `existsSync(join(cwd,'.env'))` DAN ada kunci registry bersumber `env` -> satu `logger.warn('env.dotenv_detected', { count, keys })` berisi NAMA saja |

## 6. Impor `.env` dengan gerbang `dangerous` dan `envShadowed`

### 6.1 Tipe bersama (`src/shared/envSettings.import.contract.ts`, EM-12, <=50 baris)

```ts
export type ImportAction = 'add' | 'same' | 'conflict' | 'skip'
export type ImportSkipReason = 'bootstrap' | 'invalid' | 'needs_root' | 'locked'
export interface ImportItem { key: string; action: ImportAction; dangerous: boolean; secret: boolean; reason?: ImportSkipReason }
export interface EnvImportRequest { apply?: boolean }             // default dry-run
export interface EnvImportResult { found: boolean; ignored: number; items: ImportItem[]; applied?: number; restartRequired?: string[] }
```

### 6.2 Server (`envSettings.import.ts`, <=150 baris; rute di `envSettings.api.ts` +20)

| Langkah | Kontrak |
|---|---|
| Sumber | HANYA `join(getDotenvBoot().cwd, '.env')`; body tidak membawa path (anti baca berkas sembarang). Tidak ada: 200 `{found:false}` |
| Parse | `util.parseEnv`; kunci di luar registry dihitung di `ignored` (nama tak dibocorkan) |
| Klasifikasi per kunci registry | bootstrap -> `skip/bootstrap`; `validateEnvValue` gagal -> `skip/invalid` (nilai TIDAK dicetak di galat); override sama -> `same`; override beda -> `conflict` (TIDAK ditimpa: override menang, L2); belum ada override -> `add` |
| Gerbang `dangerous` | kunci `dangerous` dengan `rootGate()` salah -> `skip/needs_root`; benar -> `add`. Sama persis dengan PUT, tidak ada jalur tulis baru |
| Terkunci | `WEBTERM_ENV_SETTINGS=off` -> status sama dengan PUT terkunci `[BT kode]`, tanpa efek |
| Apply | `apply:true` -> satu panggilan `service.update({ set })` berisi semua `add` (atomik + rollback secret `[V]`); `applied` = jumlah; `restartRequired` dari hasil update. Secret -> store 0600, bukan DB |
| Larangan | tak menulis `.env`, tak menghapusnya, tak memuat nilai di respons/log/galat; bootstrap tak pernah diimpor; tak ada auto-impor di boot (L6) |

### 6.3 `envShadowed` (EM-07)

| Aspek | Kontrak |
|---|---|
| Tipe | `EnvEntryV2.envShadowed?: boolean` (opsional, hanya ditambah; `KNOWN_KEYS_FROZEN` tak disentuh) |
| Nilai | `true` bila `source==='override'` DAN `base[key]` (snapshot env sebelum overlay `[V]`) terisi DAN berbeda dari nilai efektif (secret: dibandingkan di server, hanya boolean yang keluar). Alias `*_FILE` dikenali `sourceOf` (nama kunci `[BT]`) |
| Emisi | field HANYA ditulis bila `true` (entri lain tak berubah -> snapshot/`toEqual` lama aman) |
| Tidak | tidak mengubah presedensi (S1: `service.test.ts:17,31,202` utuh) |

## 7. Jatah baris tambahan (melengkapi (a) §7; Rule 8)

| Berkas | Pemilik | Aksi | Sekarang | Batas |
|---|---|---|---|---|
| `src/server/index.ts` | EM-14 (W2) -> EM-15 (W3) | kabel §2.4 (hanya fungsi, tak ada logika inline) | 259/13.642 (sudah > batas) | EM-14 +30 baris/+1.800 kar; EM-15 +8 |
| `src/server/control/mount.ts` | EM-15 | getter `rootToken` (D-b2) | `[BT]` | +3 |
| `src/server/auth.ts` / `auth.test.ts` | EM-14 | HAPUS `resolveToken` + kasusnya (D-b3) | 186 / 470 | -14 / hanya turun |
| `src/server/tokenBootstrap.ts` (+`.test.ts`) | EM-02 | BARU | - | ~170 / ~250 |
| `src/server/hostAllow.ts` (+`.test.ts`) | EM-01 | BARU | - | ~80 / ~130 |
| `src/server/dotenvFiles.ts` (+`.test.ts`) | EM-05 | BARU | - | ~100 / ~140 |
| `src/server/tokenAccess.api.ts` (+`.test.ts`) | EM-15 | BARU | - | ~150 / ~220 |

Lanjutan: tes, risiko, stop-gate, rollback di `ENV-MINIMAL-b2.md`.
