# TEMUAN: Agent Pusat, Orkestrasi, Memori, dan Routing

Tanggal: 2026-10-31
Status: master synthesis, belum ada kode.
Menggantikan: `HASIL_AGENT_TERPUSAT.md` dan `VALIDASI_EKSTERNAL.md` (diserap ke sini).
Referensi detail: `90-REFERENSI/AGENT_PUSAT.md` (bukti, tabel per-track, insiden, konflik, URL).
Artefak: `~/.jcode/scratch/orchestra/` (wave1-6).

Metode: 71 worker riset (6 gelombang) + verifikasi kode.

---

## 1. Ringkasan dan vonis

Visi "satu agent pusat yang mengurus semua project" layak, tetapi **bukan satu agent
raksasa**. Bentuk yang benar:

- **3 peran, 2 hop komando**: agent pusat (depth 0) -> orkestrator project (depth 1) ->
  worker (depth 2). Worker tidak spawn. Depth 3 ditolak.
- **Agent pusat = router + indeks portfolio**, bukan eksekutor. Ia membuat/menutup
  orkestrator project atas perintah manusia, menetapkan prioritas dan budget dalam
  amplop yang disetujui, menjawab status lintas-project dari proyeksi, dan menghentikan
  runaway. Ia tidak memerintah worker langsung dan tidak menulis fact project.
- **Orkestrator project = hub sebenarnya**: memecah task, spawn worker, memverifikasi
  bukti, mempromosikan claim menjadi fact.
- **State di server, bukan di prompt**: ledger SQLite + event log append-only. Agent
  membaca proyeksi, bukan transkrip.
- **Memori hybrid**: file Markdown di git adalah kebenaran untuk CORE/fact/procedure;
  SQLite FTS5 adalah indeks yang bisa dibangun ulang; claim hidup sementara di DB.
- **Blocker utama**: `Session.send` hanya satu slot di `src/server/sessions.ts`. Manusia
  dan agent tidak bisa mengamati node yang sama. Ini harus diperbaiki lebih dulu.

Jangan dibangun sekarang: engine durable (Temporal/Restate/DBOS), vector/graph DB,
A2A penuh, hierarki 3 tingkat, spawn rekursif, sandbox per agent, OTel/eval penuh,
LLM-judge sebagai verifier utama.

---

## 2. Batas bukti

- Klaim vendor (Anthropic, Letta, Mem0, Zep, Temporal, Factory) cenderung melebihkan
  manfaat. Angka self-reported tidak dipakai sebagai dasar keputusan.
- Tidak ada studi yang membandingkan hierarki 2 vs 3 tingkat. Pilihan depth <= 2 adalah
  penalaran desain, bukan hasil eksperimen.
- Tidak ada post-mortem produksi 2026 untuk hierarki 3 tingkat atau memori terkontaminasi
  lintas-agent. Insiden yang ada bersifat single-agent atau supply chain.
- Audit wave 3: 22 VERIFIED, 6 PARTIAL, 1 WRONG dari 29 klaim sampel.
- Detail label [TINGGI]/[SEDANG]/[RENDAH], konflik, dan daftar unverified ada di
  `90-REFERENSI/AGENT_PUSAT.md` §3, §14, §15.

---

## 3. Kondisi webterm

| Area | Keadaan | Konsekuensi |
|---|---|---|
| PTY | `Sessions.open/input/resize/close/handle`; spawn hanya lewat WS `open` | Tidak ada spawn headless |
| Output | `Session.send` satu fungsi; `open` menimpa (`existing.send`), `detach` mengosongkan | Klien kedua mencuri stream; manusia + agent tidak bisa co-observe |
| Exit | `close()` menghapus sesi sebelum `pty.kill()`, sehingga `onExit` early-return | Subscriber lain tidak menerima exit/status |
| Status | Map privat; hanya Claude punya hook; `stateVerified` tidak dipanggil di route | Non-Claude Unknown; status bisa dipalsukan |
| Auth | Satu token proses; loopback tanpa token; `tokensMatch(undefined,x) === true` | Tidak ada principal; scope test bisa lolos diam-diam |
| Env | `ptyShell` sengaja mempertahankan `WEBTERM_*` | Setiap child PTY mewarisi token root |
| REST | settings, agent-status, context-link, generate-name, fs, workspaces | Tidak ada prompt/wait/subscribe/nodes |
| Data | Tabel `workspace` dan `app` saja; JSON blob; tanpa migration runner | Tidak ada plan/task/event/memory |
| Autosave | PUT whole workspace, debounce 400 ms, tanpa ETag | Last-write-wins; plan tidak boleh di blob |
| File health | `sessions.ts` tepat 300 baris; `workspace.ts` 444; `App.tsx` 436 (22k char); `SessionsPanel` 456 (20k char); `api.ts` 154; `terminalKeys.ts` 446; `sessionList.ts` 412; `themes.ts` 360 | `sessions.ts` harus dipecah sebelum subscriber refactor |
| Test | vitest + `*.bun.test.ts`; helper sesi mengasumsikan `open` mengganti send | Refactor subscriber butuh perubahan test, bukan "tanpa assertion" |

