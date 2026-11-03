# 53b - Env Minimal: Lapisan Konfigurasi (lanjutan, bagian 6-10)

Lanjutan `RND/53-ENV-MINIMAL-CONFIG-LAYERS.md` (bagian 1-5: temuan, peta lapisan, timing overlay, celah G1-G9, opsi A/B/C + rekomendasi A). Notasi sama: `[BT]` belum terverifikasi, `[opini]` penilaian; kutipan `src/server/` kecuali disebut.

## 6. Migrasi pengguna `.env` lama

Prinsip: tidak memutus kompat, tidak menghapus berkas pengguna, tidak mencetak nilai.

| Langkah | Perilaku | Detail |
|---|---|---|
| 1. Deteksi | Saat boot: bila `existsSync('.env')` (nama saja, isi tak dibaca) di cwd DAN ada kunci registry dengan `source:'env'` -> satu log `warn` | Pesan: jumlah dan NAMA kunci, bukan nilai; sekali per boot. Syarat `.env` ada membedakan dari Docker/shell yang sah (tak ada nag untuk `-e`) |
| 2. Impor sekali | Aksi eksplisit di Settings: tombol "Impor dari .env" -> `POST /api/settings/env/import` | Server membaca berkas milik pengguna dengan `util.parseEnv` (tersedia di Bun 1.4.2, diuji: mem-parse `export`, kutip, komentar; tanpa dependensi). Hanya kunci registry non-bootstrap; nilai lewat `validateEnvValue`; secret ke `secrets/`, sisanya ke `app.env_overrides`; kunci `dangerous` butuh root token seperti PUT biasa |
| 3. Pratinjau | Respons dry-run: daftar `{key, action: tambah|sama|konflik, dangerous}` tanpa nilai | Pengguna menyetujui sebelum menulis; update atomik memakai `update()` yang sama (rollback sudah ada) |
| 4. Setelah impor | `envShadowed:false` (override == env). Bila `.env` kemudian diubah, entri tampil "env diabaikan, override aktif" | Mencegah jebakan G3 |
| 5. Bersih-bersih | Panduan saja: "kunci ini boleh dihapus dari `.env`"; app TIDAK mengedit/menghapus `.env` | Berkas milik pengguna; sisakan bootstrap (HOST/PORT/TOKEN) |
| 6. Deprecation | Fase 1 hanya `warn`. Fase 2 (rilis mayor, atas keputusan user): `build:binary` ditambah `--no-compile-autoload-dotenv` | Bun mengautoload `.env` pada binary secara default; flag-nya terverifikasi di `bun build --help` (1.4.2) |

Catatan alternatif: impor otomatis diam-diam saat boot DITOLAK. Menulis override tanpa persetujuan memindahkan kendali ke DB secara tak terlihat (G3) dan, untuk `dangerous`, melewati gerbang root token.

Perilaku Bun yang diverifikasi (probe di `/tmp`, env bersih, Bun 1.4.2):

| Mode | Berkas termuat dari cwd | Catatan |
|---|---|---|
| `bun file.ts` (NODE_ENV kosong) | `.env`, `.env.local`, `.env.development` | env shell menang atas semuanya |
| `NODE_ENV=production` | `.env`, `.env.local`, `.env.production` | |
| `bun test` | `.env`, `.env.test` | `.env.local` dan `.development` TIDAK; `NODE_ENV=test` |
| Binary `--compile` | `.env` (dan `.env.local`/`.development`) dari cwd saat dijalankan | `--no-compile-autoload-dotenv` mematikan |
| `bun --no-env-file`, `bun test --no-env-file` | tidak ada | berfungsi untuk keduanya |

Akibat: "pindahkan ke Settings" hanya berarti bila `.env` benar-benar dikosongkan; dev `bun run dev` dan binary bisa membawa `.env.local`/`.env.development` yang tidak diketahui README.

## 7. `.env.example` dan README

