# 53 - Env Minimal: Lapisan Konfigurasi (Topik 3)

Basis: worktree `rnd-envmin` (dari `main`, Bun 1.4.2 terpasang). Kutipan `file:baris` relatif `src/server/` kecuali disebut. `[BT]` = belum terverifikasi, `[opini]` = penilaian saya. Tidak ada nilai env/secret yang dibaca atau dicetak; `.env*` selain `.env.example` tidak dibuka. Saudara: `RND/51-ENV-MINIMAL-INVENTORY.md` (inventaris, per kunci), `RND/52-ENV-MINIMAL-ZERO-CONFIG-BOOT.md` (boot tanpa env, token, secret). Dokumen ini: DESAIN LAPISAN. Rujukan lama (tidak diulang): `RND/39-ENV-REGISTRY-AUDIT.md`, `PLAN/ENV-SETTINGS-a/b/c.md`.

## 1. Temuan utama

1. **Presedensi nyata = override tersimpan > env proses > default kode**, bukan env > override (`envSettings.service.ts:1,86-92`). Tes mengunci ini (`envSettings.service.test.ts:17`). Untuk kunci bootstrap (10) berlaku env > default saja. Mempertahankan urutan ini tepat untuk tujuan "UI jalur utama"; mode "env menang" sudah tersedia lewat `WEBTERM_ENV_SETTINGS=off` (kunci total).
2. **Tidak ada kunci registry yang tak bisa di-override karena dibaca terlalu dini.** Overlay jalan di `index.ts:45`, sebelum ledger/kanal/log; pembacaan env tingkat-modul yang tersisa hanya kunci bootstrap atau sudah dibaca-ulang (bagian 3). Risiko ada pada kode BARU, bukan kode sekarang.
3. **Celah terbesar bukan mekanisme, melainkan prasyarat:** (a) 14 dari 66 kunci `dangerous` hanya bisa diubah bila root token terkonfigurasi (`envSettings.service.ts:111`), jadi pada instalasi zero-config (loopback tanpa token) fitur inti seperti Browser, Orchestrator run, Autonomy terkunci di UI; (b) 43 dari 66 kunci butuh restart dan tidak ada tombol restart; (c) tidak ada jalur impor dari `.env` lama dan tidak ada petunjuk "env ini tertutup override".

## 2. Peta lapisan sekarang

| Lapis | Sumber | Menang atas | Berlaku untuk | Bukti |
|---|---|---|---|---|
| L3 Secret file | `<dataDir>/secrets/<KEY>` mode 0600 (UI) | L2, L1, L0 | 2 secret registry (`WEBTERM_TELEGRAM_BOT_TOKEN`, `..._WEBHOOK_SECRET`) | `envSettings.service.ts:87-90`, `envSecrets.store.ts:25-40` |
| L2 Override | baris JSON `app.env_overrides` di `webterm.db` (UI) | L1, L0 | 64 kunci non-secret (66 dikurangi 2 secret) | `envSettings.store.ts:7,20-31` |
| L1 Env proses | shell, Docker `-e`, DAN `.env` yang dimuat Bun otomatis (tak terbedakan) | L0 | semua kunci | `envSettings.service.ts:53-54` (`base` = snapshot) |
| L0 Default | konstanta di pembaca + `default`/`effectiveDefault` di registry (DUA sumber) | - | semua | `envRegistry.types.ts:16`, RND/39 E04 |
| Kunci total | `WEBTERM_ENV_SETTINGS=off` (hanya dari env, bootstrap) | mematikan L2+L3 | seluruh overlay | `envSettings.service.ts:55,81,150` |
| Bootstrap | 10 kunci hanya env: `HOST PORT WEBTERM_HOST WEBTERM_DATA_DIR WEBTERM_TOKEN ALLOW_LOOPBACK_APPROVAL ALLOW_TOKEN_MINT STRICT_HOOK_AUTH TELEGRAM_API_BASE ENV_SETTINGS` | - | ditolak PUT `bootstrap_only` | `envRegistry.ts:19-30`, `envSettings.service.ts:108` |

Registry: 66 entri (23 `hot`, 43 `boot`; 2 secret; 14 `dangerous`; 18 `audience:user`) [dihitung dengan `bun -e` atas `ENV_REGISTRY`, env bersih].

