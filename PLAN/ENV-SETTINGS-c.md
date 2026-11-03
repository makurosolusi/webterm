# PLAN ENV-SETTINGS (c) — kontrak W0 dan spec siap-tempel per WS

Lanjutan `-a.md` (peta WS, P-n) dan `-b.md` (koordinasi, tes, rollout). Tempel bagian WS terkait ke prompt worker; tiap worker juga diberi `CLAUDE.md` repo. Aturan umum untuk SEMUA worker: hanya sentuh berkas yang dimiliki; dilarang commit/push/ganti branch/baca `.env*`/cetak nilai env atau secret; jalankan `TMPDIR=/tmp/st npm run typecheck`, `TMPDIR=/tmp/st npm test`, dan (server) `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`; laporan akhir menyertakan `git diff --stat` dan output tes; tidak ada test kosong; komentar/docstring 1 baris untuk symbol publik baru; tanpa dependency baru.

## c-0. Kontrak lintas-WS (dibuat ENV-00, dibaca semua)

Berkas `src/shared/envSettings.contract.ts` (≤150 baris; hanya tipe + 2 fungsi murni):

```ts
export type EnvAudience = 'user' | 'advanced'
export type EnvRestart = 'none' | 'hot' | 'boot'
export interface EnvRequire { key: string; oneOf?: string[]; note?: string } // oneOf kosong = nilai on
export interface EnvGroupMeta { id: string; label: string; order: number; owner: string }
export interface EnvEntryV2 { /* semua field v1 */ key: string; kind: 'flag'|'enum'|'text'|'secret'|'number'
  value: string; source: 'override'|'env'|'default'; pendingRestart: boolean; dangerous: boolean; editable: boolean
  label: string; description: string; group: string; owner: string; section: string; audience: EnvAudience
  requires: EnvRequire[]; restart: EnvRestart; effectiveDefault?: string; effective: string
  valid: boolean; invalidReason?: string; rawValue?: string
  options?: string[]; optionLabels?: Record<string,string>; min?: number; max?: number; unit?: string
  allowEmpty?: boolean; absolutePath?: boolean; dangerNote?: string; stage?: 'experimental'|'preview'|'stable'
  secretSet?: boolean /* hanya secret; tanpa nilai */ }
export interface EnvStateV2 { locked: boolean; rootGate: boolean
  server: { tokenSet: boolean; settingsLocked: boolean }; groups: EnvGroupMeta[]; entries: EnvEntryV2[] }
export const flagIsOn = (raw: string | undefined): boolean  // sama dengan server flagOn: trim + lowercase === 'on'
export function evalRequires(e: EnvEntryV2, get: (key: string) => string | undefined): EnvRequireResult[]
```

`EnvRequireResult = { require: EnvRequire; met: boolean | 'unknown' }`. `get` mengembalikan nilai draft bila ada, selain itu `value` server; kunci tak dikenal → `'unknown'`.
Kontrak provider klien (dibuat ENV-03 di `useEnvSettings.ts`, dipakai ENV-04/05/06 lewat impor tipe saja — ENV-03 harus menerbitkan tanda tangan ini sejak commit pertama):
```ts
export interface EnvSettingsApi { state: EnvStateV2 | null; loading: boolean; error: string | null
  draft: ReadonlyMap<string,string>; dirtyKeys: string[]; setDraft(k: string, v: string): void
  discard(): void; save(): Promise<void>; reset(k: string): Promise<void>; refresh(): Promise<void>
  valueOf(k: string): string | undefined; query: string }
export function useEnvSettingsContext(): EnvSettingsApi
export function EnvSettingsProvider(props: { children: ReactNode; query: string }): JSX.Element
```
Props baris (kontrak ENV-03↔ENV-04): `EnvEntryRow({ entry: EnvEntryV2; draft?: string; onDraft(v: string): void; onReset(): void; get(k: string): string | undefined; onJump(k: string): void; locked: boolean; rootGate: boolean })`. `EnvGroupSection` (ENV-03) me-render `EnvEntryRow` dengan props itu.

## c-ENV-00 — Kontrak & model registry v2 (W0)

