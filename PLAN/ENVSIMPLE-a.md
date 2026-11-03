# ENVSIMPLE-a: pengaturan tanpa kebingungan, dari tingkat kode

Seri: `-a` (ini: keputusan, kontrak W0, peta, gerbang, risiko), `-b` (kontrak API, hot-apply, tes, D8/D9), `-c` (PREAMBLE + ES-00..ES-07), `-c2` (ES-08..ES-15). Dasar: `RND/56..59`, `docs/decisions/env-minimal.md`, `PLAN/CHENV-*`. Klaim kode bertanda [TERVERIFIKASI] (dibaca di worktree ini, `berkas:baris`), [ASUMSI], atau [BT] (belum terverifikasi; worker cek di "Verifikasi dulu").

## 1. Ringkasan dan metrik

Pengguna = satu orang, satu mesin (D9). Hari ini: 82 kunci env tampil sebagai 62 kartu, 99,82% kombinasi flag inkoheren, "Belum berpengaruh" hanyalah nasihat client dari `requires` yang tak ditegakkan server (`src/shared/envSettings.contract.ts:evalRequires`), plus konsep "Berbahaya/Dikunci/token root/Perlu restart".

Solusi: 7 KEMAMPUAN, satu sakelar on/off masing-masing, berlaku langsung. Kemampuan = VIEW atas kunci di store override yang ada; aktivasi menulis kunci turunan lewat jalur PUT yang ada. SATU fungsi `isEnabled(id)` jadi satu-satunya pembaca runtime. Keamanan pindah ke penjaga tak terlihat di server. Kunci tuning tidak tampil di Settings sama sekali.

Metrik (diuji):
- M1: dari 128 subset kemampuan, 0 yang inkoheren (tes properti eksaustif, ES-00).
- M2: pembaca flag katalog di luar runtime kemampuan = 0 (tes pagar grep, ES-00 dan ES-14).
- M3: tak ada fitur menyala default; satu-satunya perubahan "store kosong" = ledger internal selalu hidup (KE-1).
- M4: render default Settings memuat 0 dari 8 elemen D8 dan 0 kata `webhook|polling|secret|mode|restart|berbahaya|token root` (ES-12).
- M5: 7/7 kemampuan efektif tanpa restart; tiap kunci `derive` berlabel `restart !== 'boot'` (ES-14).

## 2. Keputusan terkunci (jangan diperdebatkan ulang)

| ID | Keputusan |
|----|-----------|
| D1 | Model kemampuan, `implies`, `isEnabled` tunggal + pagar grep + tes properti. Hapus `evalRequires`, `EnvRequiresNote`, badge "Belum berpengaruh". Field `requires` di registry tetap (KE-7). |
| D2 | Tanpa penyimpanan baru. Kunci lama = input legacy; sub-opsi tanpa induk diabaikan + satu `warn` per kunci per proses; kartu menawarkan "Perbaiki" bila rantai legacy putus. |
| D3-REV (ganti D3) | Tidak ada "berbahaya", "Dikunci", token root, atau dialog bertingkat di permukaan. Satu sakelar, langsung. Keamanan = penjaga server tak terlihat (§3.3). Tanpa token untuk loopback; non-loopback tetap token (bootstrap env, bukan Settings). `capability_audit` (tanpa secret); pencabutan langsung berlaku. G1/Opsi R dibuka ulang atas perintah user. |
| D4-REV | Tidak ada "Perlu restart" di permukaan, tanpa pengecualian. Tiap kunci yang tampil wajib hot. Boot-only (HOST/PORT/DATA_DIR/token) keluar dari Settings pengguna. Browser/autonomy/CA2/Telegram/ledger dibuat hot-wire atau selalu-siap (-b §2). LEDGER selalu hidup internal, tanpa saklar. |
| D5 | Deteksi/turunan: runtime Central (claude, opencode, mock), CHANNELS/TELEGRAM/CENTRAL_TELEGRAM/CENTRAL_CHAT diturunkan, webhook secret dibangkitkan otomatis, Chromium dideteksi. Satu dialek flag/angka kanonik di `envFlag.ts`. `RETIRED_KEYS` ditunda. Tidak ada kunci dihapus. |
| D6 | Tab "Environment" diganti "Kemampuan". Teks UI Indonesia. |
| D7 | Tidak ada secret ke DOM/log/respons/audit. `NODETERM_*`, `x-nodeterm-node-token`, `nodeterm:` tidak diubah. |
| D8 (+tambahan) | 8 elemen lama (chip filter; banner/lencana restart; Default/Aktif sekarang/Tersimpan + Atur ulang; nama env var; Ledger Aktif/Bayangan; "Mesin agen" saat Central off; kelompok berisi satu kartu; tautan "ada di tab Channels") TIDAK ada di UI mana pun. Central chat bukan pengaturan: bagian dari Agent Pusat. Sub-opsi hanya di kartu induk saat induk aktif. |
| D9 | Tidak ada "operator". Daftar flag Lanjutan DIHAPUS; kunci tuning tidak tampil di Settings. Bagian kecil tertutup "Lanjutan" maksimal 4 butir (-b §4). Telegram = tempel token, selesai. Kemampuan "tanya saat dibutuhkan" (-b §5). |

