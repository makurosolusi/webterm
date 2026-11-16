# PLAN ENV-SETTINGS (a) — tujuan, verifikasi klaim R&D, keputusan produk, arsitektur, peta WS

Seri: `a` (ini: butir 1-4 + peta WS) · `b` (koordinasi cabang, tes, keamanan, rollout, risiko) · `c` (spec siap-tempel WS-ENV-00..07).
Sumber: `RND/39..41`. Branch kerja rencana: `chore/rnd-env-settings` (worktree `webterm-wt/rnd-env`, basis `main` @ fdaf2b4). Semua kutipan `file:baris` diverifikasi ke kode worktree ini.

## 1. Tujuan, non-tujuan, keputusan arsitektur

**Keluhan user:** Settings > Environment kacau, tidak sesuai, sebagian tak seharusnya di situ / tak dibutuhkan / membingungkan, pilihan tak cocok dengan project.

**Tujuan**
1. Halaman hanya berisi yang layak disentuh operator, dikelompokkan menurut pemilik fitur, dengan tiga tingkat: Fitur (tampil), Lanjutan (terlipat), Info server (read-only, bukan "setting").
2. Tampilan selalu benar: nilai `.env` nonkanonik (`ON`, enum di luar opsi) tidak lagi tampil salah; default menggambarkan perilaku nyata.
3. Satu model simpan (draft terpusat, simpan massal atomik) dan satu bahasa (Indonesia, istilah teknis tetap Inggris).
4. Hubungan antar-flag hidup (`requires`) sehingga "kenapa fitur tak jalan" terjawab di UI.
5. Registry menjadi data berskema v2 + tes invarian, sehingga domain baru (ca2, file manager, browser) tak bisa mengotori halaman lagi.

**Non-tujuan:** tidak mengubah mekanisme inti (override > env > default, secret file 0600, gerbang `dangerous`+root token, `WEBTERM_ENV_SETTINGS=off`, satu baris JSON `app.env_overrides`); tidak ada tabel/skema DB baru; tidak ada dependency baru; tidak rename kunci env mana pun (kompat protokol nodeterm, CLAUDE.md); tidak membuat endpoint restart; tidak mengubah semantik pembaca env di luar registry.

**Keputusan arsitektur (satu rekomendasi):** registry v2 = *data murni berskema* (`owner/section/audience/requires/restart/effectiveDefault/stage/since/aliases/dangerNote`) dengan **derivasi default** agar entri lama dan entri domain lain tetap valid tanpa diedit; server menormalisasi dan memvalidasi nilai efektif (field `valid`); klien hanya me-render data itu (tanpa daftar grup/urutan hardcode).
- *Ditolak 1:* UI per-fitur ditulis tangan tanpa registry — duplikasi, drift (terbukti di `channelsLabels.ts`).
- *Ditolak 2:* autosave seperti tab lain — toggle `dangerous` (otonomi central, run worker nyata) tak boleh menyala tanpa konfirmasi/batch.
- *Ditolak 3:* menghapus entri HIDE dari registry — override tersimpan akan terbuang oleh `parseOverrides` (`envSettings.store.ts`); data operator hilang.

## 2. Verifikasi klaim kunci R&D ke kode (hasil)

