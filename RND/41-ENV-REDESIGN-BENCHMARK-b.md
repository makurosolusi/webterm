# 41-b — Redesain Environment: model data, UI, registry, migrasi, workstream

Lanjutan `41-ENV-REDESIGN-BENCHMARK-a.md` (bagian 1-3: kondisi, benchmark, kriteria UI vs .env). Label `[BT]` = belum terverifikasi, `[opini]` = penilaian.

## 4. Model data registry v2

Tambahan di `EnvSpec` (semua opsional + default turunan, agar entri lama tetap valid):

| Field | Tipe | Default turunan | Fungsi |
|---|---|---|---|
| `owner` | `'terminal'\|'agent'\|'channels'\|'central'\|'canvas'\|'server'\|…` (string, bukan union tertutup) | dari `group` via peta di file domain | Tab Settings tempat entri tampil. Menggantikan `EnvGroup` tertutup (F3). |
| `section` | string (judul kartu di tab) | label `group` | Kelompok visual di dalam tab. |
| `audience` | `'user'\|'advanced'\|'internal'` | `'user'` (dangerous → `'advanced'`) | Visibilitas; `internal` tak pernah dikirim ke UI. |
| `requires` | `{ key, equals?: string\|string[], reason }[]` | `[]` | Prasyarat terstruktur (F4): UI menonaktifkan + menjelaskan; server menambah `blockedBy` di state; **tidak** menolak PUT (urutan edit bebas), hanya memperingatkan. |
| `kind` | tambah `'path'`, `'list'`, `'duration'` | — | Kontrol lebih tepat daripada `string` bebas (`MEMORY_DIR`=path, `CONTROL_CWD_ROOTS`=list, `*_MS`=duration). |
| `unit` | string | — | Sufiks input (`ms`, `token`). |
| `restart` | `'none'\|'restart'` | dari `hot` | Ganti boolean `hot` agar terbaca; wajib eksplisit (lihat test). |
| `effectiveDefault` | `(env) => string` opsional, hanya server | `default` | Nilai efektif turunan (F9, mis. mode Telegram bergantung token). State mengirim `effective` terpisah dari `default`. |
| `since` | versi string | — | Untuk badge "Baru" + changelog. |
| `stage` | `'ga'\|'preview'\|'experimental'` | `'ga'` | Seperti flag Grafana/VS Code; `experimental` ikut audience advanced. |
| `aliases` | string[] | — | Nama lama (migrasi, bagian 7). |
| `docs` | path/anchor | — | Tautan bantuan. |
| `deprecated` | string | — | Pesan; entri tetap terbaca, tak diedit. |

State API menambah per entri: `owner, section, audience(≠internal), requires→blockedBy[], effective, stage, since`. Struktur kunci tetap `KEY`.
`description` jadi teks + opsional `detail` (markdown ringan untuk popover); hapus backtick dari teks polos (F12).

## 5. Rancangan UI

**Struktur (rekomendasi tegas):** bubarkan "Environment" sebagai tempat semua variabel.
1. Tiap entri `audience: user` tampil **di tab pemiliknya** sebagai Field biasa (komponen `Field` yang sama dengan Terminal/Canvas → ikut pencarian, ikut gaya). Contoh: Telegram (flag, mode, token, secret webhook) + status hidup bergabung di **Channels**; Central/orchestrator/memori di tab **Agent** (atau tab baru "Central" bila > ~12 entri).
2. Tab **Environment** diganti nama **"Server"** (atau tetap "Environment" bila user menolak rename) dan hanya memuat: Ledger & kontrol server, log, **Lanjutan** (accordion, tertutup), dan "Info server" read-only (bootstrap, tanpa nilai). Identitas `WEBTERM_*` tampil sebagai monospace kecil di bawah label (bukan label utama).
3. Satu pencarian untuk semuanya: `EnvSection` tak lagi `return null` saat query; entri memakai `Field` (`data-slot="settings-field"`) sehingga hitungan "N setting ditemukan" benar; kata kunci pencarian mencakup `KEY`.

**Pola simpan:** `flag`/`enum` → terapkan langsung saat diubah (satu PUT, snackbar "Dibatalkan?" 5 dtk); `number/text/path/list` → Enter/blur menyimpan, `Esc` batal; secret → tetap input + "Simpan" sendiri (write-only); bila ada ≥2 draf `dangerous`, pakai bar lekat bawah "N perubahan · Batal · Simpan" yang memakai PUT atomik yang sudah ada (`service.ts:151`). Hapus tombol Simpan per baris untuk flag/enum.

