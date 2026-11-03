# 22 — CA2: Control plane agent (central hidupkan / perintah / pantau / tutup)

Status: R&D, 2026-11-03. Tanpa perubahan kode. Fakta = dibaca dari kode/sumber; **Opini** = penilaian saya.
Tag: `[V]` = sumber primer dibaca hari ini; `[B]` = belum terverifikasi.

## 1. Ringkasan rekomendasi (tegas)

1. **Revisi I5, bukan hapus.** Central tetap tidak memegang token/PTY. Central *mengusulkan* `agent.spawn|prompt|close|relay` dan `task.run`; **server** yang mengeksekusi dengan otoritas server, di balik guard (project, jumlah, budget, audit, kill-switch). Efek: central bisa "menghidupkan agent" tanpa I2/I3/I6 bocor.
2. **Urutan: `task.run` dulu (fase 1), `agent.*` ad-hoc kemudian.** `task.run` sudah dirancang R2 untuk central (`RND/08:96`) dan seluruh mesinnya ada (lease/fence, worktree, verifier server, approval). Yang kurang hanya wiring. **Opini:** ini 80% nilai untuk 20% kerja.
3. **Pakai jalur proposal bertipe** (`<webterm-proposal>`, sudah ada) sebagai antarmuka LLM, bukan native tool-calling. Jalan di model murah/gratis yang tool-calling-nya tidak andal; server yang memvalidasi.
4. **Dua runner**: PTY node (ada; terlihat di canvas) dan **exec headless** (baru, kecil; `opencode run --format json`, `codex exec --json`, `gemini -p --output-format json`) agar sinyal "selesai" deterministik untuk non-claude. Hari ini hook `done` hanya claude.
5. **Mailbox di ledger** (`agent_mail`) untuk `agent.relay`; pengiriman ke PTY hanya saat target idle; pesan selalu berenvelope "bukan manusia, bukan otoritas".
6. **Kill-switch tunggal** + flag `off|propose|auto` (default `propose`). Tanpa dependency baru.

## 2. Temuan + bukti

### 2a. Kode webterm (fakta)
| Temuan | Bukti |
|---|---|
| I5 "central tidak spawn; hanya `plan.assign` + `task.run` (request)" | `RND/08:29-30` |
| `task.run` central = R2, belum ada; `task.assign`/`task.run` belum diwire | `RND/08:96`, `:108` |
| Larangan §10 "central spawn worker, membuat agent…" | `RND/08:189` |
| Proposal diizinkan: goal.propose, plan.propose, task.assign, approval.request; kunci terlarang termasuk cwd/cmd/command/token/capability | `central/proposal/proposalPolicy.ts:9-10` |
| Runtime OpenCode: bash/edit/webfetch/task = deny | `central/runtime/opencodeOptions.ts:21-25` |
| Control API spawn/prompt/close/wait ada, idempotent per `requestId` | `control/controlApiSessions.ts:20,71,100,22,27`; `control/controlWait.ts:32` |
| Ack idempoten hanya memori: 10 menit/1000 entri | `control/controlTypes.ts:85,87` |
| `/api/control/plan` masih 501 | `control/controlApiQuery.ts:26` |
| Capability: TTL 15 mnt default, 60 mnt maks; mint butuh `WEBTERM_ALLOW_TOKEN_MINT=1` + root token | `control/capabilities.ts:76-78`, `control/mount.ts:61-62` |
| Control spawn **tidak** punya: ikatan project, hitung jumlah/depth, budget, audit | pembacaan `controlApiSessions.ts` (tidak ada referensi ke `caps`/audit) |
| `DEFAULT_CAPS`: 3 worker paralel, 3 attempt, lease 10 mnt, 200k token, 5.000.000 mikro-biaya, 40 turn, wall 30 mnt | `orchestrator/caps.ts:6-14` |
| `assertCanSpawn`: worker tidak boleh spawn; depth maks dijaga | `orchestrator/roles.ts:76-88` |
| Worker runtime: timeout default 300 s, poll 250 ms; selesai hanya bila status `done` atau exit | `orchestrator/workerRuntime.ts:41-42` |
| Status `done` diset saat exit; hook `--settings` hanya claude | `sessionsCore.ts:132-134`; `shared/workspace.ts:211` |
| Autonomy: tick 30 s, satu item ter-assign per tick, karantina setelah gagal berturut | `central/centralAutonomy.ts:1-5,72` |

**Akar penyebab (11-style):** central "hanya membalas chat" karena (a) tool runtime = read + proposal tanpa verb eksekusi, (b) `task.run` belum diwire, (c) kontrol spawn belum punya guard sehingga tak aman dibuka. Bukan karena PTY/spawn tak ada — itu sudah ada.