**Selisih saat ini** (dihitung dengan skrip): `.env.example` memuat 51 nama; registry punya 21 kunci yang tidak ada di sana (`WEBTERM_TELEGRAM_MODE`, `WEBTERM_OPENCODE_ALLOW_TOOLS`, `WEBTERM_LOG_*` x3, `WEBTERM_BROWSER*` x8, `WEBTERM_FILES_*` x8); 4 kunci bootstrap tak ada (`WEBTERM_HOST`, `WEBTERM_DATA_DIR`, `WEBTERM_TELEGRAM_API_BASE`, `WEBTERM_ENV_SETTINGS`); tidak ada kunci yatim. 131 baris, sebagian besar menyalin deskripsi registry (duplikasi yang pasti basi).

**Usul `.env.example` baru (~25 baris)**: hanya tier bootstrap + satu pointer.
- Aktif/komentar: `HOST`, `PORT`, `WEBTERM_TOKEN` (kosong), `WEBTERM_DATA_DIR`, `WEBTERM_ENV_SETTINGS` (`off` untuk deployment immutable), dan 3 saklar keamanan env-only (`ALLOW_LOOPBACK_APPROVAL`, `ALLOW_TOKEN_MINT`, `STRICT_HOOK_AUTH`), `WEBTERM_TELEGRAM_API_BASE` bila diperlukan.
- Header: "Semua fitur lain diatur di Settings > Environment. Berkas ini opsional; app jalan tanpanya."
- Catatan 2 baris yang sudah benar dan harus dipertahankan: Bun mengautoload `.env` (untuk binary juga), jadi secret yang tak ingin diwarisi jangan ditaruh di sini; `chmod 600`.
- Komentar `VITE_WEBTERM_CENTRAL_CHAT` hilang setelah G7.

**README** (aturan global 16: update terbatas, narasi milik user): bagian env README baris 26-67 (+69, 81-85) mendaftar ~50 kunci. Usul: pertahankan HANYA kunci bootstrap + satu paragraf "Settings > Environment" + tautan ke registry (sumber kebenaran); baris per-fitur tidak dihapus oleh worker tanpa persetujuan user [flag, bukan keputusan editorial saya]. Tambah satu invarian tes: tiap kunci registry punya `description` (sudah ada, `envRegistry.invariants.test.ts`), jadi README tak perlu mengulang.

## 8. Dampak ke dev workflow, tes, klien, Docker/CI

| Area | Fakta | Dampak/rekomendasi |
|---|---|---|
| `bun run dev` (`package.json:7`) | Bun autoload `.env*` di cwd; Vite middleware di port yang sama (`vite.config.ts:8-9`) | Tanpa `.env` jalan dengan default; tak ada perubahan kode. Dev yang punya `.env` melihat notis deprecation (langkah 1) |
| vitest (`npm test`, node) | Tidak ada autoload `.env` ke `process.env`; 48 berkas tes menyentuh `process.env` (115 baris `WEBTERM_/HOST/PORT`), 35 `stubEnv`/sejenis [hitung grep] | Aman; tes service memakai `target` injeksi (`createEnvSettings({target})`). **Aturan**: kode baru (impor, token) menerima `env`/`dataDir` lewat parameter, tes memakai direktori `/tmp`; JANGAN menyentuh `~/.webterm-server` di tes (stop-gate S3) |
| `bun test src/server/*.bun.test.ts` | **Autoload `.env` dan `.env.test` dari cwd** (diuji) -> `.env` dev (mis. `WEBTERM_TOKEN`, `WEBTERM_LEDGER`) bocor ke tes Bun | Tambah `--no-env-file` ke perintah resmi (`CLAUDE.md` + skrip `test:bun`); WS kecil dan murah |
| Klien `import.meta.env` | satu pemakaian: `centralControlEnabled` (`VITE_WEBTERM_CENTRAL_CHAT`), dibaca saat build. Vite memprioritaskan env yang sudah ada di proses saat dijalankan [BT: rantai `bun run build` -> `vite build`], `envDir` default = `root` = `src/client` (`vite.config.ts:11`), jadi `.env` root hanya sampai lewat env proses | Ganti dengan state server (G7); hasil: binary tanpa build-time flag, satu lapisan lebih sedikit |
| Binary (`package.json:9`) | `--define process.env.NODE_ENV='production'`; autoload `.env` + `bunfig.toml` dari cwd (default) | Fase 2: `--no-compile-autoload-dotenv`. `--no-compile-autoload-bunfig` adalah isu keamanan (bunfig cwd bisa memuat `preload`) -> serahkan ke topik 52 [BT: kapabilitas preload di binary] |
| Docker (tak ada Dockerfile di repo) | env lewat `-e`/`--env-file`; `WEBTERM_DATA_DIR` ke volume; `HOST=0.0.0.0` wajib token | Overlay DB ikut volume; `WEBTERM_ENV_SETTINGS=off` = mode immutable (env saja, override & secret file diabaikan). Dokumentasikan 3 baris; jangan membuat Dockerfile |
| CI | tak ada `.github`; tes dijalankan manual per `CLAUDE.md` | Tidak ada lapisan CI yang perlu diubah; `TMPDIR=/tmp/st` tetap |
| Backup data dir | `webterm.db` 0644 (override non-secret, tidak sensitif) dan `secrets/` 0700/0600 | Secret tidak ikut dump DB (`envSecrets.store.ts:1-3`); detail ancaman di topik 52 |