*Branch:* `feature/env-settings` (basis `main`). *Berkas dimiliki:* lihat `-a.md` §5 baris ENV-00; tidak ada selain itu.
*Perilaku:*
1. Buat `envSettings.contract.ts` (§c-0) + implementasi `flagIsOn` dan `evalRequires`. Server `envFlag.ts` tidak diubah; `flagIsOn` hanya cermin klien-aman dari `flagOn`.
2. `envRegistry.types.ts`: tambah field opsional v2 pada `EnvSpec`/`Meta` (`owner,section,audience,requires,restart,effectiveDefault,stage,since,aliases,dangerNote,optionLabels,unit,unsetLabel`); `EnvGroup = string`; builder lama tak berubah tanda tangan; `base()` memetakan `hot` → `restart:'hot'` dan selain itu `'boot'`; jangan hapus `restartRequired` (tetap dihitung = `restart==='boot'`).
3. `envRegistry.meta.ts`: `resolveMeta(spec): ResolvedMeta` (derivasi §a-4: `owner` dari `GROUP_META[group]?.owner ?? group`, `section` dari label grup, `audience:'advanced'` bila domain tak ada di `EXPLICIT_DOMAINS` atau entri tak menyatakan), `requires:[]`. `envRegistry.groups.ts`: `GROUP_META` untuk grup core yang ada (`ledger, telegram, channels, central, orchestrator, memory, control, bootstrap`) + `groupMetaFor(id)` yang menurunkan `{label:id, order:900, owner:id}` untuk grup asing (agar ca2/files/browser tampil tanpa edit).
4. `envSettings.state.ts` (pecahan dari service, supaya service ≤300 baris): bangun `EnvStateV2`: normalisasi flag (`on|off`), enum cocok case-insensitive ke opsi kanonik, di luar opsi → `valid:false`, `rawValue` (dipotong 40; secret tanpa nilai), `invalidReason` Indonesia; `effective` = nilai dibaca server saat ini (`process.env` setelah overlay, sudah dinormalisasi); `server.tokenSet = Boolean(process.env.WEBTERM_TOKEN?.trim())` dan **tanpa** nilai; entri bootstrap TIDAK masuk `entries`.
5. `envSettings.service.ts`/`.api.ts`: `state()` mengembalikan `EnvStateV2`; PUT tetap atomik dan menerima payload lama; flag ditulis kanonik `on|off`; validasi tetap di `validate.ts`, diperluas: enum case-insensitive→kanonik, `allowEmpty`/`unsetLabel` (nilai kosong = hapus override), `invalidReason` tanpa nilai secret.
6. `envSettings.store.ts`: `parseOverrides` memetakan `aliases`; kunci tak dikenal **dipertahankan** (tidak ditulis ulang saat simpan; tidak diterapkan ke `process.env`) dengan `log.warn` tanpa nilai.
7. `src/client/envSettingsApi.ts`: tipe `EnvStateV2`, parser state v2, kompat PUT; `EnvSection.test.tsx`: sesuaikan seperlunya agar hijau (hanya perubahan bootstrap/keluar-entries; ENV-03 menulis ulang di W1).
*Tes wajib:* §b-8 baris ENV-00 (meta, state, store, atomik). *Selesai:* typecheck + vitest + bun-test hijau; UI lama masih berjalan (tanpa bootstrap); tidak ada perubahan di `envRegistry.ts`/`.channels|.central|.platform.ts`.

## c-ENV-01 — Hotfix kebenaran tampilan (W0)

*Berkas:* `src/client/EnvValueControl.tsx`, `EnvValueControl.test.tsx` (baru), `src/client/channelsLabels.ts`.
*Perilaku:* (a) kontrol flag memakai `flagIsOn(value)` dari kontrak (bila ENV-00 belum ada, lokal `value.trim().toLowerCase()==='on'`, diganti saat rebase); menulis `on`/`off` kanonik. (b) enum: bila `value` tak ada di `options` (case-insensitive), render opsi pertama `— tidak sah: "<nilai dipotong 40>" —` terpilih, `aria-invalid`, dan teks "Nilai tidak dikenal, dibaca sebagai bawaan"; pilih opsi sah mengubah draft. (c) `channelsLabels.ts:7-9`: sebut `WEBTERM_TELEGRAM` dan `WEBTERM_TELEGRAM_BOT_TOKEN` (alias lama `TELEGRAM_BOT_TOKEN` hanya disebut sebagai alias) dan arahkan "Atur di Settings > Fitur & server (sementara) lalu restart" — teks akhir diganti ENV-06; tanpa mengubah logika Channels.
*Tes:* `ON`→tercentang; `Off`→tidak; enum `xyz`→opsi tidak sah + `aria-invalid`; string hint mengandung nama var benar. *Selesai:* tes hijau; perubahan ≤3 berkas.

## c-ENV-02 — Isi registry + invarian (W1, setelah G1)

