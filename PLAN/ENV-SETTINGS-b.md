# PLAN ENV-SETTINGS (b) — koordinasi lintas-cabang, migrasi, tes, keamanan, rollout, risiko

Lanjutan `ENV-SETTINGS-a.md` (butir 1-3, peta WS). Spec per WS ada di `-c.md`.

## 6. Koordinasi dengan cabang paralel

Fakta (diverifikasi read-only di worktree lain):

| Cabang | Menyentuh registry? | Detail | Dampak ke rencana ini |
|---|---|---|---|
| `feature/ca2` (`ca2-ws19`, WS-19 integrator masih berjalan) | Ya | `envRegistry.ca2.ts` (+23 entri, group `central`/`memory`, flag default `off`), baris compose di `envRegistry.ts`, tes compose di `envRegistry.test.ts` | Konflik langsung pada `envRegistry.ts` dan `envRegistry.test.ts`. Jumlah entri mengikuti snapshot hari ini; bisa berubah. |
| `feature/fm-foundation` (`fm-ws00`) | Ya | `envRegistry.files.ts` (8 entri, group `control`, semua `hot`, helper `filesFlagOn/filesListMax/filesUploadMaxBytes`), `envRegistry.ts` diubah, `envRegistry.files.test.ts` | Konflik pada `envRegistry.ts`; entri `group:'control'` yang bukan milik kontrol. |
| `feature/browser-int` (`br-int`, WS-11 di W4) | Nanti | `shared/browser.contract.ts` (`ENV_BROWSER`, 8 nama `WEBTERM_BROWSER*`); `PLAN/BROWSER-CANVAS-a.md` baris 52,90: WS-11 menambah `browser.envRegistry.ts`, `EnvGroup += 'browser'`, edit `envRegistry.platform.ts`/`types.ts` | Rencana browser mengedit berkas yang akan diubah ENV-00/02. Harus diberi pola baru (di bawah). |
| Klien `Settings*/Env*/Channels*` | Tidak ada cabang yang menyentuh | Aman paralel; hanya `SettingsPanel.tsx` bisa disentuh fitur lain (tab baru) → rebase kecil | — |

**Pola kompatibel (wajib, ditulis ke `docs/decisions/env-registry-v2.md` oleh ENV-07 dan diumumkan ke ca2/fm/browser lewat orkestrator):**
1. Satu domain = satu berkas `envRegistry.<domain>.ts` (≤100 baris) yang mengekspor `ENTRIES: EnvSpec[]` dan `GROUPS: GroupMeta[]`; `envRegistry.ts` memiliki **satu baris compose per domain**, tidak ada logika lain.
2. Tidak boleh mengedit `envRegistry.types.ts`/`envRegistry.platform.ts` atau `ENV_GROUP_*` di klien untuk menambah grup — cukup `GROUPS` di berkas domain (klien membaca grup dari state). Ini menggantikan `EnvGroup += 'browser'` pada rencana WS-11.
3. **Perlakuan flag baru tanpa metadata v2:** diturunkan otomatis: `audience:'advanced'`, `owner` = id domain, `section` = label grup, `requires:[]`, `restart` dari `hot`. Entri itu tetap valid, terlihat di "Lanjutan", dan ikut pencarian. Domain yang ingin tampil di utama harus menyatakan `audience:'user'` eksplisit + `owner`.
4. Flag fitur baru tetap default `off` (aturan generik); `dangerous` wajib `dangerNote`.
5. `group` yang dipakai domain asing (mis. files memakai `control`) boleh sementara; ENV-02 memindahkan `files` ke grup `files` (`owner:'files'`) setelah merge.

**Syarat masuk per WS terhadap cabang lain**

| WS | Syarat masuk | Cara |
|---|---|---|
| ENV-00 | Tidak ada (aditif dari `main`) | Mengubah `envRegistry.types.ts` dan `envSettings.*`. Semua field baru opsional + derivasi → `envRegistry.ca2.ts`/`.files.ts` yang belum diedit tetap lolos compile. Hanya menyentuh `envRegistry.types.ts` dan **tidak** `envRegistry.ts`, sehingga konflik dengan ca2/fm terbatas pada satu berkas tipe; bila ca2/fm ikut mengubah `types.ts` (mereka tidak, terverifikasi) selesaikan lewat rebase. |
| ENV-01 | Tidak ada | Hanya klien. |
| ENV-03/04/05 | ENV-00 selesai + ENV-01 (untuk 04) | Klien murni; bisa berjalan sebelum ca2/fm merge dengan fixture v2. |
| ENV-02 | **Gerbang G1:** ca2 dan fm sudah merge ke `main` dan `feature/env-settings` sudah di-rebase/merge dari `main` | Menghindari tiga pihak mengedit `envRegistry.ts`/`.test.ts` sekaligus. Bila ca2/fm belum merge saat W1 siap: ENV-02 ditahan (jangan diluncurkan), W1 klien jalan terus. |
| ENV-06 | ENV-02, ENV-03, ENV-04 | — |
| browser (WS-11) | Mengikuti pola 6.1-6.4; bila masuk sebelum ENV-02 → ENV-02 hanya menambah metadata; bila sesudah → WS-11 memakai pola langsung | Orkestrator mengirim catatan ke integrator browser. |