## 9. Risiko regresi dan stop-gate

| Risiko | Peluang x dampak | Pengendali |
|---|---|---|
| R1 Impor `.env` menulis nilai tak sah/dangerous tanpa gerbang | rendah x tinggi | impor memakai `update()` (validasi + gerbang + rollback), bukan jalur tulis baru; tes: dangerous tanpa root = 403 |
| R2 Notis deprecation mengganggu Docker/CI | sedang x rendah | hanya bila berkas `.env` ada di cwd; sekali per boot; tidak pernah error |
| R3 Perubahan kontrak `EnvEntryV2` (`envShadowed`) memutus klien/tes lama | rendah x sedang | field opsional baru; `KNOWN_KEYS_FROZEN` (`envRegistry.invariants.test.ts`) tidak disentuh; `contract` hanya ditambah |
| R4 Kode baru membaca env tingkat-modul sebelum overlay | sedang x sedang | invarian tes: grep `^(export )?const .* process\.env` pada berkas non-bootstrap = daftar putih eksplisit (hari ini: daftar di bagian 3) |
| R5 Default registry vs pembaca terus menyimpang | tinggi x rendah | tes sinkron default (G6), dijalankan di vitest |
| R6 Pengguna menghapus `.env` sebelum impor lalu kehilangan konfigurasi | sedang x sedang | pratinjau impor + teks "jangan hapus sebelum impor"; app tak menyentuh `.env` |
| R7 Mengganti `VITE_` build-time memecah panel kontrol | rendah x rendah | fallback: bila state belum dimuat, panel anggap `off` seperti sekarang |
| R8 Tes menulis ke home pengguna | rendah x tinggi | tes impor/token memakai `mkdtemp`; cek `git status` + `ls ~/.webterm-server` mtime sebelum/sesudah di verifikasi |

**Stop-gate** (berhenti dan lapor, jangan lanjut gelombang berikut):
- S1: `bun test src/server/envSettings*.test.ts` dan `npm test -- envSettings envRegistry` merah, atau `service.test.ts:17,31,202` perlu diubah (artinya presedensi berubah, di luar mandat).
- S2: `npm run typecheck` merah, atau `envRegistry.invariants.test.ts` perlu mengubah `KNOWN_KEYS_FROZEN`.
- S3: ada tes/kode yang menulis ke `~/.webterm-server` atau membaca `.env` nyata pengguna.
- S4: impor menulis kunci bootstrap atau melewati `dangerous`+root.
- S5: ada nilai secret di respons API, log, atau pesan error (uji regresi `redactSecrets` + grep respons).
- S6: boot dengan `env -i` + `WEBTERM_DATA_DIR=/tmp/...` gagal start (bukti zero-config; pemilik bukti: topik 52).

