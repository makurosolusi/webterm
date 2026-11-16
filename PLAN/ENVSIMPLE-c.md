# PLAN ENVSIMPLE (c): PREAMBLE + spek siap-tempel ES-00..ES-07

Seri: (a) `ENVSIMPLE-a.md` keputusan D1-D9, tipe W0 (§3), nasib CH-xx (§4), peta WS (§5), stop-gate S-E1..S-E11 (§6), KE-1..KE-10 (§8) · (b) `ENVSIMPLE-b.md` kontrak API (§1), hot-apply (§2), audit (§3), Lanjutan (§4), tawaran (§5), Telegram (§6), matriks tes (§7-8), pemetaan kunci (§9) · (c) ini: PREAMBLE + W0 (ES-00, 01), W1 (ES-02..05), W2 (ES-06, 07) · (c2): W2 (ES-08), W3-W6 (ES-09..15).
Tempel PREAMBLE + SATU spek per worker (tab terpisah, nama uniq). Bila (a)/(b) bertentangan dengan spek, SPEK menang. Jalur tanpa awalan: `src/server/`, `src/client/`, `src/shared/`. Seri CHENV TIDAK dijalankan.

## PREAMBLE (semua worker)

```
Kamu mengerjakan SATU workstream program "ENVSIMPLE" (Bun + TypeScript + React). Sasaran: webterm untuk SATU pengguna pribadi; Settings menampilkan tujuh KEMAMPUAN dengan satu sakelar tiap kemampuan, tanpa konsep restart/berbahaya/operator; semua teks UI Indonesia. Baca dulu: CLAUDE.md repo, PLAN/ENVSIMPLE-a.md §2-§3 dan §8, bagian PLAN/ENVSIMPLE-b.md yang disebut spekmu.
Aturan keras: kerja hanya di worktree/branch yang diberikan (cabang dari chore/envsimple-int). HANYA sentuh berkas DIMILIKI; berkas lain dilarang walau satu baris (butuh? berhenti, lapor). DILARANG: git commit/push/merge/checkout/stash/reset (orkestrator yang commit), install dependency (nol dependency baru), browser/dev server, membaca .env* selain .env.example, mencetak/me-log secret atau token (hanya nama kunci, "set/kosong"), menyentuh ~/.webterm-server atau home pengguna (tes: mkdtemp di /tmp + WEBTERM_DATA_DIR/HOME palsu), menghapus/mengganti nama kunci registry (KNOWN_KEYS_FROZEN utuh), rename WEBTERM_*, x-webterm-node-token, referensi eksternal:, ~/.referensi eksternal*, WEBTERM_TOKEN.
Kemampuan: JANGAN baca kunci katalog (primer/turunan) langsung dari process.env/env[...] di kode non-tes; pakai isEnabled(id, env) dari featureCapabilities.runtime (pagar grep ES-00/ES-14). Layanan "selalu siap" + cek isEnabled PER PANGGILAN; proses latar lewat onCapabilityChange dengan start/stop idempoten (b §2).
Secret write-only: nilai tak pernah ke DOM, log, respons, audit, snapshot tes, error.
UI: komponen BARU memakai Button/Input/Label dari "@/components/ui/*" (src/client/shadcnPolicy.test.ts menggagalkan <button>/<input> mentah). Teks UI, aria-label, title, placeholder = Indonesia di berkas label (Rule 15), tanpa nama env var dan tanpa kata webhook/polling/secret/mode/restart/berbahaya/operator. Status: role="status"; galat: role="alert".
Rule 11: tanpa empty catch, error berkonteks tanpa secret. Rule 15: tanpa literal URL/port/angka tak bernama. Rule 16: docstring 1 baris untuk symbol publik baru. Rule 17: TODO berkonteks, tanpa kode mati. Rule 4: skema DB hanya CREATE ... IF NOT EXISTS. Komentar Indonesia (KENAPA).
Rule 8: berkas <=500 baris/<=20.000 karakter dan batas per tipe; jatah ada di spekmu; berkas yang sudah lewat batas dipecah DULU oleh pemiliknya; lewat jatah = berhenti, lapor. "Verifikasi dulu" = grep/baca sebelum bergantung; hasil berbeda dari spek dilaporkan.
Rule 3: tulis tes nyata (asersi) di WS yang sama dan JALANKAN: TMPDIR=/tmp/st npm run typecheck && TMPDIR=/tmp/st npm test (per berkas: TMPDIR=/tmp/st npx vitest run <berkas>); Bun-only: TMPDIR=/tmp/st bun test --no-env-file <berkas>. Tes klien: pragma /** @vitest-environment jsdom */. Tes lama yang merujuk perilaku yang kamu ubah WAJIB kamu perbarui. Jangan klaim selesai bila merah.
Stop-gate S-E1..S-E11 (a §6) = berhenti dan lapor, jangan menambal.
Laporan akhir <=120 kata: berkas diubah/dibuat + `wc -lm`, hasil typecheck+tes, deviasi, hal yang ternyata salah. Harus cocok dengan `git diff --stat`.
```