**Indikator (kosa kata tunggal, 3 saja):**
| Penanda | Arti | Tampil |
|---|---|---|
| titik biru + "Diubah" | ada override dari Pengaturan; tombol Reset | di label (pola VS Code) |
| pill "Perlu restart" | nilai tersimpan ≠ nilai berjalan (`pendingRestart`) | hanya bila benar-benar menunggu, bukan statis; kunci `restart:'restart'` cukup ikon ⟳ di hint |
| "Dari .env"/"Dikunci" | sumber env menang / `WEBTERM_ENV_SETTINGS=off` | teks kecil di bawah |
Hapus badge `env`/`default` mentah. "Default: X" pindah ke tooltip/hint hanya bila beda dari nilai efektif; tampilkan "Efektif: poll (token terisi)" bila `effective` ≠ `default`.

**Kontrol per kind:** flag → switch (satu kontrol; `WEBTERM_CHANNELS` jadi flag default-on dengan label terbalik jelas "Kanal aktif"); enum → select dengan `enumDescriptions` (mis. ledger `off/shadow/on` masing-masing 1 kalimat) atau radio bila ≤3; number → input + `unit` + rentang di hint; path → input + validasi absolut; list → chip/multi-baris; secret → status "Terisi/Kosong" + ganti/hapus.

**Dependensi:** child dengan `requires` tak terpenuhi → kontrol `disabled`, baris kecil "Butuh Ledger = on. [Aktifkan Ledger]" (link melompat+fokus ke kunci itu). Tidak pernah diam-diam mengubah kunci lain.

**Header halaman:** judul tab + 1 kalimat penjelasan; Segarkan jadi ikon di kanan judul (bukan baris sendiri); banner restart punya tombol "Restart server" bila endpoint tersedia [BT: tak ada saat ini; jika tak ada, tetap teks].

**Skala puluhan flag:** tab Server/Lanjutan memakai accordion per `section` (tertutup default bila >8 entri), filter cepat `Diubah` / `Perlu restart` / `Lanjutan`, dan `stage: experimental` dilabeli "Eksperimental" serta dikumpulkan di "Lanjutan".

## 6. Registry per-domain + invarian (menangani flag paralel)

Prinsip: **satu file registry per workstream/domain**, masing-masing memiliki grup/section/owner-nya sendiri; tak ada file bersama yang harus diedit tiap flag baru.

- `owner/group` jadi string; label grup & urutan hidup di file domain yang sama (`export const GROUP_META`), digabung otomatis oleh `envRegistry.ts` (satu baris `import` per domain — satu-satunya titik sentuh bersama, dan itu sudah konflik-terkelola: tiap workstream hanya menambah satu baris).
- Server mengirim `groups: [{ id, label, order, owner }]` di state sehingga klien **tak** memiliki `ENV_GROUP_ORDER/LABEL` sendiri (menghapus F3 sisi klien).
- Aturan nama file: `envRegistry.<domain>.ts` ≤100 baris (test sudah ada, `envRegistry.test.ts:40`).

Invarian yang dijadikan test (tambahan, vitest murni, tanpa jaringan):
| Test | Mencegah |
|---|---|
| tiap entri punya `label`, `description`, `owner`, `restart` eksplisit, `audience` valid | entri setengah jadi |
| tiap `requires.key` ada di registry (atau bootstrap) dan tak siklik | dependensi hantu |
| tiap kunci non-internal punya **pembaca**: `grep` di `src/` (non-test, non-`envRegistry*`) menemukan literal kunci atau konstanta yang dipakai; allowlist eksplisit bila tak ada | var mati ("UI wajib pembaca"); pola ini sudah dipakai `envRegistry.test.ts:25` untuk `HMAC_SECRET` |
| `default` lolos validator (sudah ada) + `effectiveDefault` tak melempar | default salah |
| kunci bootstrap ∩ registry = ∅ (sudah ada) | eskalasi lewat API |
| tak ada dua entri `label` sama dalam satu `owner` | label membingungkan (F6/ledger) |
| `restart:'none'` hanya bila kunci ada di daftar `HOT_VERIFIED` yang menyebut file pembaca | restart salah (F10) |
| entri `dangerous` ⇒ `audience !== 'user'` | bahaya di halaman utama |
| daftar entri tanpa meta eksplisit (`LEGACY_NO_META`) hanya boleh menyusut | migrasi bertahap tanpa mundur |
Semuanya test vitest biasa; tidak perlu CI/hook baru.

