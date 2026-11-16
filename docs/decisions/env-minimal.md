# Env minimal: keputusan desain (L1-L15, U1-U6)

Sumber lengkap: `PLAN/ENV-MINIMAL-a.md` (keputusan, peta workstream), `-b.md` (kontrak teknis, token), `-b2.md` (matriks tes, risiko, rollback), `-c.md` dan `-c2.md` (spek per workstream). Dokumen ini merangkum keputusan akhir dan alasannya. Tujuan program: `.env` opsional total; hanya 9 kunci bootstrap yang wajib berasal dari environment, sisanya diatur di Settings > Environment.

## Keputusan terkunci (L1-L15)

| ID | Keputusan | Alasan |
|----|-----------|--------|
| L1 | Set bootstrap yang didokumentasikan = 8 kunci: `HOST PORT WEBTERM_DATA_DIR WEBTERM_TOKEN WEBTERM_ENV_SETTINGS WEBTERM_ALLOW_TOKEN_MINT WEBTERM_STRICT_HOOK_AUTH WEBTERM_ALLOWED_HOSTS` (`WEBTERM_ALLOW_LOOPBACK_APPROVAL` dihapus: persetujuan kini UI-origin, lihat `approval-ui-origin.md`). Kunci lain tidak boleh ada di `.env.example`. | Kunci ini dibaca sebelum DB/Settings ada, jadi hanya bisa lewat env. |
| L2 | Presedensi Settings tersimpan > env > default tetap. Entri env membawa `envShadowed` bila override menyembunyikan nilai env yang berbeda. | Mengubah urutan memutus override yang sudah tersimpan; yang dibutuhkan hanya transparansi. |
| L3 | Token: non-loopback tanpa token membangkitkan token (43 karakter base64url) di `<data dir>/secrets/WEBTERM_TOKEN` (0600), bukan crash. Loopback tetap terbuka sampai opt-in. Env menang atas berkas. Path dicetak; URL ber-token hanya di TTY. | Crash memaksa user mengedit `.env` sebelum bisa mulai; token selalu aktif memutus `curl localhost`, skrip, dan tes. |
| L4 | Allowlist header Host: bind efektif, `localhost`, `127.0.0.1`, `[::1]`, dan `WEBTERM_ALLOWED_HOSTS`; selain itu 403 `host_not_allowed`. Aktif hanya selama tidak ada token yang ditegakkan (U2). | Menutup DNS-rebinding pada mode terbuka. Dengan token, token sudah menjadi penjaga. Superseded (2026-11-06): removed with the always-on token, see `ui-session-cookie.md`. |
| L5 | Penyimpan secret = berkas 0600 (`envSecrets.store.ts`). | `Bun.secrets` dan SQLite terenkripsi ditolak: kunci tetap harus disimpan di suatu tempat. |
| L6 | Impor `.env` eksplisit (`POST /api/settings/env/import`, dry run default, `{"apply":true}` menulis); tidak pernah otomatis; `.env` user tidak diubah; kunci bootstrap dilewati; kunci `dangerous` butuh root gate. | Impor otomatis melewati gerbang `dangerous`. |
| L7 | Autoload dotenv untuk binary DITUNDA (K3, rilis mayor). `build:binary` mematikan autoload `bunfig.toml` sekarang; tes Bun memakai `--no-env-file` (`npm run test:bun`). | Perubahan autoload binary menyentuh semua pemasang; mematikan bunfig murah dan reversibel. |
| L8 | `ptyEnv` menyapu `TELEGRAM_BOT_TOKEN` dan kunci yang nilainya identik dengan `.env` di cwd boot (provenance). Kunci provider tidak disapu. | Shell dan agent tidak perlu mewarisi rahasia yang hanya dipakai server. |
| L9 | 4 kunci mati dihapus dari registry (`WEBTERM_CENTRAL_TOOL_BRIDGE`, `WEBTERM_KNOWLEDGE_GRAPHIFY`, `WEBTERM_EMBED_URL`, `WEBTERM_EMBED_MODEL`) dan masuk `RETIRED_KEYS`; hantu `WEBTERM_CHANNEL_HMAC_SECRET` dihapus dari redaksi. Alias `TELEGRAM_BOT_TOKEN`: warn sekali di rilis ini, dihapus di rilis sesudah 0.7.0. | Kunci tanpa pembaca menyesatkan; override lama tetap tersimpan di blob sehingga rollback aman. |
| L10 | Dialek flag non-keamanan: `on\|1\|true` / `off\|0\|false`. `WEBTERM_X=1` kini on (dulu senyap off), termasuk `WEBTERM_TRUST_PROXY`. Tiga kunci keamanan tetap persis `1`. UI tetap menulis `on`/`off`. | Satu dialek menghapus jebakan; kunci keamanan sengaja ketat agar salah ketik tidak membuka akses. |
| L11 | Keputusan produk user: `WEBTERM_FILES_VIEWERS/WATCH/GIT_STATUS/QUICK_OPEN` default on (baca-saja). `MUTATE` dan `UPLOAD` tetap off. Env atau override eksplisit tetap menang. | Fitur berkas terlihat tanpa konfigurasi; yang menulis tetap opt-in. |
| L12 | `VITE_WEBTERM_CENTRAL_CHAT` diganti state server `WEBTERM_CENTRAL_CHAT`; state belum termuat = off. | Panel tidak lagi bergantung pada flag build. |
| L13 | Data dir 0700, `webterm.db` dan log 0600; instalasi lama di-`chmod` hanya bila dimiliki uid proses. | uid lain dan backup ceroboh tidak lagi bisa membaca DB. |
| L14 | Celah G1 (kunci `dangerous` di loopback tanpa token): Opsi P, token opt-in lewat API (lihat U1). | Opsi R atau membiarkan terkunci masing-masing memutus pemakaian lokal. |
| L15 | Tombol restart UI ditunda. README hanya memuat bagian kontrak env (Rule 16); baris per-fitur diflag, bukan ditulis ulang. | Narasi README milik user. |