### 2.1 Cara override diterapkan ke `process.env`

`createEnvSettings` mengambil snapshot `base[key] = process.env[key]` untuk tiap kunci registry SEKALI (`:53-54`), lalu `apply()` (`:80-97`): untuk tiap spec, `nilai = override ?? (secret? file) `, `process.env[key] = nilai ?? base[key]` (atau `delete` bila keduanya kosong). Jadi: (i) overlay MEMUTASI `process.env` agar ~20 pembaca lama tak berubah (tujuan desain, komentar `:3`); (ii) "reset" mengembalikan nilai `base`, bukan nilai override terakhir; (iii) `apply()` dipanggil lagi setelah tiap `update()` (`:163`), sehingga kunci `hot` langsung efektif di pembaca yang membaca per-panggilan; (iv) `bootEnv` = env sesudah apply pertama, dipakai `pendingRestart = target[key] !== bootEnv[key]` untuk kunci `boot` (`envSettings.state.ts:67`); (v) `restartRequired` di respons PUT = kunci `boot` yang nilainya benar-benar berubah (`:169`).

Titik cacat kecil yang relevan untuk desain: `base` hanya memuat kunci registry, jadi **alias tak terdaftar** (mis. `TELEGRAM_BOT_TOKEN`, `WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE`) tidak masuk `source`; UI melaporkan "Kosong" padahal fitur jalan (`channels/telegramSend.ts:18-26`, RND/39 E05/E06).

### 2.2 Pengaman yang sudah ada dan harus dipertahankan

Update atomik (semua valid atau tak ada yang berubah) dengan rollback secret (`:124-147`); kunci tak dikenal dipertahankan lintas build cabang (`:139-140`); JSON rusak tak menjatuhkan boot (`envSettings.store.ts:55-89`); nilai/secret tak pernah masuk log atau error (`envSettings.validate.ts:1-2`); `dangerous` butuh root token (`:111`); bootstrap hanya tampil sebagai terisi/kosong (`envSettings.state.ts:93`).

## 3. Kapan overlay jalan vs modul yang membaca env

Urutan `index.ts`: ESM menjalankan SEMUA `import` (baris 1-32) lebih dulu, lalu badan: `resolveHostPort` (38) -> `resolveToken` (40) -> `writeTokenToEnv` (43) -> **`initEnvSettings` (45)** -> `configureLogging` (47) -> ledger (52) -> kanal (62) -> `bootCa2`/autonomy (79-80) -> browser (129). Tidak ada `await import(...)` modul env-sensitif sebelum 45 (impor dinamis di `orchestratorRunProduction.ts:136,175`, `contextLinkRoute.ts:45` terjadi saat request).

Pembacaan env tingkat-modul (jalan SEBELUM overlay), hasil grep `^(export )?const .* process.env`:

| Lokasi | Kunci | Registry? | Dampak | Vonis |
|---|---|---|---|---|
| `agentStatusAuth.ts:15` | `WEBTERM_STRICT_HOOK_AUTH` | bootstrap | tak bisa dari UI, sesuai desain | aman |
| `launchLine.ts:17` | `PORT` | bootstrap | sama; konsisten dengan `serverConfig.ts:10` | aman |
| `logs/logger.ts:34`, `logs/logBus.ts:117` | `WEBTERM_LOG_LEVEL`, `WEBTERM_LOG_BUFFER` | ya | dibaca-ulang oleh `configureLogging` setelah overlay (`logger.ts:104-116`); entri log sebelum 47 memakai nilai env | aman, selisih kosmetik |
| `index.ts:49` | `NODE_ENV` | tidak | pilih Vite middleware vs dist | tetap env (dan `--define` di binary, `package.json:9`) |
| `db.ts:125` | (`WEBTERM_DATA_DIR` via `dataDir()`) | bootstrap | DB dibuka saat impor; override hidup di DB itu sendiri | **sebab DATA_DIR harus env** |
| `control/mount.ts:63-65` | `WEBTERM_TOKEN`, `ALLOW_TOKEN_MINT` | bootstrap | dibaca malas saat request pertama, SESUDAH `writeTokenToEnv` | token hasil auto-generate (topik 52) cukup lewat `writeTokenToEnv` |

