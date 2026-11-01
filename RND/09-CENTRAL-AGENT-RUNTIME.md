# 09: Runtime Agent Pusat (November 2026)

Tanggal: 2026-11-02 (+08:00). Status: **riset + bukti live, tanpa perubahan kode, tanpa commit**.
Batasan tetap: state otoritatif di ledger server, verifikasi server-owned, root token tidak masuk
env agent, runtime bisa diganti tanpa membongkar ledger.

**Perubahan keputusan (2026-11-02):** pengguna tidak punya langganan Claude, jadi runtime primary
adalah **OpenCode CLI** (`opencode run --format json`), bukan Claude Agent SDK. Claude Agent SDK /
Codex turun menjadi fallback opsional dan **tidak wajib** untuk MVP maupun gate.

## 1. Ringkasan keputusan

| Posisi | Pilihan | Alasan |
|---|---|---|
| **Primary** | **OpenCode CLI v2.0.26**, `opencode run --format json`, subprocess (bukan PTY) | Sudah terpasang, JSONL terstruktur, `--session` untuk resume, model via flag, tanpa langganan Claude |
| **Transport tool MVP** | **MCP server stdio lokal** yang didaftarkan lewat config OpenCode + **typed proposal protocol** untuk perubahan | Proses terpisah, jadi SDK MCP in-process tidak ada; stdio MCP memberi capability terpisah dari env agent |
| **Fallback** | Claude Agent SDK / `codex exec --json` | Opsional; dipakai hanya bila OpenCode tidak tersedia |
| **Bukan central** | PTY node + prompt satu baris | Tanpa event terstruktur, tanpa cancellation primitive, output dipotong 64 KiB |
| **Batas keras** | Central tidak spawn worker, tidak tulis fact/CORE, tidak menyetujui approval | Sama dengan `03-RENCANA.md` §7 |

Rekomendasi: satu port sempit `CentralRuntime` (turn, stream, cancel, resume, cost, close) dengan
adapter `OpenCodeRuntime` sebagai default, plus `MockRuntime` dan (opsional) `ClaudeAgentRuntime`.
Route HTTP tidak pernah memanggil CLI langsung.

## 2. Kondisi webterm yang mengikat pilihan

| Area | Fakta | Konsekuensi |
|---|---|---|
| PTY | `Bun.spawn({ terminal })` POSIX; satu slot per sesi (`src/server/pty.ts`, `sessionsCore.ts`) | Central memakai subprocess biasa, bukan slot PTY manusia |
| Env anak | `ptyEnv` membuang `WEBTERM_*`, `NODETERM_*`, `PORT`, `HOST`, `BUN_*` | Jalur OpenCode wajib allowlist serupa (`agentEnv.ts`) |
| Status `done` | Dari hook `Stop`/`StopFailure` (`hookStatus.ts`) | Tidak berlaku untuk OpenCode; status turn dari event runtime + exit code |
| Worker | Prompt satu baris cap 8 KiB, output 64 KiB, poll 250 ms, timeout 300 s (`workerRuntime.ts`) | Cukup leaf worker, tidak cukup central multi-turn |
| Central | Proyeksi + pause/resume/priority + scheduler 1 item/tick (`central/*`, `centralAutonomy.ts`) | Central belum punya "otak" |
| Build | `bun build --compile` → binary tunggal (`package.json`) | OpenCode adalah binary eksternal; **tidak** di-embed, di-resolve lewat `WEBTERM_OPENCODE_BIN` |

## 3. OpenCode CLI: bukti live (2026-11-02)

Dijalankan di repo ini, tanpa menampilkan nilai kredensial apa pun.