## Disetujui user (U1-U6)

| ID | Keputusan | Catatan |
|----|-----------|---------|
| U1 | Token opt-in lewat Settings (Opsi P): `GET /api/settings/token`, `POST .../enable` (hanya peer loopback, nilai dikembalikan sekali), `POST .../rotate`. | Tidak ada disable. UI-nya belum ada: itu program CHENV. |
| U2 | Allowlist Host aktif hanya selama tidak ada token yang ditegakkan. | Dengan token, Host tidak dicek. |
| U3 | Yang dicetak saat boot adalah path berkas token, bukan nilainya, kecuali di TTY (path + URL ber-token). Non-TTY: path dan panjang. | Mencegah token masuk log proses. |
| U4 | Empat fitur berkas baca-saja default on (= L11). | |
| U5 | Hak berkas tambahan untuk EM-14 dan EM-15 di luar jatah awal (`mount.ts`, `resolveToken`). | Dibutuhkan untuk memasang gerbang token dan route baru. |
| U6 | Provenance `ptyEnv` (= L8). | |

## Urutan boot dan perilaku startup

`PORT` tidak valid kini error dan exit (dulu jatuh ke 8700). Galat bind yang dikenal (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`) exit 1 dengan satu pesan, bukan stack. Token non-loopback dibangkitkan sebelum listen supaya tidak ada jendela terbuka.

## Batas jujur token (b §3.2)

- Proses lokal dengan uid yang sama bisa memanggil API sebelum `enable` dan membaca berkas sesudahnya. Tidak dilindungi; setara risiko hari ini, bukan eskalasi baru.
- WebSocket yang sudah terbuka sebelum `enable` atau `rotate` tetap hidup sampai ditutup (gerbang dicek saat upgrade).
- Token per-node (`WEBTERM_NODE_TOKEN`) tidak terpengaruh `enable`/`rotate`.
- Tidak ada `disable` (disengaja). Kembali ke loopback terbuka: hentikan server, hapus `<data dir>/secrets/WEBTERM_TOKEN`, nyalakan lagi. Atau set `WEBTERM_TOKEN` di env (menang atas berkas).
- Kode klaim sekali pakai (P+, usulan b §3.3) TIDAK diimplementasikan; `enable` belum meminta kode.

## Risiko R-02: downgrade

Versi lama mengabaikan `secrets/WEBTERM_TOKEN`. Setelah downgrade, loopback terbuka lagi tanpa peringatan walau token pernah diaktifkan. Tidak ada kode penanganan (versi lama tidak bisa diubah); catatan rilis dan dokumen ini adalah mitigasinya. Pakai `WEBTERM_TOKEN` di env bila downgrade mungkin terjadi.

## Rollback (b2 §12)

| Fitur | Rollback |
|-------|----------|
| Token berkas | Hapus berkas lalu restart, atau set `WEBTERM_TOKEN`. Berkas 0600 tak berbahaya. |
| Non-loopback tanpa token | Revert kode mengembalikan crash lama; token yang sudah dibangkitkan tetap di berkas. |
| Allowlist Host | Isi `WEBTERM_ALLOWED_HOSTS` dengan host yang dipakai; revert EM-01/EM-14 mengembalikan perilaku lama. |
| `ptyEnv` provenance | Revert EM-05; kunci asal `.env` kembali diwarisi PTY. |
| Data dir 0700 / DB 0600 | `chmod` manual bila perlu; kode tidak mengembalikan otomatis. |
| Impor `.env` | Hapus entri hasil impor lewat Settings (`unset`); `.env` asli tidak pernah diubah. |
| 4 kunci mati | Override lama tetap di blob, tidak hilang. |
| Dialek flag | `WEBTERM_X=1` kini on; rollback = revert EM-11. |
| Skema DB | Tidak berubah (Rule 4 tidak terpicu). |

## Ditunda

- UI token di Settings (enable/rotate/status) dan tombol restart: program CHENV.
- K3: autoload dotenv untuk binary: rilis mayor.
- P+ (kode klaim sekali pakai): hanya bila user memintanya.
- Penghapusan alias `TELEGRAM_BOT_TOKEN`: rilis sesudah 0.7.0.

## Catatan: dokumen lain yang kini basi

`docs/decisions/files-manager.md` P-6 (DNS-rebinding tidak ditutup) dan P-11 (flag `WEBTERM_FILES_*` default OFF) sudah tidak akurat: L4 menutup DNS-rebinding selama tanpa token, dan L11 menaikkan empat flag baca-saja ke on. Berkas itu tidak diubah di sini.