Pembacaan di badan fungsi lewat parameter `env`/default `process.env` (mayoritas: `ca2Boot.ts`, `registerAll.ts`, `telegramSend.ts`, `centralAutonomyBoot.ts`, dll.) membaca nilai pasca-overlay karena objeknya `process.env` hidup (`index.ts:130` meneruskan referensi, bukan salinan). Batas verifikasi: grep satu-baris; pembacaan lewat helper bertingkat tak terlihat [BT]. **Aturan untuk kode baru** (usul invarian tes): pembaca registry-key dilarang membaca env di tingkat modul; wajib lewat fungsi atau parameter `env`.

Dua kebocoran yang berkaitan dengan "env hasil overlay":
- Overlay menaruh secret UI di `process.env`, dan beberapa spawn menyalin SELURUH env: `nameGen.ts:28-31`, `memory/memoryFilePath.ts:111-112`, `gitInfo.ts:86`, `fsGit.ts:27`. PTY menyaring `WEBTERM_*` tapi bukan `TELEGRAM_BOT_TOKEN` legacy dan variabel `.env` lain (`ptyShell.ts:74`). Ini PRA-ADA (sama dengan `.env`), bukan regresi; tetapi bila secret makin banyak pindah ke UI, kelasnya membesar. Mitigasi di topik 52 (baca secret lewat store, bukan env) atau saring di tiga spawn tadi. [opini] Jangan dikerjakan di workstream ini, cukup dicatat.
- `opencode` aman: `scrubOpencodeEnv` memakai allowlist (`central/runtime/opencodeOptions.ts:93-101`).

## 4. Celah agar Settings jadi jalur utama

| # | Celah | Bukti | Efek pada zero-config | Arah |
|---|---|---|---|---|
| G1 | Kunci `dangerous` butuh root token terkonfigurasi | `service.ts:111`, `envSettings.runtime.ts:36` | tanpa token (default loopback) 14 kunci kunci di UI: BROWSER (+BIN/AGENT/ALLOW_HOSTS/COOKIE_IMPORT), ORCHESTRATOR_RUN, CENTRAL_AUTONOMY/AGENTS, OPENCODE_*, MEMORY_DIR, CONTROL_CWD_ROOTS, TRUST_PROXY, EMBED_URL | token otomatis (topik 52) lalu `rootGate` benar; ATAU nyatakan "fitur ini perlu token" di UI (kartu `EnvServerCard` sudah punya pesan `noRootGate`) |
| G2 | 43/66 kunci `boot`, tanpa tombol restart | `envSettings.state.ts:64-67`, non-tujuan `PLAN/ENV-SETTINGS-a.md:17` | pengguna mengubah, melihat banner, harus restart manual di terminal | fase 3 (opsional): restart terawasi; fase 1: teks banner memuat perintah restart sesuai mode |
| G3 | Tak ada petunjuk "env tertutup override" | `state.ts:40-43` (hanya `override`/`env`/`default`) | setelah impor `.env`, mengedit `.env` tak berefek, tanpa penjelasan (bagian 6) | tambah `envShadowed: boolean` per entri bila `override != base` |
| G4 | Tak ada impor `.env` | tidak ada grep `parseEnv`/`import` di server | migrasi manual per kunci | bagian 6 |
| G5 | Alias/berkas tak terpantau | RND/39 E05, E06 | UI "Kosong" padahal jalan | `sourceOf` ikut membaca alias; deteksi `*_FILE` |
| G6 | Default ganda (registry vs pembaca) | RND/39 E04 (`TELEGRAM_MODE`) | UI menampilkan nilai default yang tidak sama dengan perilaku | invarian tes "default registry == default efektif pembaca" (hanya untuk kunci yang punya pembaca bernama) |
| G7 | `VITE_WEBTERM_CENTRAL_CHAT` build-time | `client/central/centralControlApi.ts:32`, `.env.example:131` | panel kontrol tak bisa dinyalakan lewat Settings/binary; satu-satunya flag klien | ganti dengan entri state `WEBTERM_CENTRAL_CHAT` yang sudah ada (E08) |
| G8 | Tak ada onboarding "yang perlu kamu isi" | 18 kunci `audience:user` sudah ada (`envRegistry.meta.ts:27`) | pengguna baru melihat 66 baris | kartu run-pertama berisi 18 kunci itu; sisanya "Lanjutan" (`envDraft.ts:72-93` sudah memisah) |
| G9 | Bootstrap 10 kunci hanya env | `envRegistry.ts:19-30` | untuk zero-config cukup: semuanya punya default aman (HOST loopback, PORT 8700, data dir `~/.webterm-server`) | tetap; HOST/PORT dari argumen CLI = opsional (topik 52) |

