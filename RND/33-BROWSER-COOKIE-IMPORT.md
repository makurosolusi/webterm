# 33 - Import cookie / sesi login ke browser terkelola webterm

Topik 3 R&D (2026-11-03). Riset dokumentasi saja: tidak ada cookie/profil/Keychain asli dibaca, tidak ada browser dijalankan. Tanda `[BT]` = belum terverifikasi dari sumber primer; `[opini]` = penilaian penulis.

Sumber primer: blog Chrome ABE (security.googleblog.com, 2024/07), developer.chrome.com/blog/remote-debugging-port, yt-dlp `cookies.py`+README (master), browser_cookie3 (README/PyPI/GitHub API), docs Playwright, CDP `Storage`, `ego-browser help import`/`skill` v2.2.0 dan `~/.agents/skills/ego-browser/references/*.md` (teks saja).

---

## 1. Ringkasan eksekutif

| Hal | Kesimpulan |
|---|---|
| Ekstrak langsung dari store Chrome di disk | Rapuh: v10/v11 masih bisa (macOS Keychain, Linux keyring), tetapi Windows v20 (App-Bound, Chrome 127+) sengaja menolak proses lain. Jangan jadikan jalur utama. |
| Chrome 136+ | `--remote-debugging-port` diabaikan pada data dir default, wajib `--user-data-dir` non-standar. Jalur "attach CDP ke Chrome harian user" mati. |
| Jalur paling aman | Browser terkelola webterm punya profil sendiri (`--user-data-dir` milik webterm). User login SENDIRI sekali di dalam node browser (human + agent berbagi sesi). Cookie tinggal di profil itu, tak pernah diekspor. |
| Import dari browser harian | Opsional, opt-in per domain. Dua mekanisme: (1) ego-style import profil penuh oleh browser tujuan sendiri (tanpa lewat webterm), (2) ekstensi/CDP-export per-domain ke `storageState`. |
| Format pertukaran | Playwright `storageState` JSON (cookies + localStorage origin) sebagai format internal; Netscape cookies.txt hanya untuk impor/ekspor eksternal. |
| Penyimpanan | Enkripsi at-rest (AES-GCM, kunci dari `SecretStore`), TTL, scope per workspace/node, nilai cookie tak pernah di-log atau dikirim ke client UI. |

---

## 2. (a) Lokasi store dan enkripsi cookie per browser/OS

Fakta dari `yt_dlp/cookies.py` (master) dan blog Chrome kecuali ditandai.

| Browser | OS | Lokasi store | Enkripsi | Catatan |
|---|---|---|---|---|
| Chrome/Chromium/Brave/Edge/Vivaldi/Opera (Chromium) | macOS | `<User Data>/<Profile>/Cookies` (Chrome ~96+ pindah ke `<Profile>/Network/Cookies`) [BT path tepat per versi] | SQLite, nilai `v10` AES-128-CBC; kunci = PBKDF2-SHA1(password "Safe Storage" di Keychain, salt `saltysalt`, 1003 iterasi) (cookies.py:494-506) | Akses Keychain memunculkan prompt OS per aplikasi pemanggil. Itu kontrol yang berguna, bukan hambatan untuk dilawan. |
| Chromium | Linux | sama | `v10`: kunci tetap ("peanuts"); `v11`: kunci dari keyring (kwallet/libsecret/gnome) (cookies.py:438-490) | Tanpa keyring -> v10 saja, praktis tidak terlindungi dari proses sesama user. |
| Chromium | Windows | sama | `v10`: AES-GCM, kunci di `Local State` dibungkus DPAPI (cookies.py:414-416). `v20`: App-Bound Encryption, Chrome 127+ | DPAPI tidak melindungi dari proses sesama user (kata Google sendiri). ABE: kunci diikat identitas aplikasi via layanan hak SYSTEM; proses lain gagal dekripsi, kecuali malware naik hak/inject ke Chrome. Kunci terikat mesin -> profil roaming tidak jalan (blog Google). |
| Firefox / Zen / LibreWolf | semua | `<profile>/cookies.sqlite` | Tanpa enkripsi (plaintext SQLite) [BT: konfirmasi di docs Mozilla; yt-dlp `_extract_firefox_cookies` cookies.py:127 membacanya langsung tanpa dekripsi] | Container Firefox dipisah via `containers.json` (cookies.py:161). |
| Safari | macOS | `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies` (atau `~/Library/Cookies/...` lama) (cookies.py:578-582) | Format biner, tanpa enkripsi aplikasi | Dilindungi TCC: butuh Full Disk Access untuk proses pembaca (`PermissionError` ditangani, cookies.py:361). Tidak ada API resmi ekspor cookie. |