## 3. Kontrak W0

### 3.1 Katalog dan tipe (ES-00 menulis persis; prefiks `feature` karena `src/shared/workspace.capabilities.ts` sudah ada [TERVERIFIKASI])

```ts
// src/shared/featureCapabilities.ts (murni, client-aman, <=200 baris)
export const CAPABILITY_IDS =
  ['central', 'workers', 'autonomy', 'browser', 'files', 'filesWrite', 'telegram'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]
export interface CapabilitySub { key: string; label: string; defaultOn: boolean }
export interface CapabilityDef {
  id: CapabilityId
  title: string                       // Indonesia; mis. "Agent Pusat"
  blurb: string                       // fungsi dalam bahasa biasa, BUKAN peringatan
  implies: readonly CapabilityId[]    // prasyarat; on hanya bila semuanya on
  primaryKey: string                  // saklar utama di store override
  needs?: 'telegramToken' | 'chromium'
  subs?: readonly CapabilitySub[]     // tampil hanya di kartu induk saat induk on
}
export type CapabilityStatus = 'on' | 'off' | 'needs-step'
export interface CapabilityView {
  id: CapabilityId; title: string; blurb: string; status: CapabilityStatus
  step?: { kind: 'fixChain' | 'telegramToken' | 'chromiumPath'; label: string }
  detail?: string                     // satu kalimat jujur bila bukan 'on'; "Tersambung sebagai @nama"
  alsoTurnsOn?: CapabilityId[]        // untuk teks "ikut menyalakan: ..."
  subs?: { key: string; label: string; on: boolean }[]
}
export interface CapabilitiesResponse {
  capabilities: CapabilityView[]      // urut CAPABILITY_IDS
  advanced: {
    agentEngine: { value: 'auto' | 'claude' | 'opencode' | 'mock'; detected: string }
    chromiumPath: { value: string; detected: boolean }
    dataDir: string                   // read-only
  }
}
export function closure(id: CapabilityId): CapabilityId[]        // id + implies rekursif, urut topologis
export function dependents(id: CapabilityId): CapabilityId[]     // yang ikut mati bila id dimatikan
export function deriveFlags(on: ReadonlySet<CapabilityId>): Record<string, string>  // fungsi himpunan, bukan per-kemampuan
```

```ts
// src/server/featureCapabilities.runtime.ts (<=200) + .legacy.ts (<=150)
export function isEnabled(id: CapabilityId, env: NodeJS.ProcessEnv = process.env): boolean
export function enabledSet(env?: NodeJS.ProcessEnv): ReadonlySet<CapabilityId>
export function legacyToCapabilities(env: NodeJS.ProcessEnv): { enabled: Set<CapabilityId>; ignored: string[] }
export interface CapabilityHook { start(): void | Promise<void>; stop(): void | Promise<void> }
export function onCapabilityChange(id: CapabilityId, h: CapabilityHook): () => void  // start/stop idempoten
export function reconcile(prev: ReadonlySet<CapabilityId>, next: ReadonlySet<CapabilityId>): Promise<void>
```

