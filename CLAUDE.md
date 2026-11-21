# CLAUDE.md

Panduan singkat bekerja di repo **webterm**. Sengaja ramping.

## Apa ini

**webterm** — node-based terminal manager untuk web channel: banyak shell nyata jadi node
xterm drag-able di canvas pan/zoom (React Flow v12). Tiap workspace (nama + cwd + layout)
dipersist server-side di SQLite (`bun:sqlite`), jadi board bertahan lintas restart. Berbasis
**Bun** (`src/client` + `src/server` + `src/shared`, TANPA `src/core`). webterm dibuat dari
nol sebagai project baru, hanya terinspirasi terminal manager mapan; bukan fork dan bukan turunan.

## Identitas & nama protokol

Identitas = `webterm` sepenuhnya. Nama protokol (agent <-> server):

- env sesi agent `WEBTERM_NODE_ID`, `WEBTERM_PORT`, `WEBTERM_NODE_TOKEN`; header `x-webterm-node-token`
- sentinel/nama event/channel `webterm:*` (mis. `webterm:too-large:`)
- data dir: `WEBTERM_DATA_DIR` (default `~/.webterm-server`)

Nama lama `nodeterm` hanya tersisa sebagai **fallback penerimaan sementara** (header token, env di
shell `webterm browser/context`, prefiks too-large, prefiks catatan `[nodeterm]`, prefiks env yang
di-scrub), tiap titik ditandai komentar `legacy:` dengan batas "remove after 0.10.0". Server hanya
MENERBITKAN nama baru; sesi yang sudah berjalan memakai env lamanya sampai selesai. Jangan hapus
fallback itu sebelum 0.10.0 tanpa perintah eksplisit, dan jangan memperkenalkan lagi nama lama di
kode atau dokumen baru.

Tidak ada migrasi data dir: kode tidak pernah membaca `~/.nodeterm` / `~/.nodeterm-server`; hanya
`WEBTERM_DATA_DIR` yang dipakai.

## Menjalankan

- Dev: `bun run dev` → `http://127.0.0.1:8700`. Vite HMR untuk edit client; edit server perlu restart.
- Port: `PORT` (default `8700`). Data dir: `WEBTERM_DATA_DIR` (default `~/.webterm-server`, DB `webterm.db`).
- Produksi: `vite build` lalu `NODE_ENV=production bun src/server/index.ts`.

## Verifikasi (gerbang korektness)

- `TMPDIR=/tmp/st npm run typecheck` — `tsc --noEmit`. Gate tercepat.
- `TMPDIR=/tmp/st npm run test:all` (pemilik) — vitest (`vitest run`, node-env default, test DOM per-file via pragma `/** @vitest-environment jsdom */`).
- `TMPDIR=/tmp/st npm run test:bun:all` (pemilik) — semua `src/server/**/*.bun.test.ts` termasuk subfolder (round-trip PTY,
  store SQLite, ledger, API workspace, operasi fs), lewat `find` karena `bun test` tidak mengenal glob
  `**` (argumennya filter substring). Penemuan otomatis, bukan daftar nama: daftar nama basi tanpa
  pernah merah.
- **Tier harian = `typecheck` + `TMPDIR=/tmp/st npm run test:impacted`** (tes vitest terkait, tes bun yang
  mengimpor file berubah, dan tier policy: tes pemindai `src/` dari `scripts/test.policy.manifest.ts`).
  `test:related`/`test:changed` tetap ada tetapi vitest-saja; jangan andalkan keduanya.
