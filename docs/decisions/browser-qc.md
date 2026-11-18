# Browser QC: sinkron, layout agent, --all (P5, tahap 5)

Melanjutkan `browser-split.md`. QC melihat beberapa halaman sekaligus; dua hal ditambah: **mode sinkron** (aksi manusia di satu
pane diulang di pane lain) dan **verb agent** untuk menyusun layout dan menjalankan satu aksi di semua tab. Agent tetap
mengalamatkan **TAB**, bukan pane. Compare overlay (slider/selisih piksel) ada di dokumen lain.

## Mode sinkron (default mati, state sesi)
- `POST /api/browser/:nodeId/sync {on}` (GET membaca) + pesan WS `{t:'sync', id, on}` (juga dikirim saat attach) dan
  `{t:'syncMiss', id, tab, reason}`. State hanya di memori server (`browserHost.sync.ts`), tidak ikut disimpan ke board.
- Hanya menyala untuk node dengan layout >= 2 pane (galat `bad_request` dengan alasan bila tidak); mati sendiri begitu layout runtuh ke
  satu pane. Target = tab yang tampil di layout node itu: node yang sama, profil yang sama (satu node = satu profil), tidak pernah node lain.
- Yang diulang (sumber = tab fokus, atau tab pemilik input): navigasi `go/reload/back/forward` (URL lewat penjaga SSRF yang sama:
  `tabApi.navigateTab`), tombol/teks (dikirim apa adanya), scroll (posisi sebagai **rasio** `scrollTop / (scrollHeight - innerHeight)`,
  satu salinan per rentetan roda, 150 ms), dan klik.
- **Klik dicocokkan secara semantik** (`browser.semantic.ts`): titik klik -> `DOM.getNodeForLocation` -> node AX -> kontrol bernama
  terdekat (role + nama aksesibel + urutan ke-n di antara yang sama, pohon AX berurutan dokumen). Di pane lain dicari pasangan yang
  sama persis (nama dibanding tanpa beda huruf/spasi). Tak ada -> `syncMiss` `no_match` dan pane itu menampilkan penanda "No match"
  beberapa detik; pane lain jalan terus, input manusia tak pernah gagal karenanya (galat dicatat, bukan dilempar).
  Kontrol dengan `formaction` ke origin lain **tidak** diklik di pane lain (`cross_origin`, sama dengan penjaga P-10 untuk klik ber-ref).
- Pekerjaan cermin satu node berjalan berurutan (klik dulu, lalu ketikan sesudahnya) dan tak pernah memblokir input manusia.
- Yang **tidak** dicerminkan: perintah agent (lease agent memegang node; hook `agentDriving`). Agent memakai `--all`. Alasan: aksi
  agent sudah eksplisit per tab, dan mencerminkannya diam-diam melipatgandakan efek.