Aturan tunggal: `X` on <=> `flagOn(env[X.primaryKey])` DAN semua `implies` on (rekursif). Kunci anak hanya dihormati bila induk on. `isEnabled` membaca `process.env` per panggilan (`apply()` sinkron, jadi hot). `deriveFlags` juga menurunkan `WEBTERM_CENTRAL_CHAT` (= central), `WEBTERM_CHANNELS`/`WEBTERM_CENTRAL_TELEGRAM` (= telegram, dan central untuk yang kedua), dan kunci ledger bila ada.

| id | Judul | primaryKey | implies | needs |
|----|-------|-----------|---------|-------|
| central | Agent Pusat | `WEBTERM_CENTRAL` | - | - |
| workers | Worker orchestrator | `WEBTERM_ORCHESTRATOR_RUN` | central | - |
| autonomy | Otonomi Agent Pusat | `WEBTERM_CENTRAL_AUTONOMY` | workers | - |
| browser | Browser di kanvas | `WEBTERM_BROWSER` [ASUMSI] | - | chromium |
| files | Kelola file | `WEBTERM_FILES_VIEWERS` | - | - |
| filesWrite | Ubah dan unggah file | `WEBTERM_FILES_MUTATE` | files | - |
| telegram | Telegram | `WEBTERM_TELEGRAM` | - | telegramToken |

Kalimat `blurb` contoh: workers "Izinkan agent menjalankan perintah di komputer ini." Sub `workers`: `WEBTERM_RUN_REQUIRE_APPROVAL` "Minta persetujuan sebelum worker berjalan", default ON (Q3).

### 3.2 Aturan perilaku

Menyalakan kemampuan menulis `closure(id)` sekaligus (UI: "ikut menyalakan Agent Pusat"). Mematikan mematikan `dependents(id)`. Rantai tak mungkin putus lewat UI; hanya bisa lewat kunci legacy, dan itu muncul sebagai `needs-step` "Perbaiki".

### 3.3 Penjaga tak terlihat (ES-02; menggantikan `dangerous`/`rootGate`)

Satu fungsi `settingsGuard(req)` untuk mutasi di `/api/settings/env*` dan `/api/capabilities*`. Lolos bila (A) token root valid dan bukan token node/capability, atau (B) tak ada token ditegakkan DAN peer loopback (socket) DAN tak ada header `Forwarded`/`X-Forwarded-*` (V6) DAN `Host` lolos `hostAllowed` [TERVERIFIKASI `auth.ts:15,38`] DAN `Origin` ADA dan sama-origin. Catatan: `sameOrigin` (`auth.ts:86`) mengizinkan Origin absen; jalur B mutasi lebih ketat karena browser selalu mengirim Origin pada POST/PUT. Selain itu 403 `forbidden`, ditulis ke audit. Token node/capability ditolak (V3). Tes statis: tak ada def tool central mengimpor modul settings/capabilities (V4). Gerbang `dangerous`/`rootGate` (`envSettings.service.ts` validate, `envSettings.runtime.ts:53`) dihapus; `dangerous` tinggal sebagai label internal untuk detail audit.

## 4. Nasib CH-xx

Karena D9 mengganti alur Telegram dan menghapus UI env generik, CHENV TIDAK dijalankan (basis `chore/chenv-int` memang tidak ada). Tidak ada tabrakan berkas.