## 10. Implikasi untuk webterm

**Rekomendasi tegas:** Opsi A. Pertahankan presedensi override > env > default; jadikan Settings jalur utama dengan menutup G1-G8; `.env` menyusut ke 8 kunci bootstrap, opsional.

**Risiko utama:** (1) G1: tanpa token otomatis, fitur dangerous tidak bisa diaktifkan dari UI zero-config (bergantung topik 52); (2) override siluman bila G3 tak ditutup; (3) restart manual untuk 43 kunci tetap terasa lambat.

**Keputusan yang butuh user (default usulan):**

| # | Pertanyaan | Default usulan |
|---|---|---|
| K1 | Presedensi tetap override > env? | Ya (Opsi A). `env-first` hanya bila ada permintaan operator |
| K2 | Impor `.env`: eksplisit (tombol + pratinjau) atau otomatis? | Eksplisit |
| K3 | Kapan `build:binary` memakai `--no-compile-autoload-dotenv`? | Rilis mayor berikutnya, bukan sekarang |
| K4 | Tombol restart di UI? | Tunda; fase 1 hanya perintah restart di banner |
| K5 | `VITE_WEBTERM_CENTRAL_CHAT` diganti state server? | Ya |
| K6 | README: ringkas ke bootstrap + tautan? | Ya, diproses user sendiri atau dengan persetujuan baris-per-baris (aturan 16) |
| K7 | Perintah resmi tes Bun memakai `--no-env-file`? | Ya |

**Workstream usulan** (satu branch `chore/env-minimal-layers`, gelombang berurutan bila berkas bentrok; tiap WS punya tes nyata):

| WS | Nama | Berkas milik | Ukuran | Bergantung |
|---|---|---|---|---|
| EL-01 | provenance `envShadowed` + alias/`*_FILE` di `sourceOf` | `envSettings.state.ts`, `shared/envSettings.contract.ts`, `EnvEntryRow.tsx`, tes state | S | - |
| EL-02 | impor `.env` (pratinjau + apply) + UI tombol | baru `envSettings.import.ts`, `envSettings.api.ts` (rute `/import`), `EnvImportButton.tsx`, tes | M | EL-01 |
| EL-03 | notis deprecation boot | `envSettings.runtime.ts` (log satu kali), tes | S | - |
| EL-04 | invarian tes: default sinkron + larangan env tingkat-modul | `envRegistry.defaults.test.ts` (baru) | S | - |
| EL-05 | `VITE_` -> state server | `client/central/centralControlApi.ts`, `CentralControlPanel.tsx`, tes | S | - |
| EL-06 | kartu run-pertama (18 kunci `audience:user`) + teks banner restart per-mode | `EnvServerCard.tsx`/`envSectionLabels.ts`, tes | S-M | topik 52 (token) |
| EL-07 | `--no-env-file` pada perintah tes Bun + skrip `test:bun` | `package.json` (`scripts`), `CLAUDE.md` | S | - |
| EL-08 | `.env.example` mini + README bootstrap (akhir, satu worker, dokumen rangkuman) | `.env.example`, `README.md` (bagian env), `CHANGELOG.md` | S | semua |

Urutan: gelombang 1 = EL-01, EL-03, EL-04, EL-05, EL-07 (berkas disjoint); gelombang 2 = EL-02, EL-06; gelombang 3 = EL-08. Opsi A tidak menyentuh skema DB, jadi Rule 4 (migrasi) tidak terpicu.

**Asumsi `[BT]` terkait saudara:** token otomatis ditulis lewat `writeTokenToEnv` (`auth.ts:71`) sehingga `rootGate` dan `capabilityStore` memakainya; lokasi/izin berkas token dan penyimpanan secret alternatif (keychain, `*_FILE`) ditentukan `RND/52`; per-kunci TETAP-ENV/PINDAH-SETTINGS ditentukan `RND/51`. Dokumen ini hanya berlaku bila keduanya tidak membalik asumsi "overlay tetap penyimpan utama".