### 2b. Survei 2026 (sumber, dibaca 2026-11-03)
- **Claude Code Agent Teams** `[V]` https://code.claude.com/docs/en/agent-teams — eksperimental, mati default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Lead + teammate + task list bersama + **mailbox = file JSON per agen** (`~/.claude/teams/{team}/inboxes/{agent}.json`); klaim task pakai file locking; shutdown = *request* yang boleh ditolak; **tanpa tim bersarang**; pesan antar-agen ditandai "bukan dari user" dan **tidak bisa memberi persetujuan**; hook `TeammateIdle/TaskCreated/TaskCompleted`; keterbatasan: tak bisa resume, status task bisa telat, jangan dua agen edit file sama. Halaman memuat nomor versi v2.1.x (tanggal rilis tak tertera).
- **Claude Code subagents** `[V]` https://code.claude.com/docs/en/sub-agents (via curl) — frontmatter `tools`, `permissionMode`, `maxTurns` (hasil ditandai parsial), `isolation: worktree` (dibersihkan otomatis bila tak ada perubahan), `background`; nested dibatasi `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; tanpa tool `Agent` = tak bisa spawn; hook `SubagentStart/Stop`. Worktree: `git worktree lock` selama agen jalan https://code.claude.com/docs/en/worktrees.md `[V]`.
- **OpenAI Agents SDK** `[V]` https://openai.github.io/openai-agents-python/handoffs/ — `handoff()` dengan `on_handoff`, `input_type`, `input_filter`, `is_enabled`, `nest_handoff_history`; tool bernama `transfer_to_<agent>`. Rilis terakhir v0.24.0, 2026-10-15 (GitHub API) `[V]`. Handoff = pindah kendali; **bukan** model central (central tetap pemegang percakapan user).
- **LangGraph supervisor/swarm** — rilis terakhir `langgraph-supervisor 0.0.31` (2025-11-19) dan `langgraph-swarm 0.1.0` (2025-12-04) `[V]` (GitHub API). **Sumber lebih tua dari 2026**; isi pola `[B]` (tidak dibaca). Python; tidak dipakai.
- **OpenHands** — rilis v1.34.0, 2026-10-27 `[V]` (GitHub API). Arsitektur delegasi `[B]` (halaman runtime terunduh tapi tidak dianalisis).
- **A2A** `[V]` https://a2a-protocol.org/latest/specification/ — spec rilis 1.0.0; tag GitHub v1.0.1 (2026-05-28). Status task: terminal `COMPLETED/FAILED/CANCELED/REJECTED`, interupsi `INPUT_REQUIRED/AUTH_REQUIRED`; pesan ke task terminal ditolak; default blocking, `return_immediately` untuk non-blocking.
- **MCP Tasks** `[V]` https://modelcontextprotocol.io/specification/draft/basic/utilities/tasks — ekstensi `io.modelcontextprotocol/tasks`; handle `taskId` tahan-crash, `ttlMs`, `pollIntervalMs`, `tasks/get`, `tasks/update`; status `working/input_required/completed/failed/cancelled`. Halaman draft/ekstensi, **tanpa tanggal**.
- **OpenCode** `[V]` https://opencode.ai/docs/cli , https://opencode.ai/docs/server — `opencode run --format json`, `--session`, `--agent`, `--dir`, `--attach`; server OpenAPI 3.1: `POST /session/:id/prompt_async` (204), `POST /session/:id/abort`, `GET /session/status`, SSE `/event`, basic-auth `OPENCODE_SERVER_PASSWORD`. Versi tak tertera.
- **Codex CLI** `[V]` https://developers.openai.com/codex/noninteractive — `codex exec --json` (JSONL: `thread.started`, `turn.completed`, `turn.failed`, `item.*`, `error`), `-o` pesan akhir, `--sandbox workspace-write`, `exec resume`; `--full-auto` tidak lagi didukung; wajib repo git.
- **Gemini CLI** `[V]` https://google-gemini.github.io/gemini-cli/docs/cli/headless.html — `gemini -p`, `--output-format json` (+ statistik token). Contoh di halaman menyebut `gemini-2.5-pro` → **kemungkinan lebih tua dari 2026**, kebaruan diragukan.
- **Devin API v3** `[V]` https://docs.devin.ai/api-reference/overview — sesi per organisasi, `create_as_user_id`. Detail siklus hidup `[B]`.
- **Cursor background agents** `[B]` — halaman terunduh hanya berisi navigasi. **Orca orchestration** — hanya deskripsi skill lokal `/Users/bip/.agents/skills/orchestration/SKILL.md` `[V]` (thread, ask/reply, dispatch, `worker_done`/eskalasi, DAG, decision gate); dokumen web primer `[B]`.