| Cek | Perintah | Hasil |
|---|---|---|
| Binary | `command -v opencode` | `/opt/homebrew/bin/opencode` |
| Versi | `opencode --version` | `2.0.26` |
| Turn teks | `opencode run --format json --model opencode/deepseek-v4.1-flash-free "Reply with exactly: OK"` | exit 0, JSONL `step_start` + `text` (`"OK"`), **tanpa** `step_finish` penutup |
| Tool use | `opencode run --format json --auto --model ... "shell: echo webterm-open-code-ok"` | `tool_use` `tool:"shell"`, `state.status:"completed"`, `exit:0`, output `webterm-open-code-ok`; lalu `step_finish` `reason:"tool-calls"`, `cost:0`, `tokens{input:46,output:44,cache.read:16512}` |
| Resume flag | `opencode run --session ses_webtermprobe01 ...` | `sessionID` yang dipakai **sama persis** dengan id yang dikirim (create-if-missing dikonfirmasi). Recall lintas proses **belum terverifikasi** (kena kuota) |
| Error shape | turn ke-5+ | event `{"type":"error","error":{"type":"provider.quota","status":429,...}}`, exit code **1** |
| Kuota model gratis | 4 turn pendek lalu 429 `FreeUsageLimitError` | Model gratis hanya untuk dev/demo; produksi wajib set `WEBTERM_CENTRAL_MODEL` ke provider ber-kredensial |
| MCP | `opencode mcp list` | mendukung server **local (stdio)** dengan `environment` + `cwd` + `timeout` |

Bentuk event: `step_start`, `text`, `tool_use`, `step_finish`, `error` (kutipan di
`RND/14-CENTRAL-AGENT-S0.md` §6).

**Temuan penting:** untuk jawaban satu langkah, `step_finish` terakhir **tidak dikirim**.
Turn harus ditutup oleh **exit proses**, bukan oleh `step_finish`. `step_finish` hanya andal
sebagai penanda akhir langkah ber-tool. Konsekuensi: biaya/token adalah jumlah `step_finish` yang
teramati, jadi bisa **undercount**; jangan klaim presisi.

## 4. Antarmuka CLI yang dipakai

```
opencode run --format json \
  --model "$WEBTERM_CENTRAL_MODEL" \
  --session "$sessionRef" \
  [--standalone] \
  "$prompt"
```

| Flag/opsi | Fakta (v2.0.26 `--help`) | Catatan desain |
|---|---|---|
| `--format json` | JSONL ke stdout, log ke stderr | Satu baris = satu event; parser streaming, bukan buffer penuh |
| `--session, -s` | "Session ID to continue, or to create if it does not exist" | Nilai = `session_ref` di ledger; create-if-missing membuat retry aman |
| `--model, -m` | `provider/model#variant` | Dari `WEBTERM_CENTRAL_MODEL`; **jangan** hardcode |
| `--standalone` | "private server instead of the background service" | Opsional; isolasi lebih baik, latensi lebih tinggi. Adapter saat ini **tidak** memakainya (pakai service background) |
| `--auto` | "Auto-approve permissions that are not explicitly denied" | **Jangan** dipakai di produksi; hanya probe. Produksi pakai `permission` eksplisit di config |
| `--continue` | lanjut sesi terakhir | Tidak dipakai: ambigu antar conversation |
| `--agent` | pilih agent | Kandidat untuk persona central; belum dipakai |

Tidak ada flag `--max-turns`, `--max-budget`, atau `--json-schema` di `run`. Artinya **anggaran
dan batas turn ditegakkan webterm** dengan menghitung event dan membunuh proses (lihat §6).

## 5. Konfigurasi OpenCode yang di-inject

OpenCode membaca config berlapis: global → `OPENCODE_CONFIG` (custom) → `opencode.json` project →
`.opencode` → `OPENCODE_CONFIG_CONTENT` (inline). Semua key di-merge, bukan diganti.

Pilihan webterm: **`OPENCODE_CONFIG_CONTENT`** (JSON inline, precedence tertinggi di antara
config standar, tanpa menulis file) atau **`OPENCODE_CONFIG`** (path file `0600` di state dir
webterm). **Jangan** menulis `opencode.json` ke worktree pengguna.

