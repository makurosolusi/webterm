# CLAUDE.md

Panduan singkat bekerja di repo **webterm**. Sengaja ramping.

## Apa ini

**webterm** — node-based terminal manager untuk web channel: banyak shell nyata jadi node
xterm drag-able di canvas pan/zoom (React Flow v12). Tiap workspace (nama + cwd + layout)
dipersist server-side di SQLite (`bun:sqlite`), jadi board bertahan lintas restart. Rewrite
ramping berbasis **Bun** dari nodeterm (`src/client` + `src/server` + `src/shared`, TANPA
`src/core`). Fork dari nodeterm upstream (lisensi **BUSL-1.1**).

## Identitas vs protokol (PENTING)

webterm entitas berbeda dari nodeterm (nodeterm disempurnakan untuk kebutuhan web channel).
Permukaan **terlihat** pakai nama `webterm`. Yang **tetap `nodeterm`** demi wire-protocol &
kompat upstream — JANGAN rename tanpa perintah eksplisit:

- env var sesi agent `NODETERM_NODE_ID`, `NODETERM_PORT`; header `x-nodeterm-node-token`
- nama event/channel `nodeterm:`
- path data warisan `~/.nodeterm` / `~/.nodeterm-server` bila dirujuk protokol

Data dir webterm SENDIRI: `WEBTERM_DATA_DIR` (default `~/.webterm-server`).

## Menjalankan

- Dev: `bun run dev` → `http://127.0.0.1:8700`. Vite HMR untuk edit client; edit server perlu restart.
- Port: `PORT` (default `8700`). Data dir: `WEBTERM_DATA_DIR` (default `~/.webterm-server`, DB `webterm.db`).
- Produksi: `vite build` lalu `NODE_ENV=production bun src/server/index.ts`.

## Verifikasi (gerbang korektness)

- `TMPDIR=/tmp/st npm run typecheck` — `tsc --noEmit`. Gate tercepat.
- `TMPDIR=/tmp/st npm test` — vitest (`vitest run`, node-env default, test DOM per-file via pragma `/** @vitest-environment jsdom */`).
- `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts` — semua test Bun-only (round-trip PTY,
  store SQLite, API workspace, operasi fs). Glob, bukan daftar nama: daftar nama basi tanpa
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
- Ambigu desain/perilaku → tiru nodeterm (repo referensi), jangan invent.
- Aturan global berlaku dari `~/.claude/CLAUDE.md`.