## Gelombang W0 (SATU pesan; berkas saling lepas)

### ES-00 kontrak kemampuan (`feature/envsimple-contract`, `wkr-envsimple-contract-01`, M) — D1, D2

**File + jatah:** baru: `src/shared/featureCapabilities.ts` (<=200), `server/featureCapabilities.runtime.ts` (<=200), `server/featureCapabilities.legacy.ts` (<=150), `featureCapabilities.test.ts` (shared, <=300), `featureCapabilities.runtime.test.ts` (<=350), `featureCapabilities.grep.test.ts` (<=120). DILARANG: registry, `envFlag.ts`, apa pun lain.
**Perilaku:** tulis tipe dan katalog PERSIS `a §3.1` (7 id, `implies`, `primaryKey`, `needs`, `subs`). `shared`: `closure`, `dependents`, `deriveFlags` murni. `runtime`: `isEnabled(id, env)` = `flagOn(env[primaryKey])` DAN semua `implies` isEnabled (rekursif, tanpa siklus); `enabledSet(env)`; `onCapabilityChange(id, {start, stop})` (daftar modul, idempoten, galat hook ditangkap + dicatat `warn` dengan id saja); `reconcile(prev, next)` memanggil `start` untuk id yang baru on dan `stop` untuk yang baru off, urutan: stop dependents dulu, start closure dulu. `legacy`: `legacyToCapabilities(env)` -> `{ set, ignored }`; sub-opsi/anak tanpa induk aktif masuk `ignored` dan satu `warn` per kunci per proses (nama kunci saja). Pemetaan kunci = `b §9`. `flagOn` dari `envFlag.ts` yang ada (ES-01 menyatukan dialek).
**Verifikasi dulu:** `grep -n "export" server/envFlag.ts`; bentuk `process.env` vs store override di `envSettings.runtime.ts`; `src/shared/workspace.capabilities.ts` (JANGAN disentuh, hanya hindari tabrakan nama).
**Tes:** properti eksaustif atas 128 subset (`b §8.1`): `closure` idempoten, `deriveFlags(S)` lalu `enabledSet` = `closure(S)`; mematikan X mematikan semua `dependents(X)`; tak ada keadaan inkoheren (autonomy on tanpa workers). Legacy: store kosong -> kosong; `AUTONOMY=on` tanpa `ORCHESTRATOR_RUN` -> autonomy off + `ignored`; `warn` tepat satu per kunci (panggil dua kali). `reconcile`: urutan hook; `start` dua kali aman; hook melempar tidak menghentikan hook lain. Pagar grep: berkas non-tes `src/server/**` di luar `featureCapabilities.*`/`envRegistry*` bebas dari akses `env[...]` atau `process.env.` untuk kunci katalog (daftar saat ini dilonggarkan lewat allowlist berkas yang ditulis di tes, menyusut per WS; ES-14 mengosongkannya).
**Selesai bila:** tes + typecheck hijau, tiga berkas baru di bawah batas Rule 8, `git diff --stat` hanya berkas di atas.

### ES-01 dialek flag (`fix/envsimple-flag`, `wkr-envsimple-flag-01`, S) — D5