| Klaim R&D | Bukti kode | Hasil |
|---|---|---|
| Server membaca flag case-insensitive, klien tidak (bug `ON`) | `envFlag.ts:5` `(raw ?? '').trim().toLowerCase() === 'on'`; `EnvValueControl.tsx:21` `checked={value === ENV.on}`; nilai env dikirim apa adanya `envSettings.service.ts:134` | **Benar.** `WEBTERM_X=ON` aktif di server tapi kotak kosong. Menyimpan dari baris itu menimpa dengan `off`. |
| Enum dengan nilai di luar opsi tampil salah | `EnvValueControl.tsx:27` `<select value>` tanpa opsi cocok; `validate.ts` hanya dipanggil saat PUT | **Benar** (P0). Tampilan jatuh ke opsi pertama. |
| Default `WEBTERM_TELEGRAM_MODE` = `poll` keliru | `envRegistry.channels.ts:19-22` default `poll`; `telegramMode.ts:14-24`: eksplisit `poll`/`webhook` dihormati, kosong/tak dikenal → `poll` **bila ada token**, selain itu `webhook` | **Benar.** Default efektif bersyarat. Tes `envRegistry.test.ts:26` mengunci `'poll'` dan harus diubah. |
| `WEBTERM_CHANNELS` dropdown on/off, bukan saklar | `envRegistry.channels.ts:14` `enumOf(['on','off'],'on')`; `channelsMasterGate.ts:17-22` ada status ketiga `unsupported` | **Benar, dengan nuansa:** tetap bertipe enum di server (nilai asing → `unsupported`, ditolak validator), tapi klien merender switch bila `options` = `{on,off}`; nilai asing tampil sebagai "tidak sah". Tidak diubah jadi `flag` (default-nya `on`, flag berdefault `off`). |
| Restart-vs-hot salah pada 6 kunci | `types.ts base()` → `restartRequired: !m.hot`; pembaca per-call/per-turn: `opencodeOptions.ts:55,60,65`, `orchestratorRunModel.ts:41`, `webhookPeer.ts:21-23`, `telegramSend.ts:18-25` | **Benar.** Kunci E05, E11, E16, E17, E19, E23 dibaca per-pakai tetapi bertanda restart (E05 ganda: kirim hot, poll boot-time). |
| Vonis 11 KEEP / 6 MOVE Channels / 3 MOVE Log / 5 HIDE / 1 FIX | doc 39 §ringkasan; cocok dengan 26 entri (6+11+9) | **Benar (26 entri).** *Koreksi:* doc 41 F1 menulis 29 entri; yang benar 26 (`channels` 6, `central` 11, `platform` 9). |
| Dangerous terkunci tanpa token | `envSettings.runtime.ts` rootGate = `WEBTERM_TOKEN` terisi | **Benar.** Keputusan keamanan, bukan bug; UI hanya menjelaskan lebih baik (satu kartu, bukan 7 baris). |
| Channels memberi nama var salah | `channelsLabels.ts:8-9` menyebut `TELEGRAM_BOT_TOKEN`; `telegramSend.ts:15-17` preferensi `WEBTERM_TELEGRAM_BOT_TOKEN`, alias lama sekunder | **Benar** (P0 teks). |
| Invarian R&D "dangerous ⇒ audience≠user" | KEEP E15 `AUTONOMY` & E18 `ORCHESTRATOR_RUN` adalah dangerous tapi fitur inti | **Ditolak/diganti:** invarian jadi "dangerous ⇒ wajib `dangerNote`" (tanpa batasan audience). |
| "HIDE" = sembunyikan dari UI | override tersimpan harus tetap terlihat & berlaku | **Diterjemahkan** jadi `audience:'advanced'` (terlipat, tetap bisa diubah/di-reset), bukan hapus/internal. |

## 3. Keputusan produk (default tegas; user boleh membalik)