Catatan: `stateVerified` didefinisikan di `hooks.ts`, dipanggil dari route `api.ts`.
Fail-open adalah perilaku yang didokumentasikan, bukan bug tak sengaja.

---

## 4. Arsitektur target

Tiga peran, dua hop komando: agent pusat (depth 0), orkestrator project (depth 1),
worker (depth 2). Worker tidak spawn. Detail peran, cap, verifikasi, dan scheduler ada di
`00-RINGKASAN.md` dan `03-RENCANA.md`.

---

## 5. State dan ledger

Prinsip: orchestration stateless berarti **tidak ada state otoritatif di context atau
memori proses**, bukan "tanpa proses". Sesi project boleh panjang, tetapi dihidrasi ulang
dari ledger.

Skema minimal:

- `project`: id, workspace_id (1:1), name, path, branch_base, status, priority,
  budget_json, lock_epoch, approved_by.
- `agent`: id, parent_agent_id, role, depth CHECK 0..2, capabilities_json, session_ref,
  heartbeat_at, state.
- `task`: id, project_id, parent_id, spec, spec_digest, status, fence, lease_owner,
  lease_expires, last_heartbeat, attempt, max_attempts, idem_key, evidence_json.
- `event`: seq global, ts, project_id, task_id, actor, kind, payload, correlation_id.
- `decision`: id, question, choice, rationale, decided_by, action_digest, nonce, scope,
  expires_at, single_use, supersedes.
- `memory`: proyeksi indeks, bukan kebenaran isi (lihat §6).
- `run`: run_id, project_id, task_id, model, token in/out, cost, outcome, failure_label.

Aturan:

- Perubahan `task` dan `event` dalam transaksi yang sama.
- Aksi berisiko: intent event -> aksi -> outcome event. `idem_key` di level aksi, bukan
  hanya task. Setelah crash, cek outcome sebelum mengulang.
- Lease habis: tandai `suspect`, revoke sesi, requeue dengan fence baru. Jangan langsung
  `pending`, karena worker lama mungkin masih hidup.
- `evidence_json` wajib saat `verified`. Verifikasi memegang lock worktree.
- Tanpa klaim "rebuild state dari event" sampai benar-benar diuji. Task row adalah state
  sekarang, event adalah audit.

---

## 6. Memori dan retrieval

Keputusan: **hybrid**.

- **File + git = kebenaran** untuk `CORE.md`, `facts/*.md`, `PROGRESS.md`, `skills/`.
  Bisa dibaca manusia, diff, rollback, dan tidak ditulis ulang oleh LLM.
- **SQLite = indeks + audit**: tabel `memory`, FTS5 `memory_fts`, `memory_event`.
  Bisa dibangun ulang dari file. Bukan sumber kebenaran isi.
- **Claim hanya di SQLite** sampai dipromosikan. Ini satu-satunya dual-store yang
  disengaja, dan bersifat antrean sementara.

Alur:

1. Worker mengirim `POST /api/memory/claim` dengan `source_kind`, `source_ref`, evidence.
2. Orkestrator memeriksa bukti mesin: commit ada, path ada, test exit 0, referensi
   resolvable. String "tests pass" tanpa bukti ditolak.
3. Cek kontradiksi via FTS5 pada `subject`/content, scope sama, status fact. Jika ada,
   promosi men-supersede, bukan menimpa.
4. Promosi dalam satu transaksi + satu commit git, menulis fact file, upsert `memory`,
   upsert FTS5, `memory_event(promote)`.
5. Retrieval: `MATCH` + filter `workspace_id`, `status='fact'`, `superseded_at IS NULL`,
   `ORDER BY rank`; setiap hit membawa `source_ref` dan `verified_at`. Baris basi
   dikembalikan dengan flag "verifikasi dulu", tidak disembunyikan.
6. Reindex saat boot: file menang, divergensi dicatat di `memory_event`.
7. `CORE.md` hanya ditulis manusia. Agent menulis `CORE.pending.md`, UI menampilkan diff.