| CH | Nasib | Alasan |
|----|-------|--------|
| 00 pecah SettingsPanel | DIGANTIKAN oleh ES-12 | SettingsPanel 278 baris menyusut karena tab Environment/Channels dihapus |
| 01 registry C5/C6 | DIGANTIKAN | `requires` tak dibaca client; label `restart` benar oleh WS domain |
| 02 status beralasan + Tes koneksi | DIUBAH, diserap ES-07 | `getMe` jadi langkah "Hubungkan", bukan tombol terpisah |
| 03 hot token | DIGANTIKAN oleh ES-07 | hot-start idempoten |
| 04 shell Integrasi/Server | DIBATALKAN | panel "Info server" dihapus (D3-REV) |
| 05 kartu Telegram tunggal | DIUBAH, diserap ES-11 | kartu di tab Kemampuan, tab Channels dihapus |
| 06 badge provenance | DIBATALKAN | status tiga-serangkai dilarang (D8) |
| 07 kartu token | DIBATALKAN | tak ada konsep token di UI (D3-REV) |
| 08 impor .env | DIBATALKAN dari UI | alur panjang; API impor tetap, UI ditunda |
| 09 kartu run-pertama | DIBATALKAN | sakelar + tawaran kontekstual menggantikan |
| 11 docs | DIGANTIKAN oleh ES-15 | satu workstream docs |

## 5. Peta gelombang dan kepemilikan (16 WS, 7 gelombang)

Jatah = tambahan bersih maksimum (cek `wc -lm`). Berkas yang sudah melewati batas Rule 8 dipecah dulu oleh pemiliknya. Urutan: pengerasan server dan `isEnabled` dulu, hot-wire per kemampuan, client, docs terakhir.

| W | WS | Worker | Berkas milik eksklusif |
|---|----|--------|------------------------|
| 0 | ES-00 kontrak | wkr-envsimple-contract-01 | `shared/featureCapabilities.ts`, `server/featureCapabilities.runtime.ts`, `.legacy.ts`, tes |
| 0 | ES-01 dialek | wkr-envsimple-flag-01 | `server/envFlag.ts` + tes inventori parser |
| 1 | ES-02 penjaga | wkr-envsimple-guard-01 | `featureCapabilities.guard.ts`, `.audit.ts` (baru), `envSettings.service.ts`, `.api.ts`, `.runtime.ts`, `db.ts` (+3) |
| 1 | ES-03 ledger/orch | wkr-envsimple-orch-01 | `ledger/ledgerRuntime.ts`, `orchestratorRunModel.ts`, `orchestratorRunApproval.ts`, `envRegistry.platform.ts` |
| 1 | ES-04 central/CA2 | wkr-envsimple-central-01 | `central/ca2Boot.ts`, `centralModel.ts`, `chat/turnService.ts`, `runtime/runtimeFlag.ts`, `runtime/runtimeDetect.ts` (baru), `envRegistry.central.ts`, `.ca2.ts` |
| 1 | ES-05 files | wkr-envsimple-files-01 | pembaca `WEBTERM_FILES_*` [BT], `envRegistry.files.ts` |
| 2 | ES-06 autonomy | wkr-envsimple-auto-01 | `centralAutonomyBoot.ts` |
| 2 | ES-07 telegram | wkr-envsimple-tg-01 | `channels/channelsRuntime.ts`, `telegramPollWiring.ts`, `telegramMode.ts`, `channelSecret.ts`, `channelsMasterGate.ts`, `envRegistry.channels.ts`, `telegram.connect.ts` (baru) |
| 2 | ES-08 browser | wkr-envsimple-browser-01 | `browser/browser.runtime.ts`, `browser.activate.ts` (baru), `chromium.launch.ts`, `browser/browser.envRegistry.ts` |
| 3 | ES-09 API kemampuan + boot | wkr-envsimple-api-01 | `featureCapabilities.api.ts`, `.service.ts` (baru), `api.ts` (+4), `index.ts` (netto 0) |
| 4 | ES-10 klien data | wkr-envsimple-ui-01 | `capabilitiesApi.ts`, `useCapabilities.ts`, `CapabilityCard.tsx`, `CapabilityOffer.tsx` |
| 4 | ES-11 kartu Telegram | wkr-envsimple-ui-02 | `TelegramCard.tsx`, `useTelegramCard.ts`, `telegramCardLabels.ts` |
| 5 | ES-12 Settings | wkr-envsimple-ui-03 | `SettingsPanel.tsx`, `CapabilitiesSection.tsx`, `AdvancedSection.tsx`, hapus `Env*`/`Channels*`/`envRequires*`/`useEnvSettings`, `envSettings.contract.ts`, `envSettings.state.ts` |
| 5 | ES-13 menu browser | wkr-envsimple-ui-04 | `browser.feature.ts`, `browser.status.ts`, `useBrowserAdd.ts`, `canvasMenu.*`, pembuka panel Central [BT] |
| 5 | ES-14 regresi | wkr-envsimple-regress-01 | tes baru saja (matriks legacy, pagar grep final, label `restart`) |
| 6 | ES-15 docs | wkr-envsimple-docs-01 | `README.md` (kontrak), `docs/decisions/envsimple.md`, `docs/changelog/envsimple.md`, 3 baris `CHANGELOG.md` |