**File + jatah:** `server/envFlag.ts` (+<=25), `envFlag.test.ts` (+<=120), `envFlag.inventory.test.ts` (baru, <=150). DILARANG: pembaca flag lain.
**Perilaku:** `envFlag.ts` memegang dialek kanonik: on = `on|1|true`, off = `off|0|false` (huruf besar/kecil, spasi dipangkas); selain itu = default pemanggil. Tiga kunci keamanan (`WEBTERM_ALLOW_LOOPBACK_APPROVAL`, `WEBTERM_ALLOW_TOKEN_MINT`, `WEBTERM_STRICT_HOOK_AUTH`) tetap persis `1` lewat helper terpisah `strictFlag`. `envFlag.inventory.test.ts` memindai parser flag LAIN di `src/server` (`=== '1'`, `=== 'on'`, `toLowerCase() === 'true'` pada env) dan mencatat inventori (nama berkas) sebagai daftar tetap di tes; tes gagal bila ada parser baru di luar daftar. Berkas pembaca yang masih beda dialek DILAPORKAN (KE-3), bukan diubah.
**Verifikasi dulu:** `grep -rn "=== '1'\|=== 'on'\|'true'" src/server --include=*.ts | grep -v test`; isi `envFlag.ts` sekarang dan tesnya.
**Tes:** tabel `on/ON/1/true/ true ` -> true; `off/0/false` -> false; `yes/2/` -> default; `strictFlag('on')` false, `strictFlag('1')` true; inventori sama dengan daftar tetap.
**Selesai bila:** tes lama `envFlag.test.ts` hijau tanpa ubah asersi, laporan menyertakan inventori parser.

## Gelombang W1 (SATU pesan; setelah W0 merge; berkas saling lepas)

### ES-02 penjaga tak terlihat + audit (`feature/envsimple-guard`, `wkr-envsimple-guard-01`, M-L) — D3-REV

**File + jatah:** baru: `server/featureCapabilities.guard.ts` (<=150), `featureCapabilities.audit.ts` (<=120), tes `.guard.test.ts` (<=300), `.audit.test.ts` (<=200); diubah: `envSettings.service.ts` (174; netto <=-15), `envSettings.api.ts`, `envSettings.runtime.ts` (54), `db.ts` (+3: panggil `ensureAuditSchema`). Tes lama `envSettings.*.test.ts` hanya bagian `dangerous`/`token_required`. DILARANG: `auth.ts`, `index.ts`, `api.ts`.
**Perilaku:** `settingsGuard(req)` persis `a §3.3`: jalur A token root valid (bukan token node/capability); jalur B tanpa token ditegakkan + peer loopback dari socket + tanpa `Forwarded`/`X-Forwarded-*` + `hostAllowed` + `Origin` ADA dan sama-origin. Hasil `{ok:true, via}` atau `{ok:false, reason: 'forwarded'|'origin'|'token_kind'|'peer'|'host'}`. Pasang di `PUT /api/settings/env` dan `POST /api/settings/env/import` (403 `forbidden`, tanpa kata token root). Hapus gerbang `dangerous`/`rootGate`/403 `token_required` dari `validate` dan runtime; `dangerous` tinggal label internal untuk `detail` audit. `ensureAuditSchema(db)` idempoten memakai SQL `b §3`, dipanggil dari `openDb`; `recordAudit(db, entry)` memangkas ke 1000 baris, `detail` hanya nama kunci. `export` dipakai ES-09 untuk rute kemampuan.
**Verifikasi dulu:** `auth.ts:15,38,86` (`hostAllowed`, `sameOrigin`); `envSettings.service.ts` `validate`; pemanggil `rootGate` (`grep -rn rootGate src`); `db.ts:21-35` pola skema inline. Ada pemanggil `dangerous` di luar berkas milikmu: STOP, lapor.
**Tes:** token node ditolak; `X-Forwarded-For` ditolak; `Forwarded` ditolak; `Origin` asing ditolak; `Origin` absen pada jalur B ditolak; token root lolos; peer non-loopback tanpa token ditolak; PUT env kunci `dangerous` dari UI loopback sah kini 200 (gerbang lama hilang); audit: baris `denied` tertulis dengan `reason` generik, `JSON.stringify(rows)` tak memuat nilai uji/token/header; pemangkasan 1000; `ensureAuditSchema` dua kali aman. Statis V4: tak ada berkas `central/tools/defs/*.def.ts` mengimpor `envSettings*`/`featureCapabilities*`.
**Selesai bila:** tes + `bun test --no-env-file` untuk audit (bun:sqlite) hijau; `grep -rn "rootGate\|token_required" src/server` kosong di luar tes yang menegaskan ketiadaan.

### ES-03 ledger selalu hidup + workers hot (`fix/envsimple-orch`, `wkr-envsimple-orch-01`, S-M) — KE-1, D4-REV