- **Suite penuh = perintah khusus dan jelas dari pemilik, per eksekusi.** `npm test`, `npm run test:bun`,
  `vitest run` tanpa filter, dan `bun test` tanpa path menolak jalan (exit 2).
  1. Satu-satunya pemicu sah: pemilik menulis di pesannya sendiri `jalankan full test` (atau `jalankan suite penuh`),
     ATAU menyebut nama perintahnya (`npm run test:all` / `npm run test:bun:all`). Kata lain TIDAK cukup: "cek
     semuanya", "pastikan lulus", "tes", "verifikasi", "selesaikan", "lanjut", "ya", "gate", "test:impacted",
     persetujuan atas usulan agent, atau izin lebar/umum (mis. "semua izin diberikan").
  2. Berlaku untuk SATU eksekusi di pesan itu saja; tidak menurun ke pesan berikutnya, worker, atau sesi lain.
  3. Agent boleh MENGUSULKAN ("Mau saya jalankan full test?"), dilarang menjalankannya sebelum frasa itu datang;
     sebelum menjalankan, agent mengutip frasa pemilik yang memicunya.
  4. Dilarang bagi agent/worker/orkestrator: menyetel `WEBTERM_FULL_TESTS=1` (hanya pemilik/CI), memanggil `vitest run`/
     `bun test` tanpa filter, atau menyiasatinya (merangkai `--files` ratusan berkas, `WEBTERM_ALLOW_WIDE_GATE=1`
     untuk mensimulasikan suite penuh, loop yang menjalankan semua berkas). Gate harian yang melebar bukan jalan
     pintas suite penuh.
  5. Bukti suite penuh harian = CI (`.github/workflows/test.yml`) setelah push; agent membaca hasilnya (`gh run`),
     bukan menjalankannya lokal.
  6. Worker: dilarang mutlak; spec worker memuat larangan ini dan jalur terfokus (`--files`).

  | Situasi | Yang dijalankan |
  |---|---|
  | Perubahan kecil | `typecheck` + `test:impacted` |
  | Perubahan hub lebar (mis. envRegistry) | orkestrator saja, satu gate lebar sekali |
  | Pemilik menulis frasa persis di atas | suite penuh (sekali) |
  | Setelah push | baca hasil CI (`gh run`) |

  Detail: `docs/testing.md`.
- **Hanya satu gate (`test:impacted`) berjalan sekaligus di mesin** (kunci `/tmp/webterm-test-gate.lock`; gate lain keluar kode 3, atau antri dengan `--wait <menit>`). Plan >120 berkas ditolak (exit 2, mendekati suite penuh): pecah kerja dan pakai `--files <tes-terkait>`; `--budget <menit>` membatasi waktu. `WEBTERM_ALLOW_WIDE_GATE=1` hanya untuk orkestrator pada gate yang memang berdampak lebar (hub), bukan untuk 'mengetes semuanya'; agent/worker dilarang menyetelnya. Detail: `docs/testing.md`.
- Tes pemindai baru wajib didaftarkan di `scripts/test.policy.manifest.ts` (tes manifes gagal bila tidak).
- **Jebakan macOS:** test bind unix socket di `$TMPDIR`; path default bisa >104 char (batas
  `sun_path`) → `EINVAL`. Jalankan dengan `TMPDIR=/tmp/st`.

## Struktur

- `src/client` — UI React (canvas React Flow, node chrome, dock); harness test DOM `canvasHarness.tsx`.
- `src/server` — proses Bun (entry `index.ts`): HTTP + WebSocket, sesi PTY nyata, workspace di
  SQLite, auth token node, operasi fs, pengaturan, hook status agent.
- `src/shared` — tipe & util yang dipakai bersama client dan server.

## Aturan rumah

- JANGAN push/deploy/merge tanpa perintah eksplisit di pesan yang sama.
- Fitur baru → branch sendiri (`feature/`/`fix/`/`chore/<nama>`) + test nyata; tunggu konfirmasi sebelum merge.
- Kurungan canvas: tak ada tab/jendela di browser mesin kecuali aksi eksplisit "Open in system browser" (`openLinkInCanvas`/`ExternalLink` di client); pintu keluar baru ditolak oleh `src/shared/containment.policy.test.ts`, aturan di `docs/decisions/canvas-containment.md`.
- Verifikasi (typecheck + test) sebelum klaim "selesai".
- Ambigu desain/perilaku → tiru pola yang terbukti jalan, jangan invent.
- Aturan global berlaku dari `~/.claude/CLAUDE.md`.