| ID | Keputusan (DEFAULT) | Alasan | Alternatif |
|---|---|---|---|
| **P-1** | 10 kunci bootstrap keluar dari daftar editor; diganti **kartu "Info server"** read-only (token root terisi/kosong, pengaturan terkunci/tidak, tanpa nilai rahasia). HOST/PORT/DATA_DIR tidak ditampilkan. | Baris tanpa nilai/aksi = kebisingan (P0-3). | Tetap tampil terlipat (ditolak). |
| **P-2** | Vonis HIDE (E16, E17, E21, E22, E23) = **Lanjutan** (terlipat, tetap bisa diubah, tetap `dangerous` bila ada), bukan dihapus/bootstrap-only. `OPENCODE_ALLOW_TOOLS` tetap dangerous+Lanjutan dengan `dangerNote`; usulan R&D menjadikannya bootstrap-only **tidak** dilakukan di cabang ini (perubahan keamanan terpisah, perlu keputusan user). | Aman bagi data tersimpan; tidak mengubah postur keamanan diam-diam. | Bootstrap-only (tunda). |
| **P-3** | Konfigurasi Telegram (E02 `CHANNELS`, E03 `TELEGRAM`, E04 mode, E05 token, E06 webhook secret, E09 `CENTRAL_TELEGRAM`) **pindah ke tab Channels**, hilang dari Environment. Pencarian tetap menemukannya (hasil menunjuk tab Channels). | Satu tempat per topik; Channels sekarang hanya status read-only. | Tetap di Environment + tautan (ditolak: dua tempat). |
| **P-4** | Log (E24-E26) = grup **"Log"** sendiri di Environment, Lanjutan; **tidak** dipindah ke panel Output (kontrol di sana belum diverifikasi dan menambah WS lintas-area). Pemilik data: `owner:'logs'`, siap dipindah kemudian. | Hindari lingkup baru. | Pindah ke Output (tunda). |
| **P-5** | Judul tab "Environment" → **"Fitur & server"**; istilah env var tetap muncul sebagai nama kunci kecil (mono) di tiap baris. | User mencari "fitur apa yang bisa kunyalakan". | Tetap "Environment". |
| **P-6** | Simpan **massal**: draft terpusat + bar sticky "N perubahan · Simpan · Buang"; satu PUT atomik; tidak ada autosave; kunci `dangerous` diubah → satu konfirmasi ringkas sebelum PUT. Secret tetap field sendiri (simpan/hapus langsung). | Server sudah atomik; menghindari efek setengah-jadi. | Autosave (ditolak). |
| **P-7** | `requires` ditampilkan sebagai **peringatan inline** "Belum berpengaruh: butuh X = on" + tombol "Buka X" — tidak men-disable kontrol. | Prasyarat bisa dipenuhi dari `.env`; disable memaksa urutan edit. | Disable (ditolak). |
| **P-8** | `WEBTERM_TELEGRAM_MODE` default registry jadi **kosong = otomatis** (poll bila ada token, selain itu webhook), ditampilkan lewat `effectiveDefault`; opsi enum `poll`/`webhook`. Nilai `poll` tersimpan tetap valid. | Sesuai `telegramMode.ts`. | Pertahankan `poll` (salah). |
| **P-9** | Semantik restart tiga nilai: `restart: 'none'` (langsung), `'hot'` (berlaku pada pemakaian berikutnya), `'boot'` (perlu restart). Badge "Perlu restart" **hanya** `boot`. | Hari ini 20/27 bertanda restart (tak informatif). | Dua nilai (ditolak). |
| **P-10** | Pencarian Settings menjangkau Environment: state env diangkat ke provider di `SettingsPanel` (fetch sekali saat dialog dibuka), baris env ikut `data-slot="settings-field"` dan cocok pada label/KEY/deskripsi/grup. | Tanpa indeks statis ganda; draft selamat saat mengetik di pencarian. | Indeks statis (duplikasi). |
| **P-11** | Bahasa UI Indonesia; istilah teknis (token, webhook, worker, runtime, ledger) tetap. Badge: **Diubah · Perlu restart · Berbahaya · Dari .env · Dikunci**; badge "default" dihapus. | R&D 40 §9. | — |
| **P-12** | Central tetap **section** di tab "Fitur & server" (tanpa tab baru); entri domain tanpa metadata (ca2/files/browser) otomatis `audience:'advanced'`, `owner` = domain. | Cegah banjir 23+ entri di tampilan utama. | Tab Central (tunda). |
| **P-13** | Kunci `dangerous` tanpa root token: tampil **satu** kartu penjelasan ("butuh `WEBTERM_TOKEN`; tanpa token kunci ini tidak bisa diubah dari UI") + baris read-only, bukan pesan di tiap baris. | R&D E3. | — |
| **P-14** | Tidak ada rename kunci di cabang ini; `aliases` hanya disiapkan (mekanisme migrasi override) untuk rename masa depan. | CLAUDE.md: jangan rename tanpa perintah. | — |