## 7. Migrasi tanpa kehilangan nilai tersimpan

Data tersimpan: satu baris `app.env_overrides` = JSON `{KEY: nilai}` (`store.ts:7`) dan file `<dataDir>/secrets/<KEY>` (`secrets.store.ts:16`). Perubahan metadata (owner, audience, requires, UI) **tidak menyentuh keduanya** — nol migrasi data.
Hanya **ganti nama/hapus kunci** yang perlu perhatian:
1. Rename: `aliases:['KEY_LAMA']`; `parseOverrides` (`store.ts:53-58`) menerjemahkan alias → kunci baru saat load dan menulis ulang pada PUT berikutnya; tanpa itu kunci lama dibuang dengan `warn` (perilaku sekarang, diam-diam kehilangan nilai).
2. Hapus (var mati): jangan hapus override yang tersimpan; `parseOverrides` sudah mengabaikan kunci tak dikenal dengan warn (tak melempar). Tambah satu log `info` saat boot "N override usang diabaikan" agar terlihat.
3. Pindah `owner`: tak berefek ke data.
4. Perubahan kind (mis. `WEBTERM_CHANNELS` enum→flag): nilai `on|off` kompatibel dengan `validateEnvValue` flag (`validate.ts:22`) → aman.
5. Secret: nama file = KEY; rename secret wajib migrasi file (rename atomik) — hindari rename secret.
Idempoten dan reversibel: karena `base` snapshot dipertahankan, rollback kode lama tetap membaca baris yang sama.

## 8. Peta workstream implementasi (WS-ENV-nn) dan urutan

Konflik: `envRegistry.ts`, `envRegistry.test.ts` sudah dimodifikasi di `ca2-int` (WS-19 integrator Central Agent v2 menambah `envRegistry.ca2.ts` + 1 impor + 21 baris test). `envRegistry.types.ts` TIDAK diubah di sana.
**Keputusan:** ENV-00..03 jalan dari `main` HANYA di file baru + `types.ts` (aditif, field opsional) sehingga tidak bentrok; ENV-04+ (yang menyentuh `envRegistry.ts`/test bersama) menunggu merge `feature/ca2` ke `main` lalu rebase. Dengan field opsional + default turunan, entri `ca2.ts` tetap valid tanpa diedit.

| WS | Isi | File dimiliki (eksklusif) | Bergantung | Est. |
|---|---|---|---|---|
| ENV-00 kontrak | field baru `EnvSpec` opsional, builder (`flag/enumOf/…` menerima `meta` opsional), tipe `EnvGroupMeta`, turunan default `owner/audience/restart` | `envRegistry.types.ts`, `envRegistry.derive.ts` (baru), test baru `envRegistry.types.test.ts` | — | S |
| ENV-01 service/API | state membawa `owner/section/audience/blockedBy/effective/groups`, filter `internal`, `effectiveDefault`, alias di `parseOverrides` | `envSettings.service.ts`, `envSettings.store.ts`, `envSettings.api.ts` (+test mereka) | 00 | M |
| ENV-02 klien inti | `useEnvSettings` + tipe API; komponen baru `EnvField` (switch/select/number/path/list, auto-save, modified, requires), hapus breadcrumb & Simpan per baris untuk flag/enum, pencarian lintas section, header | `EnvSection.tsx`, `EnvEntryRow.tsx`, `EnvValueControl.tsx`, `envLabels.ts`, `envSettingsApi.ts`, `useEnvSettings.ts`, `settings-env.css`, `EnvSection.test.tsx` | 01 | M |
| ENV-03 tab Channels | pindahkan field Telegram ke `ChannelsSection` (render entri `owner=channels` via komponen ENV-02), perbaiki `channelsLabels.ts:8-9` | `ChannelsSection.tsx`, `channelsLabels.ts`, test | 02 | S |
| ENV-04 registry audit | terapkan vonis topik-1 (`39-…`): KEEP/MOVE/HIDE/REMOVE/FIX pada data, metadata eksplisit `channels/central/platform` | `envRegistry.channels.ts`, `.central.ts`, `.platform.ts`, `envRegistry.ts`, `envRegistry.test.ts` | 00, **merge ca2 ke main** | M |
| ENV-05 ca2 + invarian | metadata entri `ca2.ts`, test invarian bagian 6 (pembaca, requires, LEGACY_NO_META) | `envRegistry.ca2.ts`, `envRegistry.invariants.test.ts` (baru) | 04 | M |
| ENV-06 tab Agent/Central | pindah entri central/orchestrator/memori ke tab Agent (atau "Central") | `SettingsAgents.tsx`, `SettingsPanel.tsx`, test | 02, 05 | M |
| ENV-07 docs | `.env.example`/README bagian env, CHANGELOG (satu worker, di akhir, Rule 23) | `README.md` (bagian env), `CHANGELOG.md`, `.env.example` | semua | S |