**Pola yang konvergen (opini dari bukti di atas):** (1) satu lead memegang percakapan, worker punya konteks sendiri; (2) mailbox/task durable, bukan chat bebas; (3) state task kecil & eksplisit (A2A/MCP Tasks, mirip `AgentStatus`); (4) pesan antar-agen = data, tak pernah persetujuan; (5) isolasi worktree + kepemilikan file; (6) shutdown = permintaan dengan batas waktu, lalu paksa.

## 3. Opsi dipertimbangkan

| Opsi | Ditolak/dipilih | Alasan |
|---|---|---|
| A. Central pegang `wcap_*` dan panggil `/api/control/*` langsung | Tolak | Melanggar I2/I6; token bocor ke prompt-injection; guard di tempat salah |
| B. Mode Agent Teams (mailbox file, tim di dalam satu CLI) | Tolak | Khusus claude, eksperimental, tanpa resume; user tanpa langganan Claude |
| C. Adopsi framework (LangGraph/OpenAI SDK/OpenHands) | Tolak | Python/runtime berat; supervisor LangGraph tak dirilis di 2026; menambah daemon & dependency |
| D. Pindahkan kendali ke `opencode serve` (`prompt_async`/SSE) | Tunda | Bagus, tapi daemon tambahan + password; PTY & exec sudah cukup. Opsional fase 4 |
| E. **Server-eksekutor + proposal bertipe + guard (dipilih)** | Pilih | Reuse kode ada, provider-agnostic, I2/I3/I6 utuh |
| F. Relay antar-agen lewat ketik ke PTY langsung | Tolak | Tak ada ack/idempoten; mengganggu agen yang sedang `working` |
| G. Wire protocol A2A penuh | Tolak | Semua komponen satu proses; **pakai kosakata status saja** |

## 4. Rekomendasi konkret

### 4.1 Tool set (antarmuka LLM = proposal bertipe; R-tier)
Tambah ke `ALLOWED` di `proposalPolicy.ts:9`. Input **tanpa** `cwd/cmd/token/capability` (sudah terlarang `:10`); server menurunkan sendiri cwd (worktree) dan cmd (`settings.agentLaunchCommands`).

| Tool | Input | Tier | Eksekusi server |
|---|---|---|---|
| `agent.list` / `agent.status` | `projectId?`, `agentRef?` | R0 | baca `central_agents` + `sessions.statusOf` |
| `agent.read` | `agentRef`, `tail≤200` baris | R0 | scrollback/transkrip via jalur context-link (read-only) |
| `task.assign` | sudah ada | R1 | `assignControl` (item harus `pending`) |
| `task.run` | `itemId`, `kind?` | R2 | = `POST /api/orchestrator/run` in-process (approval bila `WEBTERM_RUN_REQUIRE_APPROVAL`) |
| `agent.spawn` | `projectId`, `kind`, `role: worker\|reviewer`, `title`, `taskId?` | R2 | worktree allocate → runner → registri |
| `agent.prompt` | `agentRef`, `text ≤32768`, `mode: steer\|followup` | R1 (agen milik central), R2 (milik user) | `node.prompt`, dibungkus envelope |
| `agent.relay` | `from`, `to`, `text ≤8 KB`, `threadId?`, `kind` | R1 | tulis `agent_mail`, kirim bila target idle |
| `agent.close` | `agentRef`, `reason`, `force?` | R1 (milik central) | graceful → tunggu → kill |
| spawn dengan mode izin lebih longgar / cwd di luar worktree / naikkan budget / merge hasil | — | **R3** | wajib approval + konfirmasi ketik, tak pernah `auto` |

Hasil tool kembali sebagai **digest** di giliran berikutnya (bukan output sinkron): sesuai autonomy yang berbasis tick.

