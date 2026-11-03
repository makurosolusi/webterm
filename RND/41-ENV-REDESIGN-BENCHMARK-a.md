# 41-a — Redesain Settings > Environment: benchmark + kondisi sekarang

Topik 3 R&D env (wkr-env-rnd-03-design). Basis: worktree `rnd-env` (= `main` @ fdaf2b4) + pembanding `webterm-wt/ca2-int`. Tanpa kode produksi.
Label: `[BT]` = belum terverifikasi, `[opini]` = penilaian saya. **WebSearch/WebFetch gagal di sesi ini (API error 400)** — seluruh klaim benchmark produk (bagian 2) berasal dari pengetahuan model, bukan dokumen yang dibuka ulang, jadi semuanya `[BT]`. Klaim tentang kode webterm terverifikasi dengan `file:baris`.

## 1. Kondisi sekarang (bukti kode)

| # | Fakta | Bukti |
|---|---|---|
| F1 | Registry = 29 entri (6 channels, 11 central, 12 platform) + 10 kunci bootstrap read-only; di `ca2-int` +17 entri (`envRegistry.ca2.ts`) → 46 + 10. Pembaca env nyata di `src/` lebih banyak lagi (mis. `WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE`, `NODETERM_PERM_WAIT_SECS`) tak terdaftar. | `envRegistry.{channels,central,platform}.ts`; `ca2-int/.../envRegistry.ts:8` |
| F2 | Satu-satunya metadata: `group`, `kind`, `restartRequired`, `dangerous`. Tak ada `audience`, `requires`, `owner`, `since`, `experimental`. | `envRegistry.types.ts:7-28` |
| F3 | `EnvGroup` adalah union tertutup di file tipe; tiap domain baru wajib mengedit `envRegistry.types.ts` DAN `ENV_GROUP_ORDER`/`ENV_GROUP_LABEL` di klien (dua sumber yang harus sinkron; grup tak dikenal tampil sebagai kunci mentah). | `types.ts:5`; `envLabels.ts:39-51`; `EnvSection.tsx:63` |
| F4 | Dependensi hanya ada di teks deskripsi ("butuh ledger hidup", "butuh Central aktif", "butuh tools=write"); tak ada di data → UI tak bisa menonaktifkan/menjelaskan. | `channels.ts:18`; `central.ts:8,15`; `ca2.ts:14,29` |
| F5 | Semua entri datar satu halaman, 1 grup = 1 entri untuk `ledger` dan `channels`. Judul "Environment" tak dirender komponen (`ENV.title` tak dipakai); toolbar hanya tombol Segarkan. | `EnvSection.tsx:50-54`; grep `ENV.title` = 0 pemakai |
| F6 | Breadcrumb `Webterm › Grup:` diulang tiap baris, padahal sudah ada `<h3>` grup. | `EnvEntryRow.tsx:47`; `EnvSection.tsx:34` |
| F7 | Simpan per baris; hanya `flag` = checkbox, `WEBTERM_CHANNELS` bertipe `enum on/off` (dropdown) padahal semantik saklar (default on). | `EnvEntryRow.tsx:58`; `EnvValueControl.tsx:19-29`; `channels.ts:14` |
| F8 | Pencarian Settings tak menjangkau Environment (komponen mengembalikan `null` saat ada query). | `EnvSection.tsx:15` |
| F9 | "Default" di UI = `spec.default`, bukan nilai efektif. `WEBTERM_TELEGRAM_MODE` default registry `poll`, padahal kode: kosong → `poll` HANYA bila ada token, selain itu `webhook`. | `service.ts:134`; `channels.ts:19-22`; `telegramMode.ts:14-23` |
| F10 | `restartRequired` default true kecuali `hot`; token bot dibaca ulang tiap kirim (rotasi tanpa restart) tapi ditandai restart. Ingress poll dipilih saat boot (`index.ts:52`). Jadi satu kunci punya dua perilaku. | `types.ts:24,39`; `telegramSend.ts:2-4` |
| F11 | Duplikat/kontradiksi dengan tab Channels: tab itu bilang isi `TELEGRAM_BOT_TOKEN` "di environment server" (nama legacy), padahal token bisa diisi dari Environment. Tab Channels read-only status; Environment yang menyimpan konfigurasinya. | `channelsLabels.ts:8-9`; `ChannelsSection.tsx:35-50` |
| F12 | Deskripsi memakai backtick Markdown tapi dirender teks polos → backtick literal tampil. | `channels.ts:12,16`; `EnvEntryRow.tsx:51` |
| F13 | Fondasi yang BAGUS dan harus dipertahankan: PUT atomik multi-kunci, validasi per `kind`, secret di file 0600 bukan DB, overlay `process.env` + `base` snapshot (reset = nilai asli), gerbang `dangerous`+root token, lock `WEBTERM_ENV_SETTINGS=off`, override disimpan satu baris JSON `app.env_overrides` keyed `KEY`. | `service.ts:1-8,151-215`; `store.ts:1-8`; `secrets.store.ts:1-3` |

Akar masalah [opini]: **registry diperlakukan sebagai daftar "semua yang bisa diubah", bukan "yang perlu diubah operator di UI"**, dan UI hanya punya satu dimensi pengelompokan (group). Semuanya (flag uji, infrastruktur, fitur per-tab, rahasia) menumpuk di satu halaman tanpa tahu siapa pemiliknya.