Aturan keamanan memori:

- `verify` harus terstruktur dan allowlisted, mis. `{kind:'test', cmd:'bun test <path>',
  cwd}`. Jangan simpan `verify_cmd` bebas, itu RCE persisten.
- `source_kind='tool'` tidak boleh auto-promote. Butuh sumber kedua atau approval manusia.
- TTL hanya untuk `scratch`. Fact memakai `stale_after_days` dan flag, bukan penghapusan.
- Bi-temporal di DB tidak perlu. Git sudah menyediakan as-of query. Cukup
  `superseded_at`/`superseded_by`.
- FTS5 sudah diverifikasi di Bun 1.4.2. `porter` cocok untuk Inggris, kurang untuk
  Indonesia. Pertimbangkan `unicode61` atau `trigram`; ukur pada korpus nyata.
- Hindari graph/embedding sampai FTS5 terbukti gagal.

---

## 7. Context management

| Peran | Isi konteks | Budget awal |
|---|---|---|
| Agent pusat | portfolio, prioritas, budget, dependency, keputusan, pointer | 25-30% |
| Orkestrator project | spec, acceptance, task graph, kontrak, decision log, status worker | 40% steady, compact 65% |
| Worker | objective, format output, file scope, tools, batas, acceptance | 50%, return 1-2k token |

- Ringkasan wajib memakai skema tetap: tujuan, constraint, keputusan + alasan +
  alternatif ditolak, pertanyaan terbuka, path, next action, status verifikasi.
- Worker menulis detail ke artifact, mengembalikan ringkasan + referensi. Jangan piping
  transkrip penuh ke parent.
- Re-inject dari disk setelah kompaksi: instruksi, plan, feature list, file terakhir.
  Jangan percaya ringkasan sebagai kebenaran.
- Compact di batas fase, bukan saat krisis. Rotasi sesi setelah handoff ditulis dan
  di-commit, atau setelah 1-2 kompaksi.
- Ukur token yang dilihat model, occupancy per peran, growth per turn, dan tool-output
  share. Jangan mengandalkan ukuran window nominal.

---

## 8. Kolaborasi manusia-agent

- **Ownership pada invocation/task**, bukan agent atau PID: `owner {kind, id, epoch}`.
  Takeover menaikkan epoch dan menulis decision; controller lama diberi tahu.
- **Gate per kelas keterbalikan**, bukan per aksi:
  - otomatis: read, edit di worktree sendiri, test;
  - wajib manusia: push ke remote bersama, merge, migration/schema, credential, hapus
    massal, aksi di luar project;
  - agent bertanya: ambigu, butuh credential, gagal berulang.
- **Approval terikat digest**: `decision` menyimpan `action_digest`, nonce, expiry,
  single-use. Approval dirender out-of-band, bukan di transcript. Boolean dari agent
  bukan consent.
- **Plan-approve gate** sebelum agent mengubah kode. Ini mengubah approval per-aksi
  menjadi standing policy per workspace.
- **Inbox tiga bagian**: Needs you, Needs review, Broken. Hitungan project rail adalah
  jumlah actionable, bukan jumlah node.
- **Format laporan worker**: tujuan, scope file, keputusan + alternatif, bukti test,
  yang belum diverifikasi, pertanyaan terbuka.
- Jangan memakai kanban sebagai home, jangan notify-only state, jangan auto-approve
  tanpa audit row, jangan menganggap worktree menghapus konflik semantik.

---

## 9. Keamanan

1. Credential: token per-project/agent, umur pendek, tidak diwariskan ke child.
2. Aksi irreversible: gate manusia + soft-delete/backup di jalur terpisah.
3. Isolasi: sandbox Seatbelt untuk shell, egress allowlist. File tool, hook, dan MCP
   berjalan di luar sandbox shell.
4. Attenuasi + batas spawn: anak <= induk, depth <= 2, cap paralel/total, tanpa rekursi.
5. Biaya + verifikasi + audit: cap memblokir, verifikasi independen, log hash-chain,
   eval regresi.

P0 khusus webterm:

- Principal selalu ada. Loopback bukan autentikasi.
- `PUT /api/settings` adalah penulisan kode, bukan config. Hanya manusia.
- `/ws open` menjalankan `cmd` lewat login shell. Butuh choke point dan allowlist argv.
- `stateVerified` dipanggil, `transcript_path` dibatasi ke root yang diizinkan.
- Escape `nodeId` di hook command. Validasi id di boundary.
- Jangan menaruh token di `process.env` global; kirim per-PTY, scope sempit.
- `tokensMatch(undefined,x)` harus diperbaiki agar test scope tidak lolos diam-diam.