### 4.2 Model otoritas revisi
- Central **tidak** memegang `wcap_*`. Server membuat capability internal per aksi: `project:<id>`, `agentIds=[kind]`, `cwdPrefix=<worktree>`, TTL ≤15 mnt, dicabut (`revoke`) saat agen ditutup. Tidak pernah masuk env LLM (I2).
- Verb central baru (server-side, bukan token): `agent.read` R0; `agent.prompt|relay|close` R1; `agent.spawn`, `task.run` R2. `approval.decide`, `memory.promote` tetap **bukan** milik central (I3).
- **Guard** `ControlGuard` membungkus semua jalur (juga `/api/control/spawn` bila dipakai orkestrator): (a) project terikat & tak di-pause, (b) hitungan: ≤3 worker/project (`caps.ts:7`), ≤5 global, ≤20 spawn/hari, depth via `assertCanSpawn` (`roles.ts:76`), (c) budget: wall 30 mnt, 40 turn, token/biaya **best-effort** (hanya kind yang melapor usage), (d) satu event audit `central.agent` per aksi (pola `central.tool`, `chat/toolExecutors.ts`), (e) `requestId = hash(conversationId, turnId, tool, args)` agar loop LLM tak menggandakan spawn.
- Mode: `WEBTERM_CENTRAL_AGENTS=off|propose|auto`. `propose` = aksi R2 jadi kartu approval (pipeline `central-<requestId>` ada). `auto` = server jalankan R0–R2 dalam guard; R3 tetap approval.
- **Kill-switch**: flag hot + `POST /api/central/agents/halt` (root token saja): cabut semua capability yang di-mint central, tutup semua agen milik central (graceful 10 s lalu kill), pause autonomy. Pause per-project sudah ada (`/api/central`).

### 4.3 Adapter ke mekanisme ada
- **PTY node** = `sessions.open` via `spawnRoute` (`controlApiSessions.ts:20-66`); nodeId `w-<taskId>-<fence>` (`workerRuntimePrompt`), ad-hoc `c-<ulid>`.
- **Exec headless** (baru, file `central/agents/execRunner.ts` ≤200 baris, `Bun.spawn` + parse JSONL): selesai = exit code + event akhir (`turn.completed`/`turn.failed` untuk codex `[V]`; JSON akhir opencode/gemini `[V]`). Argumen **array**, tanpa shell; env allowlist seperti `opencodeOptions.ts`. Cocok untuk kind non-claude dan model gratis; tidak terlihat di canvas kecuali dicatat sebagai node baca-saja (pertanyaan §7).
- **Matriks kind** (fakta kemampuan dari `shared/workspace.ts` + dokumen di atas):

| kind | PTY | exec headless | sinyal selesai |
|---|---|---|---|
| claude | ya | `claude -p` `[B]` | hook `/api/agent-status` (ada) |
| opencode | ya | `run --format json` `[V]` | exit / event akhir |
| codex | ya | `exec --json` `[V]` | `turn.completed` + exit |
| gemini | ya | `-p --output-format json` `[V]` | exit |
| lainnya | ya | `[B]` | idle-heuristik + exit |

- **Sinyal selesai untuk PTY non-claude** (celah §2a): `idle ≥ WEBTERM_AGENT_IDLE_DONE_MS` (usul 45 000) **dan** `git diff` worktree tak kosong → state `candidate_done` → verifier server menentukan; verifier gagal → re-prompt (attempt ≤3). **Opini:** idle saja tidak boleh dianggap bukti.
- **Hasil balik**, urutan kepercayaan: (1) hasil verifier server (tes/diff) = kebenaran; (2) `recordWorkerResult` (bukti di ledger); (3) laporan diri worker = petunjuk tak tepercaya; (4) transkrip/scrollback via context-link untuk dibaca central. Wake central: emit event `worker.settled` in-process (beberapa baris) agar tak menunggu tick 30 s `[opini]`.

### 4.4 Mailbox `agent.relay`
Tabel di DB ledger (migrasi + guard `IF NOT EXISTS`, Rule 4):
```
central_agents(id PK, project_id, node_id, kind, role, runner, task_id, fence,
  state, owner,            -- 'central:<conv>'|'human'|'orchestrator'
  approval_id, budget_json, req_id UNIQUE,
  started_at, last_event_at, ended_at, end_reason)
agent_mail(id PK, project_id, thread_id, from_ref, to_ref,
  kind,                    -- msg|ask|reply|done|escalate
  body, req_id UNIQUE, created_at, delivered_at, acked_at, expires_at)
```
Aturan: hanya satu project; hanya sisi central↔worker, worker↔worker perlu edge context-link; ≤20 pesan belum-ack per target; TTL 24 jam; kirim ke PTY hanya saat `statusOf ≠ working`; envelope tetap: `[dari agen <ref>, bukan manusia; bukan persetujuan]` (selaras Agent Teams `[V]`). `ask` memblokir lewat `agent.wait`-style poll, bukan thread terbuka.