Jika ca2/fm tidak kunjung merge (>1 minggu), alternatif: ENV-02 dijalankan di atas `main` untuk 26 entri inti saja, dan ca2/fm menyesuaikan saat rebase (tabel vonis `-c.md` §ENV-02 dibuat per entri sehingga bisa dipotong).

## 7. Migrasi data tersimpan (Rule 4)

Tidak ada perubahan skema SQLite; override tetap satu baris JSON `app.env_overrides` keyed `KEY`. Karena itu **tidak ada file migrasi SQL**; yang ada *migrasi nilai*:

| Kasus | Perlakuan | Tes |
|---|---|---|
| Kunci tersimpan yang vonisnya HIDE/MOVE/Log | Tetap di registry (hanya `audience/owner` berubah) → override tetap dikenali dan berlaku | Invarian `KNOWN_KEYS_FROZEN`: daftar 26 kunci + 10 bootstrap + kunci ca2/files tetap ter-resolve via `specFor` atau `aliasOf` |
| Nilai flag tersimpan `ON`/`On` | Dibaca apa adanya (server `flagOn` sudah toleran); state v2 menormalisasi tampilan ke `on`; **tidak** menulis ulang DB sampai user menyimpan | `envSettings.state.test.ts` |
| Nilai enum tersimpan di luar opsi (mis. `TELEGRAM_MODE='poll'` lama tetap sah; `CHANNELS='ON'`) | Dipertahankan; `valid:false` + `invalidReason`; tombol Reset tersedia | idem |
| Default `TELEGRAM_MODE` berubah `poll`→kosong | Nilai `poll` eksplisit tersimpan tetap sah; yang berubah hanya tampilan default | tes registry diubah dari `toBe('poll')` ke `toBe('')` + `effectiveDefault` terisi |
| Rename kunci di masa depan | `aliases` di spec dipetakan di `parseOverrides` (kunci lama→baru, sekali, dengan log info tanpa nilai) — mekanisme disiapkan, tidak dipakai (P-14) | tes pemetaan alias dengan spec uji lokal `// test-only` |
| Kunci tersimpan yang domainnya belum di-compose (cabang belum merge) | Perilaku lama: dibuang dengan warn. **Catat:** ENV-00 mengubah menjadi *dipertahankan tetapi diabaikan* (`unknownKept`) agar override ca2/files tak hilang saat bergantian build cabang | tes store |

Rollback data: karena tidak ada rewrite, kembali ke build lama aman; nilai yang disimpan oleh UI baru adalah nilai kanonik (`on/off`) yang diterima build lama.

## 8. Rencana test

Runner: `TMPDIR=/tmp/st npm test` (vitest; DOM per-file dengan pragma `/** @vitest-environment jsdom */`), `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts` (glob), `TMPDIR=/tmp/st npm run typecheck`. Tidak ada test kosong; tiap asersi nyata. Tidak menyentuh DB dev/prod; store diuji dengan DB sementara. **Data uji secret hanya string sintetis** (`// test-only`), tidak ada nilai nyata, tidak ada `echo $X`.