*Berkas:* lihat `-a.md` §5. Sebelum mengedit **verifikasi pembaca tiap kunci dengan grep** dan ikuti kode bila beda dari tabel (catat selisih). Gunakan label Indonesia ≤40 karakter, deskripsi ≤160, tanpa backtick; `dangerNote` untuk semua `dangerous`.

| ID | Kunci | owner / section | audience | restart | requires (peringatan lunak) | Catatan |
|---|---|---|---|---|---|---|
| E01 | `WEBTERM_LEDGER` | platform / Dasar | user | boot | — | `optionLabels`: off=Mati, shadow=Bayangan (catat tanpa memblokir), on=Aktif (menolak boot bila ledger rusak) |
| E02 | `WEBTERM_CHANNELS` | channels / Telegram | user | boot | — | enum on/off; klien switch; default `on`; nilai asing→tidak sah |
| E03 | `WEBTERM_TELEGRAM` | channels / Telegram | user | boot | LEDGER∈{on,shadow}; CHANNELS≠off | |
| E04 | `WEBTERM_TELEGRAM_MODE` | channels / Telegram | user | boot | TELEGRAM=on | default `''`, `effectiveDefault`="otomatis: poll bila token ada, selain itu webhook" (P-8) |
| E05 | `WEBTERM_TELEGRAM_BOT_TOKEN` | channels / Telegram | user | hot | TELEGRAM=on | secret; catatan: kirim berlaku langsung, penerimaan (poll) setelah restart; tampilkan "terisi via alias" bila hanya `TELEGRAM_BOT_TOKEN` |
| E06 | `WEBTERM_TELEGRAM_WEBHOOK_SECRET` | channels / Telegram | advanced | boot | TELEGRAM=on; MODE=webhook | secret; hanya mode webhook |
| E07 | `WEBTERM_CENTRAL` | central / Central | user | hot | — | |
| E08 | `WEBTERM_CENTRAL_CHAT` | central / Central | user | hot | CENTRAL=on | juga gerbang jembatan Telegram |
| E09 | `WEBTERM_CENTRAL_TELEGRAM` | channels / Telegram | user | boot | TELEGRAM=on; CENTRAL=on; CENTRAL_CHAT=on; CENTRAL_RUNTIME≠off; LEDGER∈{on,shadow} | gerbang sesuai `telegramPollWiring.ts:20-36` |
| E10 | `WEBTERM_CENTRAL_RUNTIME` | central / Central | user | hot | CENTRAL=on | opsi off/mock/opencode |
| E11 | `WEBTERM_CENTRAL_MODEL` | central / Central | advanced | hot | RUNTIME=opencode | ubah dari restart ke hot (per-turn) |
| E12 | `WEBTERM_CENTRAL_PLANNER` | central / Central | user | hot | CENTRAL=on; TOOLS=write | |
| E13 | `WEBTERM_CENTRAL_TOOLS` | central / Central | user | hot | CENTRAL=on | optionLabels read=Baca saja, write=Boleh menulis |
| E14 | `WEBTERM_CENTRAL_MEMORY` | central / Central | user | hot | CENTRAL=on | |
| E15 | `WEBTERM_CENTRAL_AUTONOMY` | central / Central | user | boot | CENTRAL=on; ORCHESTRATOR_RUN=on `[BT: verifikasi pembaca boot]` | dangerous + `dangerNote` "menjalankan worker nyata" |
| E16 | `WEBTERM_OPENCODE_BIN` | central / Central | advanced | hot | RUNTIME=opencode | dangerous; ubah ke hot |
| E17 | `WEBTERM_OPENCODE_ALLOW_TOOLS` | central / Central | advanced | hot | RUNTIME=opencode | dangerous; `dangerNote` "melepas penolakan bash/edit/webfetch/task pada child" ; P-2 |
| E18 | `WEBTERM_ORCHESTRATOR_RUN` | platform / Orkestrator | user | boot | LEDGER∈{on,shadow} | dangerous; pembaca per-request + boot → tetap boot |
| E19 | `WEBTERM_RUN_REQUIRE_APPROVAL` | platform / Orkestrator | user | hot | ORCHESTRATOR_RUN=on | ubah ke hot (per-call) |
| E20 | `WEBTERM_MEMORY_FILES` | platform / Memori | user | hot | — | |
| E21 | `WEBTERM_MEMORY_DIR` | platform / Memori | advanced | hot | MEMORY_FILES=on | dangerous, path absolut, kosong=`<dataDir>/memory` (`allowEmpty`) |
| E22 | `WEBTERM_CONTROL_CWD_ROOTS` | platform / Kontrol | advanced | hot | — | dangerous; daftar dipisah delimiter OS; sebut delimiter di deskripsi |
| E23 | `WEBTERM_TRUST_PROXY` | platform / Kontrol | advanced | hot | MODE=webhook | dangerous; ubah ke hot |
| E24 | `WEBTERM_LOG_LEVEL` | logs / Log | advanced | boot | — | `group:'logs'` |
| E25 | `WEBTERM_LOG_BUFFER` | logs / Log | advanced | boot | — | unit "entri", min 100, maks 100000 |
| E26 | `WEBTERM_LOG_FILE` | logs / Log | advanced | boot | — | semantik: semua nilai selain `off` = on → kanonik `on|off`, `optionLabels` |

