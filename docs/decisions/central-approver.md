# Central sebagai penyetuju izin agent

Kode: `src/server/permission/permission.central*.ts`, tool `permission.decide`
(`src/server/central/tools/defs/permission.defs.ts`), setting `permissionRouting`.

## Keputusan pemilik

Hirarki persetujuan: agent mana pun -> Central agent -> manusia; manusia -> Central -> agent di bawahnya.
Prompt izin Claude Code yang ditahan hook (`agent.permission`) karena itu **default diserahkan ke Central**.
Manusia hanya dilibatkan bila Central mengeskalasi atau tidak bisa memutuskan.

## Alur (`permissionRouting = central`, default)

1. Hook `PermissionRequest` masuk ke `answerPermission` (`permission.wait.ts`). Aturan human-ui
   (allow/deny/ask) tetap menang lebih dulu, tidak berubah.
2. Kartu ledger dibuat seperti biasa, tetapi request-nya bertanda `via: 'central'`. Kartu bertanda ini
   TIDAK dicerminkan ke Inbox/Needs-you/Telegram dan tidak muncul di daftar izin manusia, selama belum
   dieskalasi. Tanda ada di request saat dibuat, jadi digest ledger tidak berubah.
3. Gerbang deterministik `centralHoldReason` (pakai `neverAutoReason` milik classifier: R3, ask rule,
   destruktif, push/publish, secret, path terlindungi, di luar cwd) dan cek sesi milik Central sendiri.
   Kena -> langsung eskalasi ke manusia dengan alasannya. Tanpa memanggil Central.
4. Lolos -> satu alasan check-in `permission_request` diantre (`queueCheckinReason`, `notBefore` = sekarang)
   lalu check-in dipicu segera (pola `kick` yang sama dengan laporan worker). Tanpa polling.
5. Central memutuskan dengan tool `permission.decide {approvalId, verdict, reason}` (`verdict`, bukan `decision`: itu kunci terlarang input model):
   `allow` (hanya sekali), `deny`, atau `escalate`. Tool lewat `execTool` -> controlGuard -> audit
   (`central.proposal`, actor `central`). Keputusan disetujui/ditolak atas nama `central` di ledger,
   lewat digest + nonce yang sama dengan klik manusia.
6. Loop tunggu di `answerPermission` melihat kartu approved/rejected (single use, dikonsumsi sekali)
   dan membalas hook. Reply deny menyebut Central dan alasannya.

`permissionRouting = human` = perilaku lama persis (kartu langsung ke Inbox, tanpa jalur di atas).

## Batas keras (tiap butir punya tes pengunci)

- (a) Central tidak memutuskan permintaan dari sesinya sendiri.
- (b) Central tidak memutuskan apa pun selain `agent.permission`, dan tidak yang `neverAutoReason`
  (R3, destruktif, push/deploy, secret, approval level/kontrol): eskalasi ke manusia.
- (c) Central tidak membuat aturan permanen ("Always allow"): hanya allow-once/deny. Hanya rute
  manusia yang bisa `always`, dan rute manusia menolak aktor `central`/`classifier`.
- (d) Tool hanya hidup di proyeksi Central (token MCP per giliran Central); node tidak bisa memanggilnya.
  Handler memeriksa percakapan Central yang sah, dan percakapan proyek hanya untuk proyeknya sendiri.
- Kartu yang sudah dieskalasi hanya bisa diputuskan manusia.

## Fallback anti-macet

Central mati / level terlalu rendah / check-in off / error saat mengantre -> eskalasi seketika.
Central tidak memutuskan dalam `CENTRAL_DECIDE_MS` (150 dtk) -> eskalasi. Eskalasi = kartu yang SAMA
muncul di Inbox dengan alasan di body-nya. Timeout hook (590 dtk) dan jalur "tanpa keputusan -> prompt
terminal Claude" tidak berubah. Tidak pernah auto-allow, tidak pernah menggantung.

## Transparansi

Tiap keputusan Central: event `permission.decision` (by `central`), event `auto.central_permission`
(Timeline) dan notice di chat Central (satu kalimat: agent, tool, keputusan, alasan <= 200 char,
disaring `redactSecrets`). Notice dibatasi `NOTICE_PER_HOUR` per jam (sisanya hanya event) supaya data
tidak bengkak. Kartu keputusan tetap terbaca di Settings > Rules (daftar izin terbaru) tempat manusia
bisa menjadikannya "Always block". Allow-once yang sudah jalan tidak bisa ditarik; override-nya adalah
aturan blokir untuk berikutnya. Tidak ada setting lain yang diubah diam-diam.

## Kompatibilitas

Default `central` berlaku untuk instalasi baru dan lama (kunci belum ada di data tersimpan -> default).
Nilai eksplisit `human` yang tersimpan dihormati. Tanpa perubahan schema (setting JSON).