`index.ts` hanya ES-09. `api.ts` (202 baris, melewati batas route 150 [TERVERIFIKASI]) hanya ES-09, +4 baris kohesif. Tak ada berkas dimiliki dua WS dalam satu gelombang.

## 6. Stop-gate

- S-E1: fitur apa pun menyala default pada store kosong (selain ledger internal), atau tes "store kosong identik" merah.
- S-E2: secret/token terlihat di DOM, log, respons, atau audit.
- S-E3: pembaca flag katalog mentah di luar runtime kemampuan.
- S-E4: mutasi settings/kemampuan lolos dari penjaga (token node, header forwarded, Origin asing).
- S-E5: berkas melewati batas Rule 8, atau worker menyentuh berkas WS lain.
- S-E6: kata/elemen terlarang (M4) muncul di render default.
- S-E7: hot-start tidak idempoten (start/stop/start) atau dua pollster/browser hidup.
- S-E8: kunci `derive` berlabel `restart:'boot'` atau bacaan di-cache saat boot.
- S-E9: typecheck, `npm test`, atau `bun test --no-env-file` merah.
- S-E10: rename identitas protokol.
- S-E11: laporan worker tak cocok dengan `git diff` (laporan fiktif pernah terjadi).

## 7. Risiko keamanan jujur (D3-REV)

Tidak lagi dibendung pada loopback terbuka: proses sesama user (termasuk shell PTY dan agent) dapat mengaktifkan Worker/Otonomi lewat API tanpa persetujuan. Sebelumnya hal itu juga mungkin (V1: `token/enable` lalu `PUT`), jadi bukan kemampuan teknis baru, tetapi gesekan satu langkah hilang. Pengganti: penjaga §3.3 (peer loopback, `Host`, `Origin` wajib ada dan sama pada mutasi, tolak forwarded, tolak token node/capability), tes V4 (tool central tak bisa memanggil rute settings), audit tiap grant/revoke, serta token wajib untuk akses non-loopback (L3). Penjaga TIDAK menghentikan `curl` yang menambahkan header `Origin` palsu dari proses sesama user; itu batas yang diterima user. Mencabut menghentikan pemicu BARU, bukan worker yang sedang berjalan (KE-5).

## 8. KONFLIK DENGAN KEPUTUSAN