Gelombang: W0 = ENV-00; W1 = ENV-01 ∥ (ENV-02 mulai setelah kontrak tipe API disepakati lewat 00); W2 = ENV-03; W3 (setelah merge ca2) = ENV-04 → 05 ∥ 06; W4 = ENV-07. Tiap WS: branch sendiri `feature/env-ws0N-…`, test nyata (Rule 3), tanpa rename `NODETERM_*`.
Flag baru dari workstream lain (browser `WEBTERM_BROWSER*`, file manager `WEBTERM_FILES_*`) setelah ENV-00: cukup file `envRegistry.<domain>.ts` baru + satu impor; test invarian menolak entri tanpa meta/pembaca.

## 9. Implikasi untuk webterm

**Rekomendasi tegas**
1. Pecah halaman Environment: entri `user` pindah ke tab pemilik fitur; "Environment/Server" hanya berisi server, log, Lanjutan (tertutup), dan info bootstrap read-only.
2. Perkaya registry dengan `owner/audience/requires/restart/effectiveDefault/stage/since/aliases`, semua opsional dengan default turunan; `EnvGroup` jadi string yang dideklarasikan per-domain.
3. UI: switch untuk flag, auto-save untuk flag/enum, penanda "Diubah/Perlu restart" tunggal, dependensi terstruktur, satu pencarian.
4. Jadikan aturan kebersihan sebagai test registry (pembaca wajib, meta wajib, requires valid), bukan dokumen.
5. Urutan: kontrak tipe dulu (aditif), registry bersama menunggu merge ca2.

**Perubahan konkret (file):** `envRegistry.types.ts` (+derive), `envSettings.{service,store,api}.ts`, `Env*.tsx`/`envLabels.ts`/`useEnvSettings.ts`/`settings-env.css`, `ChannelsSection.tsx`+`channelsLabels.ts`, registry domain, `SettingsAgents.tsx`/`SettingsPanel.tsx`, test baru invarian.

**Risiko**
- Memindahkan field ke tab lain membuat satu pengaturan punya dua jalur sampai ENV-03/06 tuntas → lakukan per-entri atomik (hapus dari Environment di commit yang sama).
- `requires` yang salah menonaktifkan kontrol yang sebenarnya berguna → hanya peringatan, bukan penolakan server; tes `requires` menunjuk kunci nyata.
- Auto-save pada flag `dangerous` berbahaya → tetap konfirmasi dan root token.
- `effectiveDefault` menambah logika di file data → hanya fungsi murni kecil, diuji, bukan I/O.
- Pembaca-wajib via grep rapuh (konstanta/alias) → allowlist eksplisit, bukan asumsi.

**Belum terverifikasi**
- Seluruh bagian 2 (benchmark produk) `[BT]`: web tools gagal; sebelum dijadikan rujukan dokumen publik buka ulang docs VS Code (`configuration` contribution point), Grafana, Coolify, Home Assistant.
- Apakah ingress poll Telegram benar-benar butuh restart saat token berubah (`index.ts:52` memilih di boot) `[BT]` — menentukan `restart` token bot.
- Apakah ada endpoint restart server untuk tombol di banner `[BT]`.
- Vonis per entri (KEEP/MOVE/HIDE/REMOVE) ada di `39-ENV-REGISTRY-AUDIT.md` (topik-1), belum dibaca saat menulis ini; temuan UX per-P0/P1 di `40-…` (topik-2).
- Rincian `RND/20-VSCODE-UI-PLAN.md` tidak memuat bagian env (grep kosong); ukuran piksel pakai `RND/vscode-measured/`.

**Estimasi total:** M–L (≈ 8 WS: 3 S, 4 M, 1 M–L bila tab "Central" baru dibuat); jalur kritis ENV-00 → 01 → 02, sisanya paralel setelah merge ca2.