Ancaman utama: settings/hook write sebagai root persisten, prompt injection dari output
worker, supply chain skill, shell tanpa batas, approval forgery, denial of wallet.

---

## 10. Harness adapter

| Harness | Kontrol | Completion | Catatan |
|---|---|---|---|
| Claude Code | PTY + hook `--settings` | `Stop`/`StopFailure` = turn selesai | Paling matang; task selesai tetap butuh verifikasi |
| opencode | HTTP `/api/*` | `/api/experimental/session/{id}/wait` + SSE | v2.0.26; docs beda path, baca `/openapi.json` |
| Codex | `exec --json` atau SDK | JSONL `turn.completed` | SDK tidak punya spawn subagent |
| Gemini/Antigravity | headless `-p` | terbatas, tanpa hook | Jangan diandalkan untuk MVP |

Aturan: "turn selesai" bukan "task selesai". Adapter hanya memberi sinyal, orkestrator
tetap memverifikasi diff/test. Claude-first untuk MVP, opencode adapter fase lanjut.

---

## 11. Framework, protokol, routing

Framework:

- **Kernel sendiri**: run/task record, state machine, event log, approval queue, adapter.
  Sekitar 500-1000 baris. Ini yang menyelesaikan blocker webterm.
- Jika harus adopsi: **OpenAI Agents SDK JS** (MIT, 4 deps, Bun resmi didukung).
  Runner-up LangGraph.js. Tolak Mastra (30 deps, satu level), ADK TS (Python-first),
  Claude Agent SDK sebagai inti (spawn binary, lisensi komersial).
- Engine durable: tidak. Event log SQLite + reconciler + timer. Restate/Temporal hanya
  jika multi-host, >1.000 run, HA, atau retry semantics melebihi 2-3 tipe.

Protokol:

- **MCP hanya untuk tool/data**, bukan komunikasi antar-agent dan bukan control write.
- **HTTP+JSON bentuk A2A** untuk kontrak antar-level, dengan event stream ber-cursor.
  Polling hanya fallback. A2A penuh ditunda.
- **ACP** untuk menyatukan kontrol CLI agent, tetapi sesi ACP bukan PTY. Bukan pengganti
  inti webterm.
- **Skills/AGENTS.md** untuk prosedur. Tetap simpan CLAUDE.md.

Routing model:

- DeepSeek Anthropic endpoint memetakan `claude-opus*` ke V4 Pro dan
  `claude-sonnet*/haiku*` ke V4 Flash. Resep resmi memakai Flash untuk semua alias.
  Untuk Pro, set eksplisit `ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro`.
- Integrasi webterm: `agentLaunchCommands.claude` adalah string shell; wrapper diakhiri
  `exec claude "$@"`.
- Routing per-turn: LiteLLM Auto Router (beta) atau Bifrost `complexity_tier`. Risiko:
  prompt cache pecah, thinking block tidak kompatibel, biaya classifier. Gunakan session
  affinity atau routing per peran.

---

## 12. Roadmap final

Roadmap 5 fase dan gate ada di `03-RENCANA.md`; bagian ini tidak diulang.

---

## 13. Keputusan terbuka dan default

- Agent pusat: router + portfolio authority, opsional, fase 4. Bukan eksekutor.
- Hierarki: 3 peran, depth <= 2. Sub-orkestrator ditunda.
- Memori: file+git truth, SQLite FTS5 index, claim->fact.
- Approval: kelas risiko + digest + plan-approve.
- opencode: Claude-first, adapter HTTP fase lanjut, pin versi.
- Durability: tanpa engine sampai ambang tercapai.
- Framework: kernel sendiri. OpenAI Agents SDK JS hanya jika adopsi.
- Sandbox: Seatbelt untuk shell, microVM untuk install tidak tepercaya.
- Multi-user: belum. Satu trust domain, isolasi logis per workspace.

---

## 14. Konflik yang diselesaikan

K1 memori: file+git truth + SQLite index/claim queue. K2 project 1:1 workspace. K3 roadmap 5 fase. K4 token scoped. K5 approval kelas+digest. K6 worker claim saja. K7 kernel sendiri, Mastra ditolak. K8 depth 2. K9 Claude-first. K10 angka vendor di AGENT_PUSAT.

---

## 15. Koreksi data penting

- **Mem0 92,32 vs audit 38,38 salah pasangan.** 92,32 adalah EverMemOS, bukan Mem0.
- **Railway**: backup tidak hancur. Cascading delete menyembunyikannya dan DB dipulihkan.
- **Nested subagent**: docs default depth 3, blog menyebut cap 5. Bukan konflik, jangan
  jadikan angka sebagai dasar desain.