## 4. Arsitektur target (ringkas)

**Registry v2 (server).** `EnvSpec` ditambah field opsional (semua turunan bila kosong, sehingga builder lama `flag/enumOf/text/secret/num` tak berubah):
`owner` (`'channels'|'central'|'logs'|'platform'|string`; default dari `GROUP_META[group].owner`), `section` (judul akordeon; default label grup), `audience` (`'user'|'advanced'`; default: `user` bila domain terdaftar eksplisit, selain itu `advanced`), `requires` (`{key, oneOf?: string[], note?: string}[]`; default `[]`), `restart` (`'none'|'hot'|'boot'`; default dari `hot?` lama: `hot→'hot'`, selain itu `'boot'`), `effectiveDefault?: string`, `stage?: 'experimental'|'preview'|'stable'`, `since?: string`, `aliases?: string[]`, `dangerNote?: string`. `EnvGroup` dilonggarkan menjadi `string`; `GROUP_META` (`{id,label,order,owner}`) dikirim server di state sehingga klien tak menyimpan daftar grup. Tiap domain = satu file `envRegistry.<domain>.ts` (≤100 baris) yang mengekspor `ENTRIES` dan `GROUPS`; `envRegistry.ts` hanya me-compose (satu baris per domain).

**State API v2 (kontrak di W0, file `src/shared/envSettings.contract.ts`).** `GET /api/settings/env` → `{ locked, rootGate, server: {tokenSet, settingsLocked}, groups: GroupMeta[], entries: EntryV2[] }`. `EntryV2` = field v1 (`key,kind,value,source,restartRequired,pendingRestart,dangerous,editable,...`) **+** `label,description,owner,section,audience,requires,restart,effectiveDefault,effective,valid,invalidReason,min,max,unit,options,optionLabels,allowEmpty,absolutePath,dangerNote,stage`. Entri bootstrap tidak lagi masuk `entries`. `value` = nilai yang dinormalisasi (flag → `on|off`; enum di luar opsi → `valid:false` dengan `rawValue`, tanpa pura-pura); `effective` = nilai yang benar-benar dibaca server saat ini. PUT tetap atomik multi-kunci, kompatibel mundur.

**Klien.** `EnvSettingsProvider` (di `SettingsPanel`) menyimpan state server + draft (`Map<key,string>`) + dirty set; `EnvSection` = header/pencarian/filter cepat + akordeon section + kartu Info server + bar simpan; `EnvEntryRow` ramping (label, kontrol, ≤3 baris meta); `evalRequires()` fungsi murni; semua teks dari `envLabels.ts` (glosarium).

## 5. Peta workstream, gelombang, kepemilikan file

Worker diluncurkan sebagai sesi/tab bernama unik `wkr-env-<nn>-<domain>` (Rule 23); dilarang commit/push/ganti branch; orkestrator yang commit. Basis semua WS: branch integrasi `feature/env-settings` dari `main`.