Hasil: restart 6 kunci dikoreksi (E05, E11, E16, E17, E19, E23). Tambahkan `GROUPS` ke berkas domain (`channels`, `central`, `platform`, `logs`) dan compose di `envRegistry.ts` sambil mempertahankan `ENV_SETTINGS_SWITCH`, `BOOTSTRAP_ONLY_KEYS`, `specFor`, `isBootstrapOnly`. Setelah G1: beri metadata eksplisit (owner/audience) pada `envRegistry.ca2.ts` (default `advanced`, `owner:'central'`, `section:'Central — agen'`) dan `envRegistry.files.ts` (`group:'files'`, `owner:'files'`, `audience:'user'` untuk saklar utama, lainnya `advanced`) **tanpa mengubah kunci/default/hot**. Tulis `envRegistry.invariants.test.ts` (§b-8.1) dan perbarui `envRegistry.test.ts` (default `TELEGRAM_MODE` `''`; hilangkan daftar nama berkas hardcode → glob). *Selesai:* semua invarian hijau di registry gabungan.

## c-ENV-03 — UI struktur, simpan massal, provider (W1)

*Berkas:* §a-5. *Perilaku:* implementasikan `EnvSettingsProvider`/`useEnvSettingsContext` sesuai kontrak c-0 (fetch lazy, cache selama dialog terbuka, `loading` benar saat refresh; Segarkan tidak membuang draft kunci yang masih ada, membuang draft kunci yang nilainya server sama). `EnvSection`: header (judul "Fitur & server" dari `envLabels`, kotak filter cepat Diubah/Perlu restart/Berbahaya, tombol Segarkan di baris yang sama), `EnvSaveBar` sticky (muncul bila `dirtyKeys.length>0`: "N perubahan belum disimpan · Simpan · Buang"; fokus dikelola; setelah sukses `role=status` mengumumkan "Tersimpan"), `EnvGroupSection` per `section` memakai `<details>`: `audience:'user'` terbuka, `advanced` dikumpulkan dalam "Lanjutan" tertutup (terbuka otomatis bila ada entri `valid:false`, dirty, atau cocok pencarian); entri `owner:'channels'` tidak dirender dan diganti satu baris tautan "Konfigurasi Telegram ada di tab Channels" (konstanta `CHANNELS_OWNS_TELEGRAM`, ON setelah ENV-06 merge; sebelum itu entri channels tetap dirender); `EnvServerCard` (token root terisi/kosong, pengaturan terkunci; satu penjelasan P-13 bila `!rootGate`); `EnvRestartBanner` dari `entries.filter(pendingRestart)` memakai label manusia (bukan KEY), sticky, tidak hilang saat unmount; konfirmasi singkat sebelum `save()` bila ada kunci `dangerous` dirty. Pindahkan kelas `st-ch-*` yang dipakai ke `settings-env.css` (S3). Tidak ada `return null` karena query: baris yang tak cocok disembunyikan CSS/`hidden`, draft aman. *Tes:* §b-8 ENV-03; pecah `EnvSection.test.tsx` per komponen (tiap ≤400 baris). *Selesai:* tes hijau, tidak ada berkas >200 baris komponen.

## c-ENV-04 — Baris, kontrol, badge, requires (W1)

