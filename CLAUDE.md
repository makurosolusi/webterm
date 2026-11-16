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
- nama event/channel `webterm:*`
- data dir: `WEBTERM_DATA_DIR` (default `~/.webterm-server`)

Transisi: server masih MENERIMA nama lama (env/header) selama masa transisi, tetapi hanya MENERBITKAN
nama baru. Data dir warisan hanya dibaca sebagai fallback migrasi satu arah ke data dir webterm.
Jangan memperkenalkan lagi nama lama di kode atau dokumen baru.

## Menjalankan

- Dev: `bun run dev` → `http://127.0.0.1:8700`. Vite HMR untuk edit client; edit server perlu restart.
- Port: `PORT` (default `8700`). Data dir: `WEBTERM_DATA_DIR` (default `~/.webterm-server`, DB `webterm.db`).
- Produksi: `vite build` lalu `NODE_ENV=production bun src/server/index.ts`.

## Verifikasi (gerbang korektness)

- `TMPDIR=/tmp/st npm run typecheck` — `tsc --noEmit`. Gate tercepat.
- `TMPDIR=/tmp/st npm test` — vitest (`vitest run`, node-env default, test DOM per-file via pragma `/** @vitest-environment jsdom */`).
- `TMPDIR=/tmp/st npm run test:bun` — semua `src/server/**/*.bun.test.ts` termasuk subfolder (round-trip PTY,
  store SQLite, ledger, API workspace, operasi fs), lewat `find` karena `bun test` tidak mengenal glob
  `**` (argumennya filter substring). Penemuan otomatis, bukan daftar nama: daftar nama basi tanpa
  pernah merah.
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
- Verifikasi (typecheck + test) sebelum klaim "selesai".
- Ambigu desain/perilaku → tiru pola yang terbukti jalan, jangan invent.
- Aturan global berlaku dari `~/.claude/CLAUDE.md`.