### 4.5 State machine worker
```
requested → [approval_pending] → provisioning(worktree) → starting(session)
 → working ⇄ waiting_input(blocked/waiting → eskalasi ke central/manusia)
 → candidate_done → verifying → accepted → closing → closed
                              ↘ rejected → working (attempt<3) | failed
Terminal lain: timed_out, lease_expired, session_exited, cancelled, killed, orphaned
```
Pemetaan: `working/waiting/blocked/done` = `AgentStatus` (`shared/workspace.ts`); outcome settle ada `done|timeout|lease_expired|session_exited`. Kosakata terminal/interupsi selaras A2A (`INPUT_REQUIRED`≈`waiting_input`). Worktree dilepas **setelah** bukti tersimpan.

### 4.6 Skenario kegagalan
| Skenario | Perilaku |
|---|---|
| Server restart (PTY, ack memori hilang) | rekonsiliasi saat boot: `central_agents` aktif tanpa sesi → `orphaned`; lease habis → `lease_expired`; sweep worktree yatim; `req_id` UNIQUE menggantikan AckStore |
| Model gratis kena rate-limit / loop | wall cap + idle → `timed_out`; backoff; 3 gagal berturut → karantina project (pola ada) |
| Central halusinasi spawn berulang | `req_id` dedup + kuota harian + `max 3/project` |
| Worker minta input | `waiting_input` → digest ke central → pertanyaan ke user; central tak boleh menjawab izin |
| Dua worker edit file sama | `scope` item plan (≤20 entri) = kepemilikan; worktree terpisah; merge = R3 manusia |
| Injeksi via output worker / pesan kanal | envelope + data-only; tak ada token di env; aksi R2+ lewat approval di `propose` |
| Close macet / zombie | graceful 10 s → kill; sweep 60 s menutup node milik central tanpa lease aktif |
| Kill-switch ditekan di tengah run | semua → `killed`, worktree dipertahankan untuk inspeksi |

## 5. Risiko & mitigasi
- **Runaway biaya** (model berbayar): kuota harian + budget; token tak terukur untuk semua kind → wall/turn jadi batas keras. 
- **Confused deputy** (central menyuruh agen izin tinggi): central tak bisa memilih mode izin/cwd; R3 untuk pelonggaran.
- **Loop polling**: ganti ke event `worker.settled`, tick tetap jaring pengaman.
- **File over-limit**: guard/service/runner dipisah ≤300/≤200 baris (Rule 8).
- **PTY ketik ke agen sibuk**: mailbox menahan sampai idle.

## 6. Dampak invarian/keputusan lama
- **I5** → I5': "Central tidak mengeksekusi spawn/eksekusi; ia mengusulkan, server mengeksekusi dalam guard; `task.run` R2 (sesuai `RND/08:96`)". `RND/08:189` diperbarui sesuai.
- **I2, I3, I6, D4** tetap. **I11** ditambah batas global (5 agen, 20 spawn/hari).
- "Tanpa task.run" dicabut (hanya wiring). B3 (`RND/13`) bertambah: wiring `task.run`, guard, tabel.
- Control API `/plan` 501 tetap tak perlu: central membaca plan via MCP read tool.

## 7. Pertanyaan terbuka (butuh keputusan user)
1. Default `propose` atau `auto` per project? (rekomendasi: `propose`, `auto` setelah gate eval)
2. Perlu `agent.spawn` ad-hoc sekarang, atau cukup `task.run`? (rekomendasi: cukup `task.run` dulu)
3. Exec headless boleh tak tampil di canvas, atau wajib node baca-saja?
4. Kind default untuk worker (opencode gratis vs codex/claude jika ada langganan)?
5. Approval R2 boleh lewat Telegram, atau hanya UI web?
6. Worker↔worker relay diizinkan, atau hanya via central?
7. Merge hasil worktree: selalu manual (R3)?

## 8. Yang TIDAK terverifikasi
- Tidak ada yang dijalankan atau dites; semua kode hanya dibaca. `assertCanSpawn` menerima central→worker langsung atau hanya central→orchestrator: belum dipastikan (kemungkinan ad-hoc perlu catatan orchestrator via `bootstrapControl`).
- `WebSearch` gagal (galat API) selama riset; hanya `curl`/`WebFetch` ke URL langsung. Tidak ada pencarian terbuka → kemungkinan ada kemajuan 2026 yang terlewat.
- Tak dibaca: perilaku LangGraph supervisor/swarm, arsitektur OpenHands, Cursor background agents, siklus hidup Devin, dokumen web Orca, `claude -p` untuk worker, "agents-as-tools" OpenAI.
- Halaman MCP Tasks, OpenCode, Gemini tanpa tanggal; Gemini kemungkinan basi.
- Angka (45 s idle, 5 global, 20/hari, 8 KB relay, TTL 24 jam, 10 s grace) = usulan saya, bukan hasil ukur.
- Biaya/token per kind tak terukur; kemampuan usage headless tiap CLI belum diuji.