> **Belum terverifikasi:** adapter juga menyetel env `OPENCODE_PERMISSION` (JSON
> `{bash:"deny",edit:"deny",...}`). Env itu **tidak** ada di dokumentasi OpenCode 2026-11-02,
> jadi jangan dijadikan satu-satunya pengaman. Gate B2 wajib membuktikan `bash` benar-benar gagal;
> kalau tidak, pakai `permission`/`tools` di `OPENCODE_CONFIG_CONTENT` dan hapus asumsi env itu.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,          // versi tidak berubah di tengah run
  "snapshot": false,            // jangan buat git internal di worktree
  "subagent_depth": 0,          // central tidak boleh spawn agen (I5)
  "tools": { "bash": false, "edit": false, "write": false, "patch": false },
  "mcp": {
    "webterm": {
      "type": "local",
      "command": ["bun", "/abs/path/centralMcpServer.js"],
      "cwd": "/abs/path/webterm",
      "environment": { "WEBTERM_CENTRAL_CAP": "wcap_..." },  // tidak di prompt/event
      "timeout": 120000                                      // default 30 s terlalu pendek
    }
  }
}
```

- `tools` false untuk `bash`/`edit`/`write` menjaga central **read-only** di MVP. Kalau nanti
  `bash` dibuka, `--auto` tetap dilarang; izin harus eksplisit di `permission`.
- `subagent_depth: 0` menutup jalur "central membuat agen".
- Token capability hanya hidup di env proses MCP (anak dari OpenCode), bukan di env agent, prompt,
  atau event. Prompt hanya berisi data; capability ditegakkan server MCP per call.
- Global config pengguna tetap ikut termerge (model/provider/kredensial). Itu disengaja:
  kredensial milik pengguna, bukan milik webterm. `agentEnv` tetap tidak membawa `WEBTERM_TOKEN`.

## 6. Operasional

| Aspek | Aturan |
|---|---|
| **Session state** | `--session <session_ref>`; `session_ref` disimpan di `central_turn`/conversation. OpenCode menyimpan sesi di data dir-nya (`~/.local/share/opencode`), jadi proses butuh `HOME`/`XDG_DATA_HOME`; itu bukan root token webterm. Kebenaran state tetap ledger; sesi OpenCode hanya konteks. Satu sesi per `(projectId, threadId)`. |
| **Streaming** | Parser JSONL baris-per-baris atas stdout. `text` → `text.delta`/`part.completed`; `tool_use` → `tool.requested`+`tool.completed` (satu event membawa `state.status`); `step_start`/`step_finish` → `turn.step`; `error` → `error`. Petakan ke event bus → SSE. Buffer bounded; drop-oldest hanya untuk delta. |
| **Penutupan turn** | **Exit proses** = akhir turn. `step_finish` terakhir tidak dijamin ada (§3). `error` event menang atas exit code 0; exit code 1 tanpa `error` tetap `failed` dengan kode generik. |
| **Cancellation** | Kill process group: SIGTERM, tunggu <2 s, lalu SIGKILL. Idempoten lewat `cancelToken`. Teks parsial = akumulasi `text` sampai kill. Event final `cancelled` dikirim tepat sekali. Sesi OpenCode tetap ada sehingga retry bisa `--session` yang sama. |
| **Anggaran** | Hitung `step_finish` (jumlah langkah = turn budget) dan akumulasi `tokens`/`cost`. Lewat batas → kill + `budget_exhausted`, bukan retry. `cost` adalah estimasi; model gratis selalu `0`. |
| **Retry** | Hanya kegagalan sebelum efek non-idempoten, atau setelah event final. `provider.quota` (429), 401, dan error config = eskalasi manusia, **bukan** retry. Idempotensi tetap `requestId` + ack store. |
| **Biaya** | `step_finish.part.cost` + `tokens{input,output,reasoning,cache}` per langkah; simpan `run_id`, provider, model, token, `cost_usd`, `cost_basis:"client_estimate"`, `duration_ms`, outcome. Undercount bila `step_finish` penutup hilang. |
| **Auth** | Milik OpenCode: `opencode auth login` / kredensial provider di config pengguna, atau env provider. Webterm tidak menyimpan API key; `WEBTERM_CENTRAL_MODEL` hanya menyebut model. Bila model butuh kuota berbayar/gratis habis, runtime melaporkan `provider_quota` dan berhenti. |
| **Isolasi proses** | Tanpa PTY. `cwd` = worktree project atau state dir; `--standalone` opsional untuk isolasi penuh. Jangan `env: process.env`; bangun `agentEnv` dari allowlist. |

## 7. Fit dengan webterm: PTY vs subprocess vs MCP

| Aspek | PTY | Subprocess CLI (OpenCode) | MCP |
|---|---|---|---|
| Stream | ANSI + scrape | JSONL event | JSON-RPC |
| Cancel | `\x03` + exit | kill proses (`SIGTERM`→`SIGKILL`) | Tutup stream / `cancelled` |
| Multi-turn | Ketik baris baru | `--session` | Stateless per call |
| Prompt | 8 KiB satu baris | Argv/string penuh | Argumen tool |
| Approval | Hook `PermissionRequest` | `permission` config + `needs_approval` dari tool | `needs_approval` |
| Visibilitas | Terminal xterm | Panel event + transcript | Tak terlihat |
| Root token | Dibuang `ptyEnv` | Allowlist manual | Hanya env proses MCP |
| Biaya | Tak terukur | `step_finish` (estimasi) | Tidak relevan |

**7.1 Root token dan capability.** `agentEnv` dibangun dari allowlist: `PATH`, `HOME` (atau
`XDG_DATA_HOME`/`XDG_CONFIG_HOME` ke dir ter-scope), `SHELL`, `LANG`, `TERM`, `TMPDIR`,
`OPENCODE_CONFIG`, plus kredensial provider yang memang milik OpenCode. Buang `WEBTERM_*`
(kecuali yang eksplisit), `NODETERM_*`, `PORT`, `HOST`, `BUN_*`. Token node tidak diberikan:
token itu membuka `/api/control/*`. Central memakai capability sendiri (`wcap_*`, TTL pendek,
resource-bound): `central.read`, `project.read`, `task.assign`, `run.request`, `memory.claim`;
**tidak** `approval.decide`, `memory.promote`, `node.prompt` lintas node, `run.finish`.
Approval manusia tetap lewat `/api/approvals/*`. Audit tiap tool call sebagai `central.tool`.

**7.2 Offline/local-first.** Ledger, session map, memory, worktree lokal; hanya inference yang
butuh jaringan. Jangan taruh central di cloud queue atau jadikan MCP HTTP wajib.

## 8. MCP dan protokol proposal (pilihan MVP)

Karena OpenCode adalah proses terpisah, `createSdkMcpServer()` (in-process) **tidak tersedia**.
Dua opsi yang realistis:

1. **MCP stdio lokal (dipilih untuk tool baca).** Daftarkan server `webterm` di config runtime
   (§5). OpenCode menjalankan server itu sebagai anak dan mengekspos tool-nya ke model. Capability
   hanya di env server; hasil tool dibatasi ringkasan + id (bukan dump), dan tool yang butuh
   manusia mengembalikan `needs_approval`.
   - Nama tool yang dilihat model diturunkan dari nama server MCP. **Jangan asumsikan**
     `mcp__webterm__<tool>` seperti SDK; catat nama sebenarnya pada test integrasi pertama dan
     pakai itu di prompt sistem/allowlist.
   - `timeout` default 30 s terlalu pendek; set eksplisit (mis. 120 s).
2. **Typed proposal protocol (dipilih untuk perubahan).** Model mengembalikan satu blok JSON
   ber-delimiter (mis. ` ```webterm-proposal `) dengan skema ketat: `{kind:"goal.propose"|"plan.propose",
   payload:{...}}`. Server memvalidasi dengan Zod, menolak field terlarang (`actor`, `authority`,
   `status`, path absolut, command bebas), lalu menyimpan **draft** `proposed` dengan efek nol.
   Parse gagal = `proposal_invalid`, bukan tebakan.

**Yang belum diimplementasikan:** tidak ada tool tulis nyata. `goal.propose`/`plan.propose` di MVP
hanya menghasilkan draft lewat protokol proposal; `task.assign`/`task.run` tetap milik fase B3 dan
tetap butuh capability + approval. Dokumen ini **tidak** mengklaim tool tulis sudah ada.

Keamanan tambahan: deskripsi tool di-pin (`tools_hash`); hash berubah tanpa review = tolak
(rug pull). Jangan mengaktifkan MCP remote untuk central.

## 9. Arsitektur yang diusulkan (belum diimplementasikan)

```
POST /api/central/turn
   └─► centralTurnRoute ─► CentralRuntime (port)
                            ├─ OpenCodeRuntime: spawn `opencode run --format json`
                            ├─ MockRuntime
                            └─ ClaudeAgentRuntime (opsional, tidak wajib)
         mapJsonlEvents ─► event bus ─► SSE (panel) + ledger event
                            └─► centralMcpServer (stdio) ◄─ capability wcap_*
```

| File | Isi |
|---|---|
| `central/runtime/centralRuntimeTypes.ts` | `CentralRuntime`, `TurnInput`, `RuntimeEvent`, `RuntimeResult`, `CancelToken` |
| `central/runtime/opencodeRuntime.ts` | spawn, parser JSONL, exit/error, cancel, resume, budget |
| `central/runtime/opencodeOptions.ts` | argv (`run --format json --model --session`), scrub env, policy tool |
| `central/runtime/opencodeEvents.ts` | murni: JSONL → event internal + usage delta |
| `central/runtime/agentEnv.ts` | allowlist env; buang `WEBTERM_*`/`NODETERM_*`/`PORT`/`HOST` |
| `central/runtime/runtimeEvents.ts` | normalisasi event + urutan |
| `central/runtime/centralSession.ts` | peta `(projectId, threadId) → sessionRef`, persist di ledger |
| `central/mcp/centralMcpServer.ts` | server stdio; validasi capability per call; audit |
| `central/proposal/proposalParser.ts` | blok JSON ber-delimiter → draft tervalidasi |
| `central/runtime/centralBudget.ts` | akumulasi `step_finish`, kill saat lewat batas |

Flag: `WEBTERM_CENTRAL_RUNTIME=off|mock|opencode|claude|codex` (default `off`), `WEBTERM_CENTRAL_MODEL`
(default `opencode/deepseek-v4.1-flash-free` untuk dev), `WEBTERM_OPENCODE_BIN` (default
`opencode`), `WEBTERM_OPENCODE_ALLOW_TOOLS` (default off; hanya `on` membuka tool mutasi).
Terpisah dari `WEBTERM_CENTRAL` (proyeksi) dan `WEBTERM_CENTRAL_AUTONOMY` (scheduler).
Tanpa ledger hidup, runtime menolak boot.

## 10. Tabel keputusan

| Kriteria | OpenCode CLI | Claude Agent SDK | Codex `exec --json` | `opencode serve` |
|---|---|---|---|---|
| Butuh langganan | Tidak (free model / provider sendiri) | Login/API key Claude | Login/API key | Tidak |
| Streaming | JSONL per event | Message + `stream_event` | JSONL per item | SSE `/event` |
| Tool | Built-in + MCP stdio/remote | Built-in + MCP in-process | Built-in + MCP | Internal + MCP |
| Approval | `permission` config; `--auto` ada tapi dilarang | `canUseTool`, hooks | Sandbox + approval policy | `permission` endpoint |
| Cost | `step_finish.cost`/`tokens` (bisa undercount) | `total_cost_usd`, `modelUsage` | `turn.completed.usage` | Tidak seragam |
| Resume | `--session` (create-if-missing) | `resume`/`continue`/`fork` | `thread_id` | Session id |
| Ops | Proses anak, tanpa embed, versi dipin | Proses anak + binary di-embed | Proses anak, ringan | Server + port |
| Bun | Parser murni, tanpa dependency | Import lulus, compile perlu `extractFromBunfs` | Proses anak | HTTP client |
| Verdict | **Primary** | Fallback opsional | Fallback opsional | Adapter lanjutan |

## 11. Risiko dan mitigasi

| Risiko | Bukti | Mitigasi |
|---|---|---|
| Kuota model gratis habis | 429 `FreeUsageLimitError` setelah 4 turn (2026-11-02) | Default gratis hanya dev; pesan `provider_quota` jelas; jangan retry; dokumentasikan set model berbayar |
| `step_finish` penutup hilang | 2/2 turn satu langkah tanpa `step_finish` | Tutup turn dari exit proses; jangan tunggu event |
| Item JSONL sangat besar | `tool_use` membawa `output` + `metadata.content` duplikat | Batasi ukuran part; ringkas ke ledger; buang `rawInput`/duplikat |
| Config global pengguna bocor ke central | Merge config global | Config eksplisit + `tools` false + review config efektif saat boot |
| Tool bawaan tak sengaja aktif | `bash`/`edit`/`write` default bisa aktif | `tools:false` + deny policy; gate B2 membuktikan `bash` gagal |
| Env var tak terdokumentasi | `OPENCODE_PERMISSION` tak ada di docs 2026-11-02 | Verifikasi di gate; fallback ke config; jangan bergantung pada satu mekanisme |
| Nama tool MCP berubah antar versi | Prefix dari nama server, bukan `mcp__` | Catat nama nyata; feature-detect; pin versi OpenCode |
| Versi OpenCode berubah | `autoupdate` default notify | `autoupdate:false` + pin versi di dokumentasi rilis |
| Sesi OpenCode di luar ledger | Data dir OpenCode | `session_ref` di ledger; sesi hanya konteks; jangan jadikan sumber kebenaran |

## 12. Gate sebelum implementasi dianggap selesai

1. Satu turn OpenCode nyata (model ber-kredensial) → teks + `session_ref` + usage tercatat.
2. Satu tool MCP stdio dipanggil; capability salah ditolak; tidak ada token di env agent.
3. Cancel menutup proses <2 s dan event final terkirim tepat sekali.
4. Resume `--session` setelah restart menghasilkan konteks lanjut (butuh verifikasi, §3).
5. `agentEnv` tanpa `WEBTERM_TOKEN`/`NODETERM_*` (assertion test).
6. Budget/turn limit membunuh proses dan menulis `budget_exhausted`, bukan retry.
7. `provider.quota`/401 dieskalasi ke manusia, bukan retry.
8. `bash`/`edit`/`write` benar-benar nonaktif dan gagal saat dipanggil (bukan hanya absen dari
dokumentasi); buktikan mekanisme yang dipakai benar-benar ditegakkan CLI.
9. Binary `bun build --compile` tetap jalan; OpenCode **tidak** di-embed, hanya di-resolve.

## 13. Sumber (diakses 2026-11-02)

- OpenCode config (lokasi, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `tools`, `permission`,
  `subagent_depth`, `snapshot`): https://opencode.ai/docs/config/
- OpenCode MCP (local stdio, `environment`, `cwd`, `timeout`): https://opencode.ai/docs/mcp-servers/
- OpenCode server/API (adapter lanjutan): https://opencode.ai/docs/server/
- Bukti lokal CLI: `opencode --version` 2.0.26, `opencode run --help`, `opencode mcp add --help`,
  `opencode debug paths|config` (2026-11-02).

Rujukan lama (fallback/konteks, tidak lagi wajib):
- Claude Agent SDK: https://docs.claude.com/en/docs/agent-sdk/overview
- Codex non-interactive: https://developers.openai.com/codex/non-interactive-mode

Bukti repo: `RND/14-CENTRAL-AGENT-S0.md` §6 (S0 + probe OpenCode), `RND/03-RENCANA.md` §7
(batas central), `RND/08-CENTRAL-AGENT.md` (invarian).