**File + jatah:** `server/ledger/ledgerRuntime.ts` (+<=20), `orchestratorRunModel.ts`, `orchestratorRunApproval.ts` (masing-masing +<=15), `envRegistry.platform.ts` (+<=10, hanya label), tes terkait. DILARANG: `index.ts`.
**Perilaku:** `ledgerMode` default `on` (shadow hanya `WEBTERM_LEDGER_SHADOW=1`); kunci `WEBTERM_LEDGER` lama diabaikan (tak ada permukaan). Jangan ubah isi ledger; hanya default. `orchestratorRunModel`/`Approval` membaca `isEnabled('workers', env)` PER PANGGILAN (bukan konstanta modul); sub `WEBTERM_RUN_REQUIRE_APPROVAL` default ON dipertahankan. Koreksi `restart` pada kunci platform yang terbukti dibaca per panggilan menjadi `hot`.
**Verifikasi dulu:** `ledgerRuntime.ts:74`; `index.ts:51` (`startLedgerRuntime`, hanya baca); grep `process.env.WEBTERM_ORCHESTRATOR_RUN` dan `RUN_REQUIRE_APPROVAL` di `src/server`. Bukti ukuran DB kosong sebelum/sesudah dicatat di laporan (footprint, R-E1).
**Tes:** store kosong -> ledger hidup (`activeLedgerRuntime() !== null`); `WEBTERM_LEDGER_SHADOW=1` -> shadow; `orchestrator.run` ditolak saat workers off, diterima setelah `env` diubah TANPA membangun ulang modul; approval default ON, sub off hanya bila diset eksplisit.
**Selesai bila:** tes hijau; label `restart` platform tidak `boot` untuk kunci yang dibaca per panggilan (tabel bukti di laporan).

### ES-04 central + CA2 selalu siap (`feature/envsimple-central`, `wkr-envsimple-central-01`, M-L) — D5

**File + jatah:** `server/central/ca2Boot.ts`, `centralModel.ts`, `central/chat/turnService.ts`, `central/runtime/runtimeFlag.ts` (+<=40 total tiap berkas <=+30), `central/runtime/runtimeDetect.ts` (baru, <=100), `envRegistry.central.ts`, `envRegistry.ca2.ts` (hanya label `restart`/`hot`), tes. DILARANG: `index.ts`, `centralAutonomyBoot.ts`, `envRegistry.platform.ts`.
**Perilaku:** layanan Central/CA2 dirakit sekali dan dormant; rute/tool/chat memeriksa `isEnabled('central', env)` per panggilan (tak aktif = 404 bentuk lama `{error}` yang sudah ada, bukan galat baru). Anak CA2 (9 flag rilis, tuning) hanya berlaku bila `central` on; sebaliknya diabaikan (legacy menangani warn). `runtimeDetect.ts`: `detectAgentEngine(env, which)` -> `claude` bila CLI `claude` ada di PATH, lalu `opencode`, lalu `mock`; `WEBTERM_CENTRAL_RUNTIME` eksplisit menang; `which` disuntik (tes tanpa PATH nyata). `WEBTERM_CENTRAL_CHAT`, `_MEMORY`, `_READ_TOOLS`, `_CENTRAL_TELEGRAM` diturunkan dari `central` (D5) lewat `isEnabled`, tak lagi gerbang terpisah di kode yang kamu miliki.
**Verifikasi dulu:** `grep -rn "WEBTERM_CENTRAL" src/server --include=*.ts | grep -v test`; bagaimana `bootCa2` dipanggil di `index.ts` (hanya baca; bila kini bersyarat dan butuh ubah `index.ts` -> lapor, ES-09 yang mengubah); `runtimeFlag.ts` sekarang.
**Tes:** central off -> rute 404; ubah env -> on tanpa rebuild -> 200; anak tanpa induk tidak aktif; `detectAgentEngine`: claude ada -> claude, hanya opencode -> opencode, tak ada -> mock, eksplisit menang; label `restart` kunci turunan bukan `boot`.
**Selesai bila:** tes hijau; tabel kunci Central -> `isEnabled` di laporan.

### ES-05 berkas hot (`fix/envsimple-files`, `wkr-envsimple-files-01`, S) — D1

**File + jatah:** pembaca `WEBTERM_FILES_*` (ditemukan lewat grep; tiap berkas +<=10), `envRegistry.files.ts` (hanya `requires`/label), tes terkait. DILARANG: `index.ts`, berkas klien.
**Perilaku:** semua gerbang berkas memakai `isEnabled('files')` untuk baca dan `isEnabled('filesWrite')` untuk tulis/unggah, PER PANGGILAN; WATCH/GIT_STATUS/QUICK_OPEN/UPLOAD tetap anak (aktif bila induk on dan kunci anak on). Default `files` on tanpa tindakan (L11); `filesWrite` off.
**Verifikasi dulu:** `grep -rn "WEBTERM_FILES_" src/server --include=*.ts | grep -v test`; daftar berkas yang ditemukan dicantumkan di laporan; lebih dari 8 berkas: STOP, lapor (pecah WS).
**Tes:** files off -> rute berkas ditolak seperti perilaku lama; on -> baca berfungsi; `filesWrite` tanpa `files` -> off (implies); mutate tidak terbuka hanya karena `files` on.
**Selesai bila:** tes lama berkas lulus; allowlist pagar grep ES-00 menyusut sebanyak berkas yang dibersihkan.