| WS | Tes wajib (minimum) |
|---|---|
| ENV-00 | `envRegistry.meta.test.ts`: derivasi (entri tanpa metadata → `audience:'advanced'`, `owner` dari grup, `restart` dari `hot`); `requires` merujuk kunci ada dan tanpa siklus; `GROUP_META` unik. `envSettings.state.test.ts`: flag `ON`→`value:'on'`, `valid:true`; enum asing→`valid:false` + `rawValue`; bootstrap tak masuk `entries`; `server.tokenSet` boolean; secret tak pernah mengandung nilai. Tes store: kunci tak dikenal dipertahankan/diabaikan; alias dipetakan. PUT atomik tetap: satu kunci invalid → tak ada yang tertulis. |
| ENV-01 | `EnvValueControl.test.tsx`: `value='ON'` → switch tercentang; enum `'xyz'` → opsi "tidak sah" terpilih + pesan; `channelsLabels` menyebut `WEBTERM_TELEGRAM_BOT_TOKEN`. |
| ENV-02 | `envRegistry.invariants.test.ts` (lihat 8.1) + tes hasil vonis (nilai per entri pada tabel §c-ENV-02). |
| ENV-03 | Draft bertahan saat pindah section dan saat query pencarian; bar simpan muncul/hilang sesuai dirty; satu PUT berisi semua kunci berubah; Buang mengosongkan draft; konfirmasi dangerous; banner restart dari `pendingRestart` state (hidup lagi setelah unmount). |
| ENV-04 | `evalRequires()` tabel kebenaran (draft menimpa state; kunci tak dikenal→"tidak diketahui", bukan error); badge hanya bila perlu; `aria-invalid/aria-describedby` pada error; fokus kembali ke kontrol setelah simpan; satu kartu dangerous-terkunci. |
| ENV-05 | Mencari `telegram`, `WEBTERM_LEDGER`, deskripsi → baris env muncul & hitungan "N setting ditemukan" benar; hasil entri `owner:'channels'` menunjuk tab Channels. |
| ENV-06 | Channels merender toggle/mode/token/secret dari state registry; teks bantuan benar; token tak pernah tampil. |

**8.1 Invarian registry (ENV-02, berlaku untuk SEMUA domain ter-compose)**
1. Tiap entri: `owner`, `section`, `audience`, `restart` valid (setelah derivasi); `group` ∈ `GROUPS`.
2. Entri di domain bertanda `EXPLICIT_DOMAINS` (core: channels, central, platform; setelah merge: ca2, files; browser menyusul) **wajib menyatakan** `audience` dan `owner` eksplisit (bukan derivasi).
3. `dangerous ⇒ dangerNote` (menggantikan usulan R&D).
4. Tiap `requires.key` ada di registry (atau di `BOOTSTRAP_ONLY_KEYS`); graf tanpa siklus.
5. `audience:'user'` ⇒ `label` ≤ 40 karakter dan `description` ≤ 160 karakter, tanpa backtick Markdown (F12).
6. **Tiap kunci tampil punya pembaca:** tes membaca `src/server/**` (kecuali `*.test.ts`, `envRegistry*`) dan menegaskan literal kunci (atau konstanta bernilai kunci) muncul; daftar `READER_ALLOWLIST` kosong kecuali alasan tertulis.
7. Default valid: enum default ∈ options atau `''` dengan `effectiveDefault`; angka default dalam `[min,max]`.
8. Kunci beku: `KNOWN_KEYS_FROZEN` (lihat §7). Tidak ada kunci di `BOOTSTRAP_ONLY_KEYS` yang juga di `ENV_REGISTRY`.
9. Berkas `envRegistry.*.ts` ≤100 baris (daftar diganti glob, bukan nama hardcode — daftar nama hardcode di tes sekarang basi).

**Gerbang korektness sebelum klaim selesai:** typecheck + vitest + bun-test hijau, dibuktikan dengan output; plus `git diff --stat` cocok dengan klaim worker (memori: laporan worker pernah fiktif).

**Uji manual (butuh manusia, jangan diklaim lulus oleh agen):** (1) buka Settings > "Fitur & server" dengan `.env` berisi `WEBTERM_TELEGRAM=ON`; (2) ubah 3 kunci → satu Simpan → muat ulang; (3) pindah tab saat draft; (4) cari `telegram`; (5) tanpa `WEBTERM_TOKEN`, coba ubah kunci dangerous; (6) lebar 360 px; (7) navigasi keyboard + pembaca layar; (8) restart server dan cek badge "Perlu restart".

## 9. Keamanan & aturan global

- **Rule 7:** secret tetap write-only; state tidak pernah memuat nilai; `server.tokenSet` hanya boolean. Tes dan log tidak mencetak nilai. `invalidReason` tidak menyertakan nilai mentah untuk kind `secret`; untuk non-secret, nilai mentah dipotong ≤40 karakter.
- **Rule 10:** tanpa dependency baru (switch, akordeon, bar simpan dibuat dengan komponen `Settings*` yang ada atau HTML native).
- **Rule 11:** tak ada catch kosong; kegagalan PUT/GET membawa konteks operasi + kunci. **Rule 12:** log baru tanpa nilai env. **Rule 13:** state tidak paginasi (maks ±70 entri, terbatas registry); dicatat sebagai pengecualian wajar.
- **Rule 15:** teks UI di `envLabels.ts`/registry (bukan inline); tidak ada URL/ambang hardcode. **Rule 16:** ENV-07 memperbarui README bagian Settings + `docs/decisions/env-registry-v2.md` + CHANGELOG. **Rule 17:** tak ada TODO tanpa konteks; `ponytail:`/workaround wajib alasan.
- **Rule 8:** komponen ≤200 baris, hook/util ≤200, service ≤300, tes ≤400; `EnvSection.tsx` (76) dan `settings-env.css` (94) tidak boleh melebihi batas — pecah seperti tabel §a-5. Tes lama `EnvSection.test.tsx` (222) dipecah per komponen.
- **Rule 2/3:** semua di branch `feature/env-settings`; tunggu "merge sekarang" user; tes nyata per WS.
- **Identitas:** nama terlihat `webterm`; `NODETERM_*`, header `x-nodeterm-node-token`, `nodeterm:` tidak disentuh.