## 5. Opsi desain

### Opsi A - Perkuat overlay yang ada (REKOMENDASI)
Presedensi tetap L3 > L2 > L1 > L0. Tambah: provenance (`envShadowed`), impor `.env` sekali, notis deprecation, kartu run-pertama, sinkron default, `VITE_` -> state server, doc `.env.example` mini. Tanpa skema DB baru, tanpa dependensi baru, tanpa rename.

| Plus | Minus |
|---|---|
| Diff kecil di atas kode yang sudah dites (service/state/store 400 baris total) | Override tetap diam-diam menang atas env; operator Docker harus tahu `WEBTERM_ENV_SETTINGS=off` |
| Kompat penuh: `.env` lama tetap jalan | Dua tempat nilai (DB + env) tetap ada; hanya diberi label |
| Tes yang mengunci semantik tetap hijau | 43 kunci tetap butuh restart |

### Opsi B - Balik presedensi: env > override (12-factor)
Env yang diset menang; UI hanya mengisi kunci yang env-nya kosong; kunci ber-env tampil "dikunci oleh env".

| Plus | Minus |
|---|---|
| Docker/CI intuitif: apa yang dikirim orkestrator, itu yang jalan | **Merusak tujuan**: pengguna dengan `.env` hasil salin `.env.example` (mis. `HOST`, `WEBTERM_LEDGER=off` tak dikomentari) tak bisa memakai UI sampai membersihkan `.env` |
| Tak ada "override siluman" | Perilaku berbalik untuk pengguna yang SUDAH punya override + `.env` (override mereka mendadak diabaikan); mengubah `service.test.ts:17,31,202` dan kontrak `source` |
| | Provenance `.env` vs shell tidak diketahui (keduanya `process.env`), jadi tak bisa mengunci hanya yang dari shell |

Tolak sebagai default. Yang berguna dari B ditutup oleh A: label `envShadowed` + `WEBTERM_ENV_SETTINGS=off` untuk deployment immutable. [opini] Jika kelak diperlukan, tambah kunci bootstrap `WEBTERM_ENV_SETTINGS=env-first` (tiga nilai: `on|off|env-first`), bukan membalik bawaan.

### Opsi C - Lapisan berkas `<dataDir>/config.json` (0600) sebagai penyimpanan pra-DB
Berkas dibaca sebelum DB dibuka; bisa memuat HOST/PORT/flag boot dan dapat diedit tangan/GitOps.

| Plus | Minus |
|---|---|
| Satu-satunya cara agar HOST/PORT (bootstrap) bisa diatur tanpa env | Penyimpanan kedua di samping `app.env_overrides`: dua sumber kebenaran, perlu migrasi dan aturan konflik |
| Terbaca manusia dan dapat di-diff | Kunci bootstrap keamanan (`ALLOW_TOKEN_MINT` dst.) sengaja dikeluarkan dari jangkauan API agar shell agen tak mematikan pengamannya sendiri (`envRegistry.ts:14-18`); berkas di data dir terbuka untuk uid yang sama, jadi alasan itu runtuh [BT: model ancaman topik 52] |
| | `DATA_DIR` tetap harus env/default, jadi lubang "ayam-telur" tidak hilang |

Tunda. [opini] Nilai C kecil karena HOST/PORT sudah punya default dan cukup lewat argumen/ env sesekali.

### Rekomendasi
**A.** Alasan: mengisi seluruh kebutuhan (jalur utama UI, migrasi mulus, nol pemutusan), biaya terendah, dan mekanisme intinya sudah dibuktikan tes (puluhan kasus service, boot-order test `envSettings.boot.test.ts:10`). B dan C dicatat sebagai pintu keluar, bukan pekerjaan sekarang.

Lanjutan (migrasi `.env`, `.env.example`/README, dampak dev/tes/Docker, risiko, stop-gate, implikasi dan workstream): `RND/53-ENV-MINIMAL-CONFIG-LAYERS-b.md`.