- Aksi destruktif (mis. kirim form) diteruskan seperti aksi biasa; tombol sinkron memperingatkan sekali ("Actions you take will repeat
  in every pane", diingat di localStorage; bila storage diblokir peringatan muncul tiap muat).
- UI (file baru, satu titik pasang di `BrowserNode` trailing + satu baris di `BrowserPane`): `BrowserSyncToggle` (tombol mati/hidup,
  indikator "Sync on" + tombol Stop, Esc menghentikan, `role=status` mengumumkan, nonaktif dengan alasan bila pane < 2) dan
  `BrowserSyncMiss` (penanda per pane).

## Verb agent (CLI `webterm browser`, endpoint kontrol, tool Central)
- `layout get` -> pohon (`h(t1, v(t2, t3))`), tiap pane: tab, judul, host, fokus, ukuran, device; `sync` menyala atau tidak.
- `layout set <spec>` (verb kontrol `arrange`, `browser.act`): `single <tab>`, `h <tab> <tab> [..]` (kolom), `v ...` (baris),
  `grid <t1> <t2> <t3> <t4>`; tab = id dari `tabs` atau `new:<url>` (membuka tab dulu, lewat penjaga SSRF). Spek divalidasi murni
  (`browser.layoutSpec.ts`) sebelum menyentuh apa pun; batas 4 pane dan 8 tab diperiksa **sebelum** tab dibuka (tidak ada setengah jadi
  untuk batas tab). Pemisah h/v n pane = rantai rasio sama-rata (kedalaman <= 3, lolos `validLayout`).
- `sync on|off`. `reload`, `back`, `forward` (verb halaman baru, juga `--tab`).
- `--all` pada `navigate`, `snapshot`, `screenshot`, `scroll`, `reload`, `back`, `forward`, `click`, `type`: menjalankan pada setiap tab
  layout (tanpa split: satu tab yang tampil, dengan catatan) dan menjawab `{all, results:[{tab, ok, name, ...}], okCount, failedCount}`.
  Tab yang gagal tidak menggagalkan yang lain; kursor tab kerja agent dikembalikan. `--all` + `--tab` ditolak (`bad_request`).
  - `snapshot --all`: isi tiap tab; `snapId` dibuang (ref tidak bisa dipakai lintas tab; catatan menyuruh snapshot satu tab dulu).
  - `screenshot --all` = `screenshot --layout`: daftar bernama, lebar default 800 supaya empat JPEG tak membanjiri jawaban.
    Komposit satu gambar ditunda (tanpa pustaka gambar baru).
  - `click|type --all` hanya dengan target semantik: `--text "<nama>"` (+ `--role`, `--nth`); nama persis dulu, lalu "mengandung" sebagai
    cadangan; tanpa role, kontrol dipilih di atas teks statis. Tak cocok = hasil `no_match` untuk tab itu; `formaction` lintas-origin = `blocked`.
- Preset terkunci (skill-author): semua verb baru dan `all`/`layout` pada verb yang boleh ditolak 403 `verb_not_allowed_for_preset`
  (whitelist `PRESET_BROWSER_VERBS` tidak diubah; tes).
- Tool Central `browser_layout` (R1, tanpa kartu izin): `get`, `set`, `sync`, dan `all` untuk `navigate|scroll|reload|back|forward`.
  **Deviasi:** `click`/`type` sengaja tidak ada di `all` Central: `browser_act` R2 meminta persetujuan, dan tool R1 tidak boleh
  menjadi jalan pintas. Membaca banyak halaman = `browser_read` per tab (pembaca terisolasi menjaga teks halaman dari model Central).
- Kemampuan `web.layout` di registry (`agentCapabilities.data.ts`): granted `central.steward`, `chat.default`; ditolak untuk kedua
  author. Briefing, baris UI, penegakan, label (`toolLabels.ts`) dan `capabilityHash` diturunkan; sesi lama menerima catatan
  "Capabilities updated" lewat mekanisme yang ada. Skill `webterm-browser` diperbarui (bagian "Split panes").

## Batas dan keamanan
- 4 pane, 8 tab per node, URL baru lewat penjaga navigasi/SSRF (`blocked` per tab pada `--all`, 403 pada `arrange`).
- Sinkron dan `--all` tidak pernah menembus node atau profil lain; tak ada API baru yang menyentuh cookie.
- Nama elemen, judul tab, dan isi snapshot adalah data halaman (tak tepercaya): tetap di dalam pembungkus `untrusted-web`.
- Satu pembaca AX penuh per klik cermin per pane: harga yang dipilih demi pencocokan semantik; sinkron bukan untuk halaman raksasa
  tanpa batas (`getFullAXTree` tanpa kedalaman, sama dengan `snapshot`).

## Belum diverifikasi tanpa UI nyata
Tampilan indikator "Sync on", penanda "No match" dan peringatan satu kali di tema terang/gelap/kontras tinggi, fokus keyboard di
header node yang padat, pengumuman pembaca layar, dan perilaku scroll sinkron di halaman dengan kontainer scroll sendiri (rasio
hanya membaca scroller dokumen). Tes jsdom membuktikan pengkabelan dan ARIA; tes Chromium nyata
(`browserHost.sync.real.bun.test.ts`) membuktikan klik semantik, no-match, navigasi tercermin, `layout set` dan `--all`.
