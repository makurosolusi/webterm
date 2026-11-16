# Persetujuan dari UI, kredensial agent ditolak

> **Superseded** by [ui-session-cookie.md](ui-session-cookie.md): fetch metadata alone no longer proves
> the webterm page; human-only routes now also need the HttpOnly `wt_ui` session cookie, and loopback is
> always credentialed. Kept for the history of the decision.

Kode: `src/server/approvalAuth.ts` (`uiOnlyDenial`), dipakai `/api/approvals*` (`approvalHumanApi.ts`) dan
`POST /api/settings/token/enable|rotate` (`tokenAccess.api.ts`).

## Konteks

Persetujuan manusia (approval card, review task) adalah satu-satunya rem untuk aksi agent yang tak bisa dibatalkan.
Sebelumnya rute ini menolak loopback tanpa token kecuali `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1`. Akibatnya, di setup
default (loopback, tanpa token) tombol Setujui di UI webterm tidak jalan sama sekali, dan pengguna disuruh mengisi
flag env. Itu melanggar prinsip zero-config, padahal yang perlu dicegah sebenarnya bukan "loopback", tapi "agent
menyetujui aksinya sendiri".

## Keputusan

1. **Kredensial agent = tolak** (`403 agent_cannot_approve`). Header capability, atau token transport yang ternyata
   token node (PTY agent menerima `WEBTERM_TOKEN` = token node-nya), menandai pemanggil sebagai sesi agent.
2. **Wajib asal browser** (`403 approval_browser_only`): `Sec-Fetch-Site: same-origin` DAN `Origin` sama dengan
   `Host` (`sameOrigin()`). Halaman web tidak bisa memalsukan fetch metadata; curl biasa tidak mengirimnya.
3. Gerbang transport luar tetap jalan lebih dulu: bila root token aktif, token itu tetap wajib.
4. `WEBTERM_ALLOW_LOOPBACK_APPROVAL` dihapus (registry, `.env.example`, kunci bootstrap). Aktifkan/rotasi token juga
   UI-only, kalau tidak shell agent cukup dua curl untuk mencetak token sendiri lalu menyetujui aksinya sendiri.

## Referensi

- Orca `rpc-caller-scope`: jenis kredensial pemanggil menentukan scope; scope agent tidak pernah mencapai gerbang manusia.
- referensi eksternal `control-confirm` + `origin.ts`: konfirmasi hanya dari UI, cek Origin sama dengan Host (`sameOrigin()` di
  sini adalah cerminnya).
- Jupyter Server XSRF/Origin check: perlindungan bertumpu pada fakta yang sama, browser tidak bisa memalsukan header
  terlarang lintas situs.

## Model ancaman dan risiko yang diterima

- Tertutup: agent yang memakai kredensial yang diberikan kepadanya (token node, capability), curl polos dari shell
  agent, halaman asing di browser (cross-site).
- **Risiko yang diterima:** `Sec-Fetch-Site` hanya terlarang bagi browser. Proses dengan uid yang sama yang SENGAJA
  memalsukan header itu (dan tidak mengirim token node-nya) tetap lolos. Proses lokal yang bermusuhan di uid yang sama
  bisa juga membaca DB dan file rahasia, jadi gerbang ini tidak menjanjikan lebih. Penutup penuh: aktifkan root token
  (gerbang luar), atau langkah konfirmasi yang terikat sesi UI ala referensi eksternal control-confirm.
- **Butir `/ws` dan `/ws/browser` (ditutup):** upgrade kanal manusia, yaitu PTY `/ws` dan stream node Browser
  `/ws/browser`, tanpa root token kini wajib membawa `Origin` yang sama dengan `Host` (`src/server/wsOrigin.ts`,
  dipasang di `index.ts` setelah `allowed()` dan sebelum cabang browser). Tanpa Origin (curl, shell agent) ditolak
  `403 origin_required`. Tiruan referensi eksternal `ws.ts` `upgradeAllowed` (kredensial + `sameOriginRequest`) dan Jupyter
  `check_origin` (Origin + token wajib): di bind tanpa token, Origin yang hadir adalah satu-satunya bukti pemanggil
  adalah UI. Tak ada konsumen non-browser sah untuk kedua jalur: token node memang sudah ditolak di sana, dan agent
  mengendalikan browser lewat `/api/control/browser/*` (shim `webterm-browser`), bukan `/ws/browser`. Smoke manual
  `scripts/browser-smoke.ts` kini mengirim `Origin` halaman webterm. Dengan root token aktif perilaku tak berubah.
  Risiko yang diterima sama: proses lokal yang sengaja memalsukan `Origin` tetap lolos; penutup penuh tetap root token.