## 10. Rollout bertahap

| Tahap | Isi | Syarat masuk | Syarat keluar | Rollback |
|---|---|---|---|---|
| S0 | W0: ENV-00 + ENV-01 pada `feature/env-settings` | Plan disetujui user | typecheck+tes hijau; `git diff` cocok; bug `ON`/enum terbukti dengan tes | Buang branch (belum merge) |
| S1 | W1 klien: ENV-03, 04, 05 (fixture v2) | S0 selesai | tes komponen hijau; uji manual 1-4 dilakukan manusia | Revert per-WS (berkas disjoint) |
| G1 | Cek ca2 & fm di `main`; rebase `feature/env-settings` | ca2/fm merge | rebase bersih, tes lama ca2/fm hijau | Tunda ENV-02 |
| S2 | ENV-02: isi registry + invarian | G1 | semua invarian hijau di registry gabungan; `KNOWN_KEYS_FROZEN` hijau | Revert ENV-02 (UI v2 tetap jalan dengan derivasi) |
| S3 | ENV-06: Channels memuat Telegram | S2 + 03/04 | uji manual 5-8; tak ada duplikasi kontrol di Environment | Revert ENV-06; registry `owner:'channels'` tetap tampil di Environment (fallback filter dimatikan satu konstanta `CHANNELS_OWNS_TELEGRAM`) |
| S4 | ENV-07 dokumen + laporan bukti; menunggu "merge sekarang" | S3 | README dan decision doc sinkron | — |

**Tidak boleh diklaim selesai tanpa bukti:** "tampilan benar untuk `ON`" (butuh tes + output), "migrasi tanpa kehilangan nilai" (butuh tes `KNOWN_KEYS_FROZEN` + tes store), "bahasa/a11y baik" (butuh uji manual manusia), "kompat ca2/fm" (butuh tes hijau pada hasil rebase), "layar 360 px aman" (belum diuji; dilarang menjalankan browser di sesi agen).

## 11. Risiko & pertanyaan terbuka

| # | Risiko | Mitigasi |
|---|---|---|
| R1 | Konflik `envRegistry.ts`/`.test.ts` dengan ca2/fm/browser | Gerbang G1; pola berkas-domain (§6); ENV-00 tak menyentuh `envRegistry.ts` |
| R2 | Provider di panel menambah fetch tiap membuka Settings | Fetch ditunda sampai tab Environment/Channels dibuka atau query diketik (lazy); cache selama dialog terbuka |
| R3 | Perubahan kontrak API memecah klien/tes lama | Field v1 dipertahankan; entri bootstrap keluar dari `entries` (satu-satunya perubahan; tes diubah di ENV-00) |
| R4 | Pembaca env sebenarnya berbeda dari tabel vonis (klaim R&D basi di cabang) | ENV-02 wajib `grep` pembaca tiap kunci dan mengikuti kode; selisih dicatat di laporan |
| R5 | `requires` salah (menuduh fitur tak jalan padahal jalan) | Peringatan lunak, kata "mungkin"; ditandai `[BT]` per kunci di spec; tes tabel kebenaran |
| R6 | Pindah Telegram ke Channels membuat pencarian/menu membingungkan | Hasil pencarian menunjuk tab; kartu singkat di Environment "Dikonfigurasi di Channels" |
| R7 | Worker melaporkan selesai tanpa mengubah berkas | Orkestrator cek `git diff --stat` per WS |
| R8 | ca2 memperbesar entri `central` jadi 30+ | `audience:'advanced'` default + akordeon; invarian #2 memaksa keputusan eksplisit |
| Q1 | Apakah `WEBTERM_OPENCODE_ALLOW_TOOLS` seharusnya bootstrap-only? | Terbuka (P-2), butuh keputusan keamanan user; default tetap dangerous |
| Q2 | Apakah Log sebaiknya ke panel Output? | Terbuka (P-4); default tidak |
| Q3 | Perlu tombol "Restart server"? | Di luar lingkup; server tak punya endpoint |
