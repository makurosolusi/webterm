# Browser favicons: keputusan

## Gejala dan akar
Tab di node browser selalu menampilkan ikon globe, jadi pemilik yang sedang mengembangkan app tidak melihat favicon
(atau perubahan favicon) halamannya. Akar: `BrowserTab.favicon` dan `BrowserTabIcon` sudah siap menampilkan, tetapi
tidak ada kode server yang membaca ikon halaman; field itu tidak pernah terisi. `src/client/browser.favicon.tsx` hanya
menebak `<origin>/favicon.ico` untuk tile halaman awal dan bukan jalur tab.

## Keputusan (standar Chrome/Edge)
- **Deteksi.** Saat halaman selesai dimuat (event `Page.frameStoppedLoading`, jalur view dan jalur tab latar), server
  menjalankan satu `Runtime.evaluate` di halaman: membaca semua `<link rel~=icon>` (icon, shortcut icon, apple-touch-icon,
  apple-touch-icon-precomposed, mask-icon) dan, sekali per dokumen, memasang `MutationObserver` ringan pada `<head>` yang
  memanggil binding `webtermFavicon` (`Runtime.addBinding`) bila `<link>` ditambah atau `href`/`rel` berubah. Dipilih karena
  satu panggilan CDP per pemicu, tanpa polling, tanpa domain `DOM` (yang mahal dan menyalakan snapshot). Binding yang
  dipanggil halaman hanya memicu baca ulang, jadi halaman jahat tidak bisa memalsukan isi ikon lewat jalur itu.
- **Pemilihan.** `pickFavicon(links, pageUrl)` (`src/shared/browser.favicon.ts`, murni): `rel=icon` dulu (apple-touch/mask
  hanya bila tak ada `rel=icon`); SVG/`sizes=any` menang, lalu ukuran terkecil >=32px (16px pada 2x), lalu tanpa ukuran,
  lalu yang terbesar di bawah 32px; `media` dark-only diabaikan; tanpa deklarasi: `<origin>/favicon.ico`. Ikon `data:`
  inline (umum di app dev, mis. emoji SVG) didukung tanpa jaringan.
- **Pengambilan byte di server.** `Network.loadNetworkResource` pada frame utama tab: memakai jaringan, cookie, dan proxy
  profil yang sama dengan halaman (jadi `localhost`, `127.0.0.1`, dan situs ber-cookie tetap jalan), tanpa klien HTTP kedua
  yang bisa menyelinap melewati penjaga. Isi dibaca bertahap lewat `IO.read` dan dihentikan begitu melewati
  `MAX_FAVICON_BYTES` (64 KB). Hanya status 2xx.
- **Bentuk ke klien.** Data URI `data:<mime>;base64,...` pada `BrowserTab.faviconData`. Tipe ditentukan dari magic bytes
  (png, ico, jpeg, gif, webp, svg), bukan Content-Type. Klien tidak pernah memuat URL situs luar (tanpa pelacakan, tanpa
  mixed-content) dan `BrowserTabIcon` hanya menerima data URI bertipe gambar. `referrerPolicy="no-referrer"` tetap.
- **Persistensi.** `favicon` = URL ikon http(s) (<=512 karakter) dan ikut board; `faviconData` TIDAK pernah dipersist.
  Tab yang dipulihkan muncul sebagai globe lalu terisi saat halamannya dimuat (diaktifkan). Tab discarded mempertahankan
  ikon terakhir (redup). Pembersihan: server mengirim string kosong (JSON membuang `undefined`, jadi patch tidak akan
  menghapus field); klien memperlakukan kosong sebagai tanpa ikon.
- **Tahan perubahan.** Cache memori per `(profil, URL ikon)` (`browser.favicon.cache.ts`): LRU, maks 128 entri / 2 MB,
  kedaluwarsa 10 menit; kegagalan (404, bukan gambar) ikut di-cache agar tidak diulang tiap navigasi. Pemuatan ulang
  halaman dengan URL yang sama sejak muatan sebelumnya dianggap reload: melewati cache kita dan cache HTTP Chromium
  (`disableCache`), sehingga favicon baru app yang sedang dikembangkan langsung terlihat. ETag/Last-Modified tidak dipakai
  karena `loadNetworkResource` tidak mengirim permintaan bersyarat; `disableCache` pada reload lebih kuat. Pemicu
  digabung (debounce 500 ms per tab) dan dibatasi 6 baca per menit per tab (`FAVICON_RATE_MAX`); yang melebihi ditunda
  sampai jendela bergeser, jadi situs yang mengganti ikon tiap detik tidak membanjiri.