| WS | Nama | Gel. | Tujuan | File dimiliki eksklusif (baru=N, ubah=U) | Ukuran | Dep. |
|---|---|---|---|---|---|---|
| ENV-00 | Kontrak & model registry v2 | W0 | Skema v2 + derivasi, normalisasi/validasi `valid`, state v2, `aliases` di store, kontrak bersama, tipe klien | `src/shared/envSettings.contract.ts` N; `src/server/envRegistry.types.ts` U; `envRegistry.meta.ts` N; `envRegistry.groups.ts` N; `envSettings.service.ts` U; `envSettings.state.ts` N; `envSettings.store.ts` U; `envSettings.validate.ts` U; `envSettings.api.ts` U; `src/client/envSettingsApi.ts` U; `src/client/EnvSection.test.tsx` U (minimal, W0 saja) + tes `envRegistry.meta.test.ts`, `envSettings.state.test.ts` N | M | — |
| ENV-01 | Hotfix kebenaran tampilan + teks Channels | W0 | Bug `ON`/enum asing; `inactiveHint` | `src/client/EnvValueControl.tsx` U; `src/client/EnvValueControl.test.tsx` N; `src/client/channelsLabels.ts` U | S | — |
| ENV-02 | Isi registry (vonis per entri) + invarian | W1 | Terapkan tabel vonis 26 entri + metadata ca2/files; tes invarian | `envRegistry.ts` U (satu-satunya pengompos + `BOOTSTRAP_ONLY_KEYS`); `envRegistry.channels.ts`, `.central.ts`, `.platform.ts` U; `envRegistry.ca2.ts`, `envRegistry.files.ts` U (metadata saja, setelah merge ke main); `envRegistry.test.ts` U; `envRegistry.invariants.test.ts` N | M | ENV-00, gerbang G1 (ca2 & fm di main) |
| ENV-03 | UI: struktur, simpan massal, provider | W1 | Provider+draft, bar simpan, akordeon/Lanjutan/filter, kartu Info server, banner restart | `EnvSection.tsx` U (pecah → `EnvGroupSection.tsx` N, `EnvSaveBar.tsx` N, `EnvServerCard.tsx` N, `EnvRestartBanner.tsx` N); `useEnvSettings.ts` U; `envDraft.ts` N; `settings-env.css` U; `EnvSection.test.tsx` U + tes baru per komponen | L | ENV-00 |
| ENV-04 | UI: baris, kontrol, badge, requires | W1 | Baris ramping, switch, badge, nilai efektif vs default, `requires` interaktif, a11y, error ID | `EnvEntryRow.tsx` U; `EnvValueControl.tsx` U (pasca ENV-01); `EnvSecretField.tsx` U; `EnvBadges.tsx` N; `EnvRequiresNote.tsx` N; `envRequires.ts` N; `envLabels.ts` U + tes `envRequires.test.ts`, `EnvEntryRow.test.tsx` N | L | ENV-00, ENV-01 |
| ENV-05 | Pencarian lintas-section | W1 | Provider di panel, filter `settings-field`, hitungan hasil, hasil menunjuk tab pemilik | `SettingsPanel.tsx` U; `SettingsFields.tsx` U; `envSearch.ts` N + `SettingsPanel` tes terkait | M | ENV-00 (pakai provider ENV-03 via kontrak) |
| ENV-06 | Channels memuat konfigurasi Telegram | W2 | Pindah E02-E06/E09 ke tab Channels, teks, tautan | `ChannelsSection.tsx` U; `ChannelsTelegramConfig.tsx` N; `channelsLabels.ts` U (pasca ENV-01); `settings-channels.css` U + tes | M | ENV-02, ENV-03, ENV-04 |
| ENV-07 | Dokumen & verifikasi akhir | W3 | README (bagian setup/kontrak), CHANGELOG, `.env.example` bila ada; laporan bukti | `README.md` (bagian Settings), `CHANGELOG.md`, `docs/decisions/env-registry-v2.md` N | S | semua |

Aturan kepemilikan: titik panas `envRegistry*.ts` hanya ENV-00 (tipe) dan ENV-02 (isi/compose); `EnvSection*/Env*/settings-env.css` dimiliki ENV-03/04 sesuai tabel (tidak ada berkas dimiliki dua WS dalam satu gelombang; `EnvValueControl.tsx` dan `channelsLabels.ts` berpindah pemilik antargelombang secara berurutan: ENV-01 → ENV-04/ENV-06). `SettingsPanel.tsx` hanya ENV-05; ENV-03 mengekspor provider dari berkasnya sendiri dan ENV-05 mengimpornya (tanda tangan di kontrak §c-0). Gelombang berurutan di dalam W1 untuk berkas bentrok: tidak ada — pembagian di atas disjoint.

Lanjut: `ENV-SETTINGS-b.md` (koordinasi cabang, tes, keamanan, rollout, risiko) dan `ENV-SETTINGS-c.md` (spec per WS).