## 2. Benchmark (semua `[BT]`, dari pengetahuan model)

| Produk | Pola relevan | Pelajaran untuk webterm |
|---|---|---|
| **VS Code Settings** | Setting punya `scope` (application/machine/window/resource/language-overridable/machine-overridable), `tags` (`experimental`, `preview`, `advanced`, `usesOnlineServices`), `order`, `markdownDescription`, `enumDescriptions`, `deprecationMessage`; pengelompokan lewat tree kategori (TOC) dari ID setting; pencarian tunggal menjangkau semua; indikator "modified" (garis biru) + "Reset"; auto-save per perubahan; `@modified`, `@tag:advanced` filter. Setting `advanced` tak disembunyikan, hanya ter-tag. | Ambil: metadata `scope/tags/order`, deskripsi markdown, enumDescriptions, auto-save, modified indicator, pencarian lintas section. Jangan: satu TOC raksasa. |
| **JetBrains IDE** | Settings dialog dengan pohon + pencarian; **Advanced Settings** (halaman khusus untuk opsi jarang dipakai, searchable, "Reset") dan **Registry** (flag internal, hanya lewat Help › Find Action, dengan peringatan "jangan ubah kecuali diminta support"). | Tiga lapis eksplisit: user → advanced (halaman/accordion terpisah) → internal (tidak di UI). Cocok dengan `audience`. |
| **Grafana** | Konfigurasi server = `grafana.ini` + env `GF_<SECTION>_<KEY>` (env menang), **tidak diedit dari UI**; `__FILE` untuk secret; feature toggle bertahap (experimental/preview/GA) dan hanya lewat config; halaman Admin › Settings = read-only tampilan konfigurasi efektif. | Konfigurasi infrastruktur lebih jujur read-only + "sumber nilai"; `stage` pada flag. Dukung `*_FILE` untuk secret. |
| **Portainer** | Env var stack/container: mode "Simple" (baris key/value) vs "Advanced" (paste teks `.env`); dukung "Load variables from .env file". | Mode ganda (form vs teks) berguna untuk edit massal; bukan prioritas. |
| **Home Assistant** | Integrasi punya konfigurasi lewat UI (config flow) per integrasi, bukan halaman env global; opsi lanjutan baru muncul saat "Advanced mode" profil aktif; YAML untuk sisanya; entri butuh restart ditandai tombol "Restart" di banner. | **Konfigurasi tinggal di tempat fitur-nya** (owner tab), bukan halaman "semua variabel". Toggle "Mode lanjutan" global. Banner restart dengan aksi. |
| **Coolify** | Env var per aplikasi: "Normal view" (baris + toggle Build/Runtime, ikon kunci untuk secret yang disembunyikan) vs "Developer view" (teks `KEY=value`); shared variables; preview terpisah. | Secret disembunyikan default + toggle; view teks hanya untuk power user. |
| **Supabase** | Dashboard memisahkan *Project Settings › API/Auth* (form per fitur, toggle + simpan per kartu) dari *Vault/Secrets* (nilai write-once, tak terbaca ulang). | Form per fitur dengan toggle di kepala kartu; secret terpisah dan write-only (sudah ada di webterm). |

Kesimpulan benchmark [opini]: tak satu pun produk matang menaruh **semua** env var di satu halaman "Environment" dengan tombol Simpan per baris. Pola dominan: (a) konfigurasi di dekat fiturnya, (b) tiga tingkat visibilitas, (c) infrastruktur = file/env + tampilan read-only efektif, (d) satu tombol simpan atau auto-save, (e) satu pencarian.

## 3. Apa yang layak di UI vs tetap di `.env`

Kriteria tiap kunci (jawab berurutan, berhenti di jawaban pertama "ya"):

| Pertanyaan | Ya → tempatnya |
|---|---|
| Dibaca sebelum DB/overlay tersedia (bootstrap), atau jika diubah via API membuka eskalasi dari shell agent (token, host, allow-*, API_BASE)? | **Hanya env** (`BOOTSTRAP_ONLY_KEYS`). Tampil read-only di "Info server", bukan di daftar editor. |
| Hanya untuk tes/diagnosis/migrasi sementara, atau tak punya pembaca? | **Internal**: tak di UI; dokumentasi/`.env.example`. |
| Operator awam wajar menyentuhnya (hidup/mati fitur, mode, kredensial, batas)? | **User**, di tab pemilik fiturnya. |
| Jarang disentuh, tapi sah (path, biner, angka batas, debug)? | **Advanced**, tersembunyi sampai "Tampilkan lanjutan"/filter. |
| Berbahaya (menjalankan proses nyata, memperluas akses)? | Tetap `dangerous` (root token) + konfirmasi; audience biasanya advanced. |

Untuk webterm: `HOST/PORT/DATA_DIR/TOKEN/ALLOW_*/STRICT_HOOK_AUTH/TELEGRAM_API_BASE/ENV_SETTINGS` sudah benar bootstrap-only. Sisanya diputuskan per entri oleh topik-1 (`39-ENV-REGISTRY-AUDIT.md`); dokumen ini hanya menetapkan model agar vonis itu bisa dinyatakan sebagai data.


> Lanjut: bagian 4-9 (model data, UI, invarian, migrasi, WS-ENV-nn, implikasi) di `41-ENV-REDESIGN-BENCHMARK-b.md`.