*Berkas:* §a-5. *Perilaku:* `EnvEntryRow` ≤3 baris meta: judul `<label htmlFor>` + kontrol; satu baris kecil deskripsi; baris mono kecil KEY + badge. Tidak ada breadcrumb, tidak ada tombol Simpan per baris, "Default" hanya bila nilai ≠ default (teks `effectiveDefault ?? default` di samping Reset), bantuan Reset jadi `title`. Flag → switch (`role=switch`, `aria-checked`) di sisi kanan sejajar label; enum on/off → switch; enum lain → `<select>` dengan `optionLabels`; number → `inputMode=decimal` dengan `min–max unit` terlihat dan validasi lokal; text path → placeholder; list (`CONTROL_CWD_ROOTS`) → textarea satu-per-baris yang digabung dengan delimiter dari `description` `[BT]` — bila tak yakin, tetap input teks. `EnvBadges`: **Diubah** (nilai ≠ default/efektif, bukan sekadar `source==='override'`), **Perlu restart** (`restart==='boot'` dan nilai efektif ≠ nilai tersimpan, atau `pendingRestart`), **Berbahaya** (+ `dangerNote` via `aria-describedby`), **Dari .env** (`source==='env'`, `title` penjelasan), **Dikunci** (`!editable`); tidak ada badge default. Nilai efektif vs tersimpan: bila beda tampil "Aktif sekarang: X · Tersimpan: Y". `EnvRequiresNote`: dari `evalRequires` — tiap prasyarat tak terpenuhi tampil "Belum berpengaruh: butuh {label kunci} = {nilai}" + tombol "Buka" (`onJump(key)`, scroll+fokus; bila kunci milik Channels, `onJump` memakai pindah tab — dikerjakan ENV-06). Error per baris: Indonesia, `aria-invalid`+`aria-describedby`, dibersihkan saat input berubah. `EnvSecretField`: status Terisi/Kosong (+ "via alias"), simpan/hapus langsung, fokus dipulihkan. Teks semua di `envLabels.ts` (glosarium Indonesia: token, webhook, worker, runtime, ledger tetap). *Tes:* §b-8 ENV-04. *Selesai:* tes hijau, `EnvEntryRow` ≤200 baris.

## c-ENV-05 — Pencarian lintas-section (W1)

*Berkas:* `SettingsPanel.tsx` (bungkus `EnvSettingsProvider query`, lazy fetch), `SettingsFields.tsx` (hanya bila `Field` perlu menerima `keywords` KEY/deskripsi; kompat mundur), `envSearch.ts` (fungsi murni `matchesEntry(entry, query)`: label, KEY, deskripsi, section/grup, case-insensitive). Baris env ber-`data-slot="settings-field"` (disediakan wrapper di ENV-04 lewat prop `data-slot`; ENV-05 menetapkan nama atribut di kontrak: `data-env-key`). Hitungan hasil menjumlah env+Channels. Hasil milik Channels menampilkan "ada di tab Channels" yang bisa diklik. *Tes:* §b-8 ENV-05. *Selesai:* mengetik di pencarian tidak menghapus draft.

## c-ENV-06 — Channels memuat konfigurasi Telegram (W2)

*Berkas:* §a-5. *Perilaku:* `ChannelsTelegramConfig` merender entri `owner:'channels'` memakai `EnvGroupSection`/`EnvEntryRow` yang sama (satu sumber komponen) dari provider; status read-only yang ada tetap. Teks `inactiveHint` memberi petunjuk benar: nyalakan "Telegram" dan isi "Token bot" di bagian ini; `settings-channels.css` hanya memuat kelas Channels. Nyalakan `CHANNELS_OWNS_TELEGRAM`. `onJump` lintas-tab: ke tab Channels lalu fokus kontrol. *Tes:* §b-8 ENV-06; pastikan token tidak pernah dirender. *Selesai:* tidak ada kontrol Telegram ganda di Environment.

## c-ENV-07 — Dokumen & verifikasi akhir (W3, satu worker)

*Berkas:* §a-5. *Perilaku:* README (hanya bagian Settings/Environment: nama tab, alur simpan, lokasi Telegram, perilaku `requires`, tanpa menulis ulang narasi/badge); `CHANGELOG.md` entri `## [x.y.z] - 2026-11-xx` (versi dari manifest): Added (kartu Info server, bar simpan massal, peringatan prasyarat, pencarian lintas-section, tab Channels memuat Telegram), Changed (judul tab, bahasa, badge, default mode Telegram otomatis, restart→hot pada 6 kunci), Fixed (tampilan `ON`, enum di luar opsi, teks Channels); `docs/decisions/env-registry-v2.md` (pola berkas-domain, derivasi, invarian, alasan HIDE=Lanjutan, aturan untuk domain baru). Jalankan tiga gerbang, lampirkan output ringkas. Tidak mengubah kode. *Selesai:* tiap klaim CHANGELOG punya tes pendukung.