- **MAST 41-86,7% dan 17,2x** dari model lama dan abstrak. Bukan dasar keputusan.
- **Angka adopsi vendor**, ukuran file, dan nomor baris tidak dipakai. Ukur ulang di Fase 0.

---

## 16. Risiko dan anti-pattern

Satu agent raksasa; plan di prompt/blob; polling utama; turn selesai = task selesai;
spawn tanpa cap/approval; loopback = auth; token di settings; routing per-turn tanpa
affinity; framework sebelum state; semua harness dianggap punya status; approval per-aksi;
LLM judge satu-satunya verifier; worktree = bebas konflik; rewind = backup; memori tanpa
provenance/`verify_cmd`.

---

## 17. Log validasi empiris

Log uji dan bukti ada di `90-REFERENSI/BUKTI.md`; ringkasan gate ada di `03-RENCANA.md`.

---

## 18. Kebutuhan agent pusat (wave 4)

Riset 16 agent: audit Jcode + 8 lane eksternal. Detail: `02-KEBUTUHAN.md`.

- Cache: prefix-exact, urutan tools/system/context/history, sticky route, prefix hash, hit/miss accounting. Hit rate mendominasi biaya.
- Context: max(estimate, observed), 80/95 threshold, safe cutoff, summary schema, cross-agent budget, soft interrupt.
- Memori: file+git truth, SQLite FTS5 index, claim->fact, supersede/conflicting, authority non-amplification, quarantine, consolidation by recurrence/contradiction.
- Tool: catalog + deferred search, 3-5 inti, namespace/version/hash, output spill, policy metadata, tool result untrusted.
- Routing: route object, pure fallback, account pool, usage outbox, unknown price != 0, hard local budget.
- Reliability: lease+fence, wake scheduler, intent->action->outcome, outbox, snapshot+journal, lazy revive.
- Security: blocking approval (bukan queue), digest+nonce+expiry, blast-radius deny, hooks user-owned, one exec path, redaction at egress.
- Intelligence: task contract, one DAG plan, verification gate, bounded reflection, ask policy, raw evidence memory.
- Eval: false-success detector, deterministic graders, evidence coverage, fault injection, paired A/B.
- UX: state-first inbox, peek/reply/attach lease, approval ladder policy/plan/diff/irreversible, interrupt budget, accessibility.
- Data: local-first plaintext, `VACUUM INTO` backup, retention/export/delete, no sync.
- Jcode: adopsi plan versioning, parent edge, report-back, await durable, lease/fence, route/usage, cache tracker, blast-radius gate. Tolak root-only, approval advisory, no sandbox, TUI coupling.

---

## 19. Artefak dan sumber

Artefak lengkap ada di `90-REFERENSI/BUKTI.md` dan `90-REFERENSI/AGENT_PUSAT.md`.

---

## 20. Omnichannel (Telegram dan kanal lain)

Kanal eksternal adalah **adapter ingress tidak tepercaya**, bukan control plane kedua.
Semua perintah masuk ke control API/ledger yang sama dengan web; kanal tidak menulis PTY,
task, decision, atau settings. Detail: `04-OMNICHANNEL.md`; requirement O1-O22:
`02-KEBUTUHAN.md`; fase P5: `03-RENCANA.md`.

- **v1**: in-app inbox, CLI, generic webhook, Web Push, Telegram (flag off).
- **Telegram**: webhook `secret_token`, dedupe `update_id`, topic per project, satu
  pesan status editable per task, inline approval, batas 4096 char / 64 byte callback.
- **Identity**: kode link sekali pakai, allowlist numeric user id, role subset principal;
  group read-only dan tidak boleh approve.
- **Approval**: tetap blocking, digest + nonce + expiry + single-use; teks "yes" bukan
  decision.
- **Reliability**: 200 setelah persist, outbox transaksional, retry/backoff, 429
  `retry_after`, dead-letter, ordering per conversation.
- **Security**: token bot di Keychain/0600, tidak di env PTY/log/settings; redaksi egress;
  callback opaque + MAC; audit hash chain.
- **Fase**: P5 setelah P3/P4; gate G7 replay 100x, cross-project ditolak, approval
  blocking, channel down tidak memblokir ledger.

Slack, Discord, WhatsApp, SMS, email ditunda. WhatsApp/SMS butuh template/10DLC dan
biaya per pesan; email lemah untuk approval interaktif.