### Dampak App-Bound Encryption dan Chrome 136

- ABE (Chrome 127, Windows) dibuat khusus agar "aplikasi lain sesama user" tak bisa mendekripsi (https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html). Konsekuensi untuk webterm: pembaca cookie Windows pihak ketiga yang andal tidak ada; jalur yang ada adalah bypass (elevasi/inject) yang secara definisi berperilaku seperti infostealer dan akan ditandai AV/EDR. **Jangan implementasikan.**
- Hasil cek hari ini: `grep -ci "app.bound"` pada `yt_dlp/cookies.py` master = 0, dan tidak ada penanganan `v20`. Berarti yt-dlp belum mendekripsi cookie ABE (issue Windows "failed to decrypt with DPAPI" #10927 masih open). browser_cookie3: issue #210 "Broken decryption in Chrome" open; commit terakhir 2024-12-20, PyPI 0.20.1, lisensi LGPL-3.0 [BT apakah ABE didukung; tidak ada indikasi di README]. Kesimpulan: pustaka ekstraksi populer tidak menyelesaikan Windows + Chrome modern.
- Chrome 136: `--remote-debugging-port`/`--remote-debugging-pipe` diabaikan bila memakai data dir default; harus bersama `--user-data-dir` custom, yang memakai kunci enkripsi berbeda (https://developer.chrome.com/blog/remote-debugging-port). Google menyebut ini dilakukan karena maraknya pencurian cookie lewat CDP. Alternatif resmi untuk otomasi: Chrome for Testing (tetap menerima flag).
- Device Bound Session Credentials (DBSC): W3C First Public Working Draft; repo `w3c/webappsec-dbsc` aktif (push terakhir 2026-09-08). Status rilis stabil per browser [BT]. Jika sebuah situs mengadopsi DBSC, cookie sesi yang diimpor ke mesin lain akan cepat tak berlaku (terikat kunci TPM perangkat) [opini, dari desain spesifikasi]. Artinya import cookie akan makin tidak andal untuk situs bernilai tinggi (Google dkk).

### Tools yang ada (hanya dokumentasi, tidak dijalankan)

| Tool | Cara kerja | Lisensi | Status | Catatan |
|---|---|---|---|---|
| yt-dlp `--cookies-from-browser BROWSER[+KEYRING][:PROFILE][::CONTAINER]` | Baca SQLite + dekripsi lokal | Unlicense | Rilis 2026.10.26 (aktif) | Tidak mendukung v20 (lihat atas). Berguna sebagai referensi implementasi. |
| browser_cookie3 | Python, baca store + dekripsi | LGPL-3.0 | 0.20.1, commit terakhir 2024-12 | LGPL + Python: bukan dependency Bun; tidak cocok. |
| Ekstensi "cookies.txt"/EditThisCookie-class | Ekstensi memanggil `chrome.cookies` API (di dalam browser, lolos ABE) | beragam | [BT] | Ekstensi cookie pihak ketiga pernah jadi vektor malware; pakai hanya ekstensi buatan sendiri bila perlu. |
| CDP `Storage.getCookies` / `Network.getAllCookies` | Minta browser yang sedang jalan menyerahkan cookie-nya | protokol | `Storage.getCookies` ada di domain Storage (tot) | Hanya untuk browser yang kita jalankan sendiri (profil webterm). Tidak untuk Chrome harian (Chrome 136). |
| ego-browser import | Lihat bagian 6 | proprietary [BT] | v0.6.2.5, Chromium 156 | Tujuan = browser ego itu sendiri. |

---

## 3. (b) Format

| Format | Isi | Kelebihan | Kekurangan | Peran di webterm |
|---|---|---|---|---|
| Netscape `cookies.txt` | 7 kolom TAB: domain, includeSubdomains, path, secure, expiry, name, value (HttpOnly via prefix `#HttpOnly_`) | Didukung yt-dlp, curl, wget | Hanya cookie; tanpa SameSite, partition key, localStorage | Format impor/ekspor luar saja. |
| JSON cookie array (gaya ekstensi/CDP `Cookie`) | name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey | Dekat dengan CDP | Beragam varian antar ekstensi | Normalisasi ke bentuk CDP `CookieParam` sebelum dipakai. |
| Playwright `storageState` | `{cookies:[...], origins:[{origin, localStorage:[{name,value}]}]}`; `context.storageState()` / `browserContext.setStorageState()` (membersihkan lalu mengisi cookies, localStorage, IndexedDB) | Satu berkas memuat cookie + localStorage; didokumentasikan resmi; docs menyarankan menaruhnya di `.gitignore` karena berisi data sensitif (https://playwright.dev/docs/auth) | sessionStorage tidak ikut [BT dalam docs]; ikut Playwright | **Format internal yang disarankan** walau webterm tidak memakai Playwright: skemanya sederhana, mudah dibuat dari CDP. |

---

## 4. (c) Mengembalikan ke browser terkelola

| Mekanisme | Detail | Catatan |
|---|---|---|
| CDP `Network.setCookies` / `Network.setCookie` | Parameter `CookieParam[]`; cookie `__Host-`/`__Secure-`/`Secure` perlu `url`/domain konsisten; `partitionKey` untuk CHIPS | Dipakai sebelum `Page.navigate`. Di Bun tanpa pustaka: WebSocket CDP + 1 pesan JSON. |
| CDP `Storage.setCookies` | Menerima `browserContextId` -> mengisi context tertentu | Lebih tepat saat satu proses Chromium punya banyak context per node. |
| localStorage | `Page.addScriptToEvaluateOnNewDocument` atau `Runtime.evaluate` per origin setelah navigasi ke origin itu | Harus bernavigasi ke origin dulu; storageState Playwright melakukan hal ini di dalam. |
| Profil persisten `--user-data-dir=<dir webterm>/browser/<profileId>` | Login sekali, bertahan lintas restart | Direktori dibuat `0700`; berisi kunci dekripsi lokal (Keychain "Chromium Safe Storage" milik webterm di macOS, kunci `Local State` di Windows). Jangan ditaruh di dalam repo; masuk `.gitignore`/Rule 7. |
| Context terisolasi `Target.createBrowserContext` | Satu context per node/workspace tanpa proses baru | Isolasi cookie antar node; RAM lebih hemat daripada proses per node [opini]. |

Batasan [opini]:
- Cookie bertanda `Secure` + `SameSite=None` diterima, tetapi kesamaan fingerprint (UA, IP, TLS) tidak dijamin; banyak situs (Google, bank) mencabut sesi bila UA/IP/perangkat berubah atau terdeteksi otomasi. Import bisa "berhasil lalu logout dalam menit".
- Cookie `HttpOnly` hanya bisa diambil via CDP/API ekstensi/pembacaan store, tidak lewat `document.cookie`.
- Webterm remote + browser user lokal: cookie lewat jaringan butuh TLS + token auth, jangan di URL.

---

## 5. (d) Risiko keamanan, hukum, dan model izin

### 5.1 Risiko

| Risiko | Penjelasan | Mitigasi |
|---|---|---|
| Cookie = kredensial penuh | Pemegang cookie sesi = pemilik akun (melewati 2FA). Satu kebocoran = pengambilalihan akun. | Minimalkan: impor hanya domain yang dipilih, bukan seluruh jar. |
| Prompt injection menuju exfiltrasi | Agent yang membaca halaman bisa dibujuk mengirim cookie/jar (mis. lewat `page.fetch`, `Network.getAllCookies`) ke pihak ketiga. | Agent TIDAK diberi tool baca nilai cookie. Tool kontrol hanya melihat nama domain + jumlah. Egress allowlist bila memungkinkan. |
| Agent merusak sesi | `Network.clearBrowserCookies`, `Storage.clearCookies` tanpa `browserContextId` menghapus seluruh profil dan tak bisa dibatalkan (ego `references/clearing-state.md`:9-18). | Blokir perintah CDP berjangkauan profil di lapisan proxy; hanya izinkan hapus per-domain/per-cookie; butuh persetujuan user untuk selebihnya (meniru ego). |
| Pencurian lokal | Berkas hasil ekspor di disk/home/log/backup. | Jangan tulis ke disk dalam bentuk plaintext; enkripsi at-rest (5.2). |
| Terlihat seperti infostealer | Membaca store browser lain oleh proses non-browser adalah perilaku infostealer; Google menaikkan hambatan khusus karena ini. | Jangan bangun pembaca store sendiri (macOS Keychain, DPAPI, ABE). Delegasikan ke mekanisme yang disetujui OS/browser (ekstensi, impor in-browser, login manual). |
| Kebocoran lewat UI/log | Nilai cookie terkirim ke client, tercetak di log, atau masuk transkrip agent. | Server tidak pernah mengirim nilai ke client; logger memakai redaksi pola; tipe `CookieValue` opaque. |

### 5.2 Model izin yang direkomendasikan [opini]

| Aspek | Aturan |
|---|---|
| Opt-in | Nol impor otomatis. Perlu aksi manusia di UI; agent tidak dapat memicu impor. |
| Granularitas | Per domain (eTLD+1), dengan daftar domain yang dicentang user; tidak ada "impor semua". |
| Konfirmasi | Dialog menampilkan: sumber (browser + profil), domain terpilih, jumlah cookie, tujuan (workspace/node), TTL. Tombol bertuliskan jelas "Beri browser ini akses sesi untuk: github.com, ...". |
| Penyimpanan | Blob `storageState` terenkripsi AES-256-GCM, kunci dari `SecretStore` webterm; hanya di server; kolom DB berisi ciphertext + metadata (domain, jumlah, createdAt, expiresAt). |
| TTL | Default 7 hari (konstanta bernama + env, bukan hardcode); sesudahnya dihapus otomatis; perpanjangan = konfirmasi ulang. |
| Scope | Terikat `workspaceId` (+ opsional `nodeId`). Node lain tidak melihat. Hapus workspace = hapus rahasia. |
| Logging | Hanya `{workspaceId, domains[], count, action}`. Tidak pernah nilai, nama cookie sesi, ataupun hash nilai. |
| Revoke | Tombol "Cabut" per domain: `Network.deleteCookies` per-domain + hapus blob. Audit event tercatat. |
| Agent | Agent mendapat verb seperti `browser.listAuthenticatedDomains()` (domain + jumlah saja), bukan `getCookies`. |
| Remote | Impor lewat HTTPS saja; tolak di HTTP non-loopback. Token auth webterm wajib. |

### 5.3 Hukum / ToS [opini; bukan nasihat hukum]

- Mengimpor cookie milik user sendiri ke alat milik user sendiri umumnya diperbolehkan secara hukum, tetapi ToS banyak situs melarang otomasi/scraping dan penggunaan sesi pada klien tak resmi; risiko praktisnya adalah akun dibatasi/diblokir. Beri peringatan di dialog.
- Jangan dukung impor cookie milik pihak lain (akses tidak sah); pada deploy multi-user, cookie per-user dan terisolasi.
- Akses dengan kredensial curian melanggar hukum di banyak yurisdiksi [BT detail pasal]; fitur tidak boleh mudah disalahgunakan untuk itu.

---

## 6. (e) Bagaimana ego-browser melakukannya (dari `--help` dan skill, hanya teks)

Tidak menjalankan `ego-browser import list` karena perintah itu memindai profil browser asli di mesin ini.

| Fakta | Sumber |
|---|---|
| `ego-browser import --browser <b> [--profile <dir>...] [--clear-existing-profiles] [--no-default]` | `ego-browser help import` |
| Browser sumber: chrome, edge, brave, comet, opera, vivaldi, yandex, firefox, zen, arc, dia | sama |
| "Runs browser data import through the browser-side CLI service": impor dikerjakan oleh proses browser ego sendiri, bukan oleh CLI/agent. Profil dipilih dengan nama direktori sumber (`Default`, `Profile 1`) | sama |
| Hasil impor = profil Ego baru; `--clear-existing-profiles` menghapus semua profil Ego lama dan memulai ulang; kegagalan/pembatalan mempertahankan profil lama; bila Ego dijalankan dengan `--user-data-dir`, impor menambah profil tanpa menghapus | sama |
| Onboarding: impor dari Chrome dst. adalah langkah GUI yang dilakukan user ("Choose to import data from Chrome or another browser as needed") | `references/install.md:31` |
| Agent dilarang memeriksa/memilih profil kecuali user meminta profil tertentu; `profileId` hanya berlaku saat membuat task space | `ego-browser skill` baris 59 |
| Penghapusan state: perintah berjangkauan seluruh profil (`Network.clearBrowserCookies`, `Storage.clearCookies` tanpa `browserContextId`) butuh persetujuan user; gunakan penghapusan per-site/per-cookie | `references/clearing-state.md:9-64` |
| Agent boleh membaca `Network.getAllCookies` (untuk menghitung dampak) | `clearing-state.md:62-64` [catatan: ego tidak menutup baca nilai dari agent] |
| Hal yang tidak terdokumentasi: mekanisme dekripsi (Keychain/DPAPI/ABE), apakah ABE didukung, dan lisensi | [BT] |

Pelajaran desain dari ego [opini]:
1. Impor adalah aksi manusia di sisi browser tujuan (GUI/CLI user), bukan fitur yang dipicu agent.
2. Satu pemilik profil jelas (task space dengan `ownership`); tindakan merusak butuh persetujuan.

---

## 7. Perbandingan jalur impor untuk webterm

| Jalur | Cara | Aman | Andal | Kerja | Cocok remote | Verdik |
|---|---|---|---|---|---|---|
| J0. Login manual di node browser | User mengetik login di dalam browser terkelola (tampilan lewat streaming topik 4); cookie tetap di profil persisten | Tinggi: cookie tak pernah keluar | Tinggi (tanpa mismatch fingerprint antara asal dan tujuan) | Rendah | Ya | **Default / MVP** |
| J1. Profil persisten per workspace | `--user-data-dir` per workspace; login sekali, dipakai ulang | Tinggi bila dir `0700` | Tinggi | Rendah | Ya | **Wajib, bagian J0** |
| J2. Ekstensi webterm ("Kirim sesi ke webterm") | Ekstensi buatan sendiri memakai `chrome.cookies.getAll({domain})` setelah user klik per situs; kirim lewat HTTPS+token ke server; server mengenkripsi dan menyuntik via CDP | Sedang: wajib konfirmasi, tersedia di browser yang ada, lolos ABE karena in-browser | Sedang (DBSC/IP-binding bisa mematikan sesi) | Sedang-tinggi (publikasi ekstensi, MV3) | Ya | Opsional fase 2 |
| J3. Impor profil penuh ala ego (aplikasi tujuan yang membaca store) | Hanya masuk akal bila node browser adalah aplikasi native yang di-install user (topik 4 opsi E: Electron/Tauri) | Sedang | Sedang | Tinggi | Tidak (lokal saja) | Hanya bila ada shell native |
| J4. Upload manual `storageState`/cookies.txt | User mengekspor sendiri dan mengunggah | Rendah-sedang: berkas plaintext di tangan user | Sedang | Rendah | Ya | Fase 2 untuk power user, dengan peringatan |
| J5. Pembaca store sendiri di server Bun (Keychain/DPAPI) | Meniru yt-dlp/browser_cookie3 | Rendah: perilaku infostealer, gagal di ABE, prompt Keychain | Rendah di Windows | Tinggi | Tidak (server tak punya browser user) | **Jangan** |
| J6. Attach CDP ke Chrome harian | `--remote-debugging-port` pada profil default | n/a | Mati sejak Chrome 136 | - | - | **Jangan / tidak mungkin** |

---

## 8. Implikasi untuk webterm

### Rekomendasi tegas

1. **MVP tanpa fitur import**: browser terkelola dengan profil persisten per workspace (J0+J1). Login manual satu kali oleh user di node. Ini memenuhi "sesi login" tanpa risiko apa pun dan mengikuti arah aman Chrome 136. Memuat dependensi nol (CDP lewat WebSocket Bun cukup untuk `Network.setCookies`/`Target.createBrowserContext`; pustaka seperti puppeteer-core belum perlu, Rule 10).
2. **Fase 2, bila benar-benar diminta**: ekstensi sendiri (J2) atau upload `storageState` (J4). Jangan membangun pembaca store browser di server (J5). Format internal = Playwright-style `storageState`; konversi dari/ke Netscape cookies.txt cukup <50 baris.
3. **Alur UX aman**: pilih domain -> dialog konfirmasi (sumber, domain, jumlah, tujuan, TTL, peringatan ToS) -> impor -> UI hanya menampilkan "github.com - 7 cookie - kedaluwarsa 7 hari" + tombol Cabut. Tidak ada tampilan nilai, tidak ada tombol "salin cookie".
4. **Agent tidak pernah memegang cookie**: tool agent terbatas pada status domain-terautentikasi; blokir `Network.getAllCookies`, `Storage.getCookies`, `Network.clearBrowserCookies`, `Storage.clearCookies` (tanpa context) pada proxy CDP; hapus per-domain butuh konfirmasi. (Catatan: ego sendiri membiarkan agent memanggil `Network.getAllCookies`; webterm sebaiknya lebih ketat karena server dapat diakses jarak jauh [opini].)
5. **Penyimpanan**: blob terenkripsi AES-256-GCM dengan kunci dari `SecretStore`, TTL dari env/konstanta bernama, scope `workspaceId`; log hanya domain+jumlah; kolom DB harus lewat migration (Rule 4) bila dibuat.

### Risiko

| Risiko | Tingkat |
|---|---|
| Cookie yang diimpor kedaluwarsa cepat (DBSC, IP/UA binding, deteksi otomasi) sehingga pengguna menyalahkan fitur | Tinggi, sulit diatasi |
| Profil persisten di server berisi sesi login nyata: server menjadi target bernilai tinggi (backup, akses jarak jauh) | Tinggi; wajib auth + `0700` + enkripsi disk di host |
| Ekstensi (J2) menambah permukaan serangan dan beban publikasi/maintenance | Sedang |
| Agent diprompt-injeksi untuk menyalahgunakan sesi tanpa membaca cookie (mis. kirim form atas nama user) | Sedang; cookie yang tidak terbaca tidak mencegah aksi atas nama user. Butuh konfirmasi untuk tindakan sensitif [opini] |

### Belum terverifikasi `[BT]`

- Lokasi persis `Cookies` Chromium per versi/OS (Network/Cookies) dan ada tidaknya perubahan di Chrome 150+.
- Apakah ABE (`v20`) sudah didukung oleh browser_cookie3/pustaka lain atau bypass publik masih berfungsi di Chrome terbaru; sengaja tidak diselidiki lebih jauh.
- Status rilis stabil DBSC per browser dan situs yang sudah mengadopsinya.
- Lisensi dan mekanisme dekripsi ego-browser; apakah impor ego mendukung ABE.
- Perilaku persis `Storage.setCookies` vs `Network.setCookies` untuk cookie dengan `partitionKey` pada versi Chromium terbaru; perlu uji di lingkungan sendiri.