- **UI.** `BrowserTabIcon`: crashed > loading > ikon > globe; discarded menampilkan ikon terakhir redup (bulan bila belum
  punya). Ukuran `--bui-icon`, `object-fit: contain`, latar/ring tipis dari `--vscode-foreground` (`color-mix`, tanpa hex)
  agar logo gelap terbaca di tema gelap; gagal dimuat -> globe. Tampil di strip, menu All tabs (baris aktif memakai
  centang), dan header pane split. Tidak ada di baris judul node (keputusan pemilik).
- **Agent.** Tidak ada verb baru. `tabViews` adalah whitelist dan tidak membawa `favicon`/`faviconData`; ikon tidak masuk
  output agent, snapshot, maupun briefing (dikunci tes).

## Model ancaman
- **SVG berbahaya** (script, handler `on*`, `foreignObject`, `<animate>`, href/`url()` ke luar dokumen, DOCTYPE/ENTITY,
  CDATA, `@import`, `javascript:`): ditolak seluruhnya (fail-closed), tidak diperbaiki. Ditambah lapis kedua: ikon ditampilkan
  lewat `<img>`, yang tidak menjalankan skrip dan tidak memuat sumber luar.
- **SSRF lewat ikon.** Ikon satu origin dengan halaman selalu boleh (halaman itu sudah lolos penjaga navigasi). Ikon lintas
  origin harus lolos `NavGuard.check` DAN tidak boleh menunjuk loopback/IP privat dari halaman publik
  (`browser.favicon.policy.ts`). Nama host publik yang di-resolve ke IP privat dijaga proxy egress seperti navigasi biasa,
  sebab fetch memakai jaringan profil.
- **Ukuran.** Batas 64 KB sebelum base64, dibaca bertahap dan dihentikan lebih awal; cache dibatasi entri dan byte.
- **Pelacakan.** Klien tidak pernah meminta URL ikon; hanya server (lewat profil yang sama dengan halaman) yang meminta.
  Log hanya memuat hostname ikon, tanpa path/query.

## Batas yang diketahui
- Ikon yang butuh header khusus (mis. `Accept` atau token per-permintaan) gagal dan jatuh ke globe.
- Halaman tanpa `<head>` tidak dipasangi observer: perubahan ikonnya baru terlihat pada muatan berikutnya.
- Muat ulang sebuah subframe pada halaman yang sama dihitung sebagai reload (event `frameStoppedLoading` tidak membedakan
  bingkai); akibatnya satu pengambilan ulang, dibatasi debounce dan laju.
- Pembacaan ikon memakai `Runtime.evaluate` di dunia utama halaman; halaman yang menimpa `document.querySelectorAll` bisa
  menyembunyikan ikonnya sendiri (tidak ada dampak keamanan: hasil tetap melewati kebijakan, sniff, dan sanitasi).
- Menu All tabs: baris aktif menampilkan centang di kolom ikon (komponen menu bersama), bukan ikon.
- Payload event `tabUpdated` membawa data URI (umumnya 1-5 KB, maks ~88 KB); daftar penuh 8 tab bisa mencapai sekitar 700 KB
  hanya pada kasus terburuk. Tidak ada event baru.
- Belum diamati di Chromium nyata: perilaku `Network.loadNetworkResource` (butuh `frameId`, mengembalikan stream) hanya diuji
  dengan CDP palsu.

Tes: `browser.favicon.test.ts` (shared), `browser.favicon.image.test.ts`, `browser.favicon.cache.test.ts`,
`browserHost.favicon.test.ts`, `browserHost.favicon.wiring.test.ts`, `BrowserTabIcon.test.tsx`.