- KE-1 (D2 vs D4-REV ledger): `index.ts:51` `startLedgerRuntime()` dan `ledgerRuntime.ts:74` `ledgerMode` default off. Ledger selalu hidup membuat file ledger dan rute ledger aktif pada store kosong. Usulan: `ledgerMode` default `on`; `shadow` via env pengembang `WEBTERM_LEDGER_SHADOW=1`; override lama `off` tidak lagi dihormati. Footprint: satu file sqlite kecil di data dir, tanpa penulis latar bila tak ada fitur aktif; gagal buka = degradasi dengan warn (pola shadow-fail yang ada).
- KE-2 (migration): `db.ts:21-35` tak punya direktori migration; pola = `CREATE TABLE IF NOT EXISTS` inline. Usulan `ensureAuditSchema(db)` idempoten dipanggil dari `openDb` (+3 baris).
- KE-3 (dialek): `ledgerMode` (`1/true` = off), `runtimeFlag.ts`, `reliabilityEnabled` [BT] beda dari `parseFlag`; menyatukan membuat `X=1` yang dulu senyap off menjadi on. Dicatat di CHANGELOG.
- KE-4 (menu Browser selalu): `index.ts:188,205` rute WS browser bergantung `browserRuntime`. Usulan: rute selalu, handler memakai `activeBrowser()`, status off dijawab `off`.
- KE-5: pencabutan tidak membunuh worker/PTY berjalan; "Hentikan semua" ditunda.
- KE-6 (nomor baris): `centralAutonomyBoot.ts` `enabled: true` ada di baris 78-80 (RND: 77); `Dock.tsx` 407 baris (RND: 399).
- KE-7 (D1): `requires` dipakai tes registry (`envRegistry.meta.test.ts:74-92`, `envRegistry.test.ts:96`). Hanya pemakaian client dihapus; penghapusan field ditunda.
- KE-8 (D3-REV): mutasi tanpa token dan tanpa `Origin` (skrip curl) kini 403; pengguna skrip memakai `WEBTERM_TOKEN`. Berpotensi mengubah tes lama dan proxy dev Vite [BT]; CHANGELOG.
- KE-9 (D9 webhook otomatis): tak ada kode yang mendeteksi URL publik [TERVERIFIKASI grep nihil]. `telegramMode.ts:resolveTelegramMode` sudah memilih poll bila token ada. Usulan: poll selalu; webhook hanya bila env `WEBTERM_TELEGRAM_MODE=webhook` eksplisit (secret otomatis tetap dibuat).
- KE-10 (D9 tautan chat satu ketukan): `channelBindingsStore.ts:34-45` mewajibkan `projectId` dan `role`; grup hanya `viewer|operator`. Usulan: "Tautkan chat ini" memakai `owner` untuk chat privat dan `viewer` untuk grup; sumber `projectId` default [BT], worker melapor bila tak ada sumber sah.

## 9. Urutan orkestrator

| Langkah | Aksi | Gerbang |
|---------|------|---------|
| 0 | Cabang `chore/envsimple-int` dari `main`; tiap WS cabang `feature|fix|refactor|chore/envsimple-<nama>` | status bersih |
| 1 | W0: ES-00 + ES-01 satu pesan | tipe + tes; S-E3 |
| 2 | W1: ES-02..05 | S-E4, S-E8 |
| 3 | W2: ES-06..08 | S-E7 |
| 4 | W3: ES-09 | tes API + `index.ts` netto 0 |
| 5 | W4: ES-10, ES-11 | S-E2 |
| 6 | W5: ES-12..14 | S-E1, S-E3, S-E6 |
| 7 | W6: ES-15 | CHANGELOG ada |
| 8 | Laporan + checklist Rule 6; merge hanya atas perintah | semua hijau |

Tiap WS: review `git diff` dan `wc -lm` sebelum merge ke int; WS gagal tak memblokir WS sejajar.

## 10. Tidak terverifikasi

1. Lokasi pembaca `WEBTERM_FILES_*` (ES-05).
2. Kunci primer browser `WEBTERM_BROWSER` dan kunci path Chromium (`browser.runtime.ts:2`, `browser.envRegistry.ts`).
3. Pemanggil `bootCa2` dan `startChannelsRuntime` di `index.ts:61,79` apakah bersyarat flag (ES-09).
4. Sumber `projectId` default untuk tautan chat (KE-10).
5. Proxy dev Vite dan `Origin` (KE-8).
6. Kestabilan 9 flag rilis CA2: diperlakukan sebagai opsi anak `central`, tidak tampil.
7. Dua koneksi SQLite (`envSettings.runtime.ts` membuka koneksi kedua) untuk tabel audit.

## 11. Pertanyaan terbuka (default dipakai bila tak dijawab)

- Q1: Tabel audit lewat `ensureAuditSchema` (KE-2). Default ya.
- Q2: `CHANGELOG.md` 24.106 karakter melanggar Rule 8. Default: entri di `docs/changelog/envsimple.md` + 3 baris tautan.
- Q3: `RUN_REQUIRE_APPROVAL` default ON saat Worker dinyalakan. Default ya.