## Gelombang W2 (sebagian; ES-08 di c2)

### ES-06 autonomy hot (`feature/envsimple-autonomy`, `wkr-envsimple-auto-01`, M) — D4-REV

**File + jatah:** `server/centralAutonomyBoot.ts` (173; netto <=+20, bila >200 pecah dulu `centralAutonomyBoot.timer.ts` <=100), tes `centralAutonomyBoot*.test.ts`. DILARANG: `index.ts`.
**Perilaku:** `startCentralAutonomyBoot` selalu mengembalikan controller (tidak `null`); satu timer tick; tiap tick cek `isEnabled('autonomy')` dan hasil `workers`; `enabled: true` di sekitar baris 78-80 diganti `enabled: isEnabled('workers', env)`. `onCapabilityChange('autonomy', {start, stop})` memulai/menghentikan timer, idempoten; `stop` tidak membunuh worker yang sedang berjalan (KE-5, dicatat di komentar). Galat saat `start` ditangkap + `warn`.
**Verifikasi dulu:** baris 78-100 berkas ini; pemanggil di `index.ts:79` (hanya baca; kini diharapkan menerima non-null); jam/timer yang bisa disuntik di tes lama.
**Tes:** off -> tick tidak mengirim; on lewat `reconcile` -> tick mengirim; `start;start`, `stop;stop`, `start;stop;start`; workers off saat autonomy on (legacy) -> tidak mengirim; `stop` tidak membatalkan dispatch berjalan (fake dispatch selesai normal).
**Selesai bila:** tes hijau, tidak ada return `null` di jalur off.

### ES-07 Telegram hot + connect (`feature/envsimple-telegram`, `wkr-envsimple-tg-01`, L) — D9.2, CH-02/03

**File + jatah:** `server/channels/channelsRuntime.ts` (256; pecah dulu bila perlu, netto <=0 pada berkas itu), `telegramPollWiring.ts`, `telegramMode.ts`, `channelSecret.ts`, `channelsMasterGate.ts` (tiap +<=20), `envRegistry.channels.ts` (label `restart` -> `hot` hanya setelah tes hot hijau), baru: `telegram.connect.ts` (<=150), `telegram.connect.test.ts` (<=250), `telegramHot.test.ts` (<=250). DILARANG: `index.ts`, `channelStatus*.ts`, klien.
**Perilaku:** `connectTelegram({ token, fetch, store })`: validasi bentuk (`invalid_token_shape`), `getMe` lewat egress yang ada (`callBotApi`), 401/404 -> `token_rejected`, jaringan/timeout -> `unreachable`; HANYA bila `ok` token disimpan ke secret store dan `telegram` dinyalakan; sukses -> `{ ok: true, bot: '@username' }` (username divalidasi `^[A-Za-z0-9_]{5,32}$`). `onCapabilityChange('telegram', {start, stop})`: `start` memulai poller bila token ada (`resolveTelegramMode`: poll bila token ada), `stop` menghentikan; idempoten. Webhook secret dibangkitkan otomatis ke `secrets/` bila belum ada dan mode `webhook` dipilih lewat env eksplisit (KE-9; tanpa deteksi URL publik). Token tak pernah masuk log, galat, atau hasil.
**Verifikasi dulu:** `telegramMode.ts:resolveTelegramMode`; `channelSecret.ts`; di mana token dibaca saat boot (`startChannelsRuntime`, `telegramPollWiring.ts`); `callBotApi` redaksi token; `envRegistry.channels.ts:17,23,29`.
**Tes:** `connect`: ok (fake fetch), 401, 404, jaringan mati, bentuk salah; token ditolak = secret store tidak berubah; `JSON.stringify` hasil/log/error `not.toContain(TOKEN_PALSU)`. Hot: token diisi saat server berjalan -> poller hidup tanpa restart; `stop;stop`; `start;stop;start` satu poller; label kunci channels tidak `boot`.
**Selesai bila:** tes hijau; laporan memuat daftar pembaca token yang masih membaca saat boot (harus nol).
