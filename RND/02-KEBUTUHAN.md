# KEBUTUHAN AGENT TERPUSAT

Tanggal: 2026-10-31
Status: daftar kebutuhan untuk membentuk agent pusat yang cerdas, terkoordinasi, dan
punya manajemen memori, cache, context, tool, biaya, dan risiko yang memadai.
Sumber: audit Jcode lokal (`/Users/bip/.jcode/scratch/jcode-src`) dan riset eksternal
Oktober 2026.
Dokumen induk: `01-TEMUAN.md`. Detail bukti: `90-REFERENSI/AGENT_PUSAT.md` dan artefak wave4.

---

## 1. Verdict

Agent pusat yang baik bukan model terbesar dengan prompt terpanjang. Ia adalah
**control plane kecil** dengan state durable, verifikasi independen, tool catalog,
cache-aware context, dan batas otonomi yang jelas. Kecerdasan berasal dari kontrak
tugas, verifikasi, dan pemilihan tool yang tepat, bukan dari refleksi tanpa bukti.

Tiga hal yang paling sering dilupakan:

1. **Cache warmth** menentukan biaya jauh lebih besar daripada panjang output.
2. **False success** adalah kegagalan utama, dan LLM judge tidak bisa mendeteksinya.
3. **Attention manusia** adalah sumber daya terbatas. Inbox harus menyaring, bukan
   menampilkan semua aktivitas.

---

## 2. Kebutuhan koordinasi

| # | Kebutuhan | Prioritas | Bukti/asal |
|---|---|---|---|
| K1 | Satu parent edge per agent; ancestry menentukan stop, broadcast, report-back, reparenting | P0 | Jcode swarm |
| K2 | Depth sebagai kolom, dihitung induk+1, spawn ditolak di depth >= 2 | P0 | AGENT_PUSAT, wave3 |
| K3 | Hanya orkestrator yang spawn; worker tidak spawn; agent pusat hanya membuat orkestrator project | P0 | AGENT_PUSAT |
| K4 | Satu plan per scope dengan versi monotonik; update hanya ke participant, bukan seluruh swarm | P0 | Jcode plan |
| K5 | Assign task sebelum worker mulai; lane/scope eksplisit; prompt tidak boleh drift dari plan | P1 | Jcode lane seeding |
| K6 | Completion otomatis dengan tail output terbatas + next-action hint; tanpa tool report manual | P1 | Jcode report-back |
| K7 | Wait adalah objek durable (TTL, background, wake), bukan blocking call | P1 | Jcode await_members |
| K8 | Mutasi spawn idempoten dengan request nonce dan admission lock | P1 | Jcode |
| K9 | Recovery eksplisit: retry, reassign, replace, salvage, reclaim counter, grace period | P0 | Jcode |
| K10 | Cap keras: worker paralel, total spawn, token, USD, turn, waktu. Cap memblokir | P0 | AGENT_PUSAT |

Yang tidak boleh ditiru: root-only satu tingkat dengan satu plan global. Webterm butuh
plan per project dan escalation, bukan satu papan tunggal.

---

## 3. Kebutuhan state, ledger, dan reliabilitas

| # | Kebutuhan | Prioritas |
|---|---|---|
| S1 | Ledger SQLite WAL, transaksi pendek, satu writer per host | P0 |
| S2 | Tabel project, agent, task, event, decision, run, approval | P0 |
| S3 | Task state: pending, leased, suspect, claimed_done, verified, blocked, failed, cancelled, reopened | P0 |
| S4 | Fence monotonik per task; worker lama tidak boleh menulis setelah reassign | P0 |
| S5 | Lease + heartbeat + wake scheduler; reconcile berkala, bukan hanya "awal turn" | P0 |
| S6 | Perubahan task dan event dalam satu transaksi | P0 |
| S7 | Intent -> aksi -> outcome; idempotency key di level aksi | P0 |
| S8 | `evidence_json` wajib saat verified: base/head sha, diff, command + exit, file scope | P0 |
| S9 | Satu owner per transcript dengan epoch; salinan lama gagal closed | P1 |
| S10 | Durable-first ordering: journal intent sebelum aksi terlihat | P1 |
| S11 | Snapshot + journal append-only, dedupe replay by stable id | P1 |
| S12 | Klasifikasi disconnect: kerja terputus = crash, idle detach = close | P1 |
| S13 | Lazy revive dari session durable, bukan respawn kosong | P1 |
| S14 | Stall != failure; tool panjang tidak dihitung stall | P1 |
| S15 | Recovery idempotent; tool call yang terputus diberi stub API-valid | P1 |

Jangan pakai engine durable sebelum ambang: multi-host, >1.000 run aktif, HA, atau
retry semantics melebihi 2-3 tipe.

---

## 4. Kebutuhan memori

Prinsip: **file + git adalah kebenaran; SQLite adalah indeks; claim adalah antrean.**

| # | Kebutuhan | Prioritas |
|---|---|---|
| M1 | `CORE.md` hanya ditulis manusia; agent hanya mengusulkan lewat PR/diff | P0 |
| M2 | Fact dan decision di file Markdown bergit, dengan frontmatter provenance | P1 |
| M3 | `memory` table + FTS5 + `memory_event` sebagai proyeksi yang bisa dibangun ulang | P1 |
| M4 | Claim hanya di SQLite sampai dipromosikan dengan bukti mesin | P1 |
| M5 | Koreksi memakai supersede, bukan overwrite; tiga status: current, superseded, conflicting | P0 |
| M6 | `authority(child) <= min(authority(parent))`; source_kind/owner/derived_from immutable | P0 |
| M7 | Tool output tidak auto-promote; butuh sumber kedua atau approval manusia | P0 |
| M8 | `verify` terstruktur dan allowlisted; jangan simpan `verify_cmd` bebas | P0 |
| M9 | TTL hanya untuk scratch; fact memakai `stale_after_days` + flag | P1 |
| M10 | Retrieval FTS5 dengan scope + status + superseded filter; bm25; baris basi diberi flag | P1 |
| M11 | Reindex saat boot; file menang; divergensi dicatat | P1 |
| M12 | Quarantine untuk origin tidak dikenal, rewrite massal, atau escalation otoritas | P1 |
| M13 | Konsolidasi dipicu recurrence >=3, kontradiksi, N task selesai, kompaksi, atau nightly | P2 |
| M14 | Konsolidasi deterministik dan tercatat; jangan mengubah urutan tanpa log | P2 |
| M15 | Defrag berkala ke ~15-25 file per project, lewat PR | P2 |
| M16 | Embedding/graph DB ditunda sampai FTS5 terbukti gagal | Defer |

Catatan 2026: raw-history RAG sering mengalahkan memori agentic yang rumit. Gunakan
retrieval sederhana yang jujur, bukan pipeline mahal tanpa pembaca.

---

## 5. Kebutuhan cache dan biaya

Cache bersifat prefix-exact dan hierarkis: tools -> system -> static context ->
history -> turn. Satu byte berubah di depan, seluruh suffix miss.

| # | Kebutuhan | Prioritas |
|---|---|---|
| C1 | Render tools, system, dan context sekali per role+run; hash dan persist | P0 |
| C2 | Urutan deterministik: tool schema sorted, tool set stabil, tanpa timestamp/cwd/host di system prompt | P0 |
| C3 | Breakpoint eksplisit di akhir blok statis; nested breakpoint per change rate | P1 |
| C4 | Sticky provider/model/account/region per session; cache key stabil | P0 |
| C5 | History append-only; kompaksi hanya di batas fase lalu re-warm | P1 |
| C6 | Fan-out: satu write lalu parallel read; pre-warm atau stagger | P1 |
| C7 | Simpan prefix hash + serialized tool list; alert jika prefix yang kemarin hit kini 0 | P1 |
| C8 | Catat input uncached, cache read, cache write, output, prefix hash, miss reason | P0 |
| C9 | Hit rate = read / (read + uncached), token-weighted; savings gross dan net | P1 |
| C10 | Cost per verified success sebagai gate, bukan token count | P1 |
| C11 | Hard local budget cap, terpisah dari accounting provider | P0 |
| C12 | Jangan campur CLI berbeda dalam satu role jika biaya penting; prompt mereka beda | P2 |
| C13 | Jangan fork history untuk worker; bagikan prefix immutable, variasi di tail | P1 |
| C14 | Jangan ubah model/effort di tengah sesi tanpa treat as new session | P2 |

DeepSeek hit vs miss sekitar 50x, jadi hit rate mendominasi biaya.

---

## 6. Kebutuhan context

| # | Kebutuhan | Prioritas |
|---|---|---|
| X1 | Satu fungsi ukur per provider: max(estimasi karakter, observed usage), tanpa double-count cache | P0 |
| X2 | Dua ambang: 80% async summarize, 95% hard compact; hard compact bisa membatalkan task async | P1 |
| X3 | Cutoff aman; jangan memisahkan tool_use dari tool_result; cutoff boleh menolak compact | P0 |
| X4 | Static/dynamic split; snapshot dibekukan; reminder di tail, bukan edit prefix | P1 |
| X5 | Ringkasan dengan skema tetap: tujuan, keputusan, alternatif ditolak, pertanyaan, path, next action | P0 |
| X6 | Re-inject instruksi dan plan dari disk setelah kompaksi; summary bukan kebenaran | P0 |
| X7 | Soft interrupt queue durable; inject hanya saat provider idle, tidak di antara tool pair | P1 |
| X8 | Hibernasi hanya membuang cache turunan; identitas, draft, queue, kerja pending tetap | P2 |
| X9 | Budget per peran dan cross-agent ledger; Jcode hanya punya per-session | P1 |
| X10 | Ukur occupancy, growth per turn, tool-output share, compaction count | P1 |
| X11 | Image decay dan tool output cap; jangan simpan base64 panjang di history | P2 |

---

## 7. Kebutuhan tool

| # | Kebutuhan | Prioritas |
|---|---|---|
| T1 | Katalog tool dengan search text pendek, schema penuh terpisah, nama/versi/hash/owner | P0 |
| T2 | 3-5 tool inti selalu aktif; sisanya deferred loading / tool search | P1 |
| T3 | Namespace dan versi: `<org>.<domain>.<server>/<tool>@<version>`; hash definisi | P0 |
| T4 | Output cap by token, spill ke artifact, return truncated/artifact_uri/bytes/hint | P0 |
| T5 | Policy per tool: effect class, data class, egress, approval mode, timeout, idempotency | P0 |
| T6 | Tool result dan description adalah data tak tepercaya; jangan jadikan instruksi | P0 |
| T7 | Pin versi server, alert jika definisi berubah (rug pull) | P1 |
| T8 | MCP sebagai transport, bukan API model-facing; satu surface sintesis | P1 |
| T9 | CLI/skill untuk verb lokal frekuensi tinggi; code mode untuk fan-out/filter | P2 |
| T10 | Sandbox code mode; jangan satu capability lewat dua path di turn yang sama | P1 |
| T11 | Tool search client-executed agar bisa inject tool per project | P2 |
| T12 | Batas ukuran definisi per turn; ukur hit rate search | P2 |

---

## 8. Kebutuhan routing, auth, dan usage

| # | Kebutuhan | Prioritas |
|---|---|---|
| R1 | Route object: model, provider, auth_method, account, availability, detail, price estimate | P0 |
| R2 | Fallback murni dan deterministik: same model/other auth -> sibling model -> other provider | P1 |
| R3 | Credential failure melebar ke semua route yang memakai credential itu | P1 |
| R4 | Account pool bertingkat; API key metered tidak auto-enroll | P1 |
| R5 | Single-flight refresh; token yang ditolak di-fingerprint, tidak disimpan mentah | P0 |
| R6 | Usage per response, bucket terpisah input/output/cache-read/cache-write | P0 |
| R7 | Durable outbox dengan event id stabil, retry idempoten, replay terbatas | P1 |
| R8 | Harga adalah metadata berlabel source/confidence; unknown != 0 | P1 |
| R9 | Cache read priced at cache rate; reasoning tidak ditambahkan dua kali | P1 |
| R10 | Provider doctor bertingkat: offline, catalog, full; jangan over-credit | P2 |
| R11 | Budget envelope per project dan per task; hard cap lokal | P0 |

---

## 9. Kebutuhan keamanan

| # | Kebutuhan | Prioritas |
|---|---|---|
| A1 | Approval yang **memblokir** tool call sampai decision tercatat, bukan queue advisory | P0 |
| A2 | Decision terikat digest argumen, nonce, expiry, single-use; out-of-band | P0 |
| A3 | Klasifikasi blast radius deterministik untuk exec/fs; deny path absolut | P0 |
| A4 | Refusal tidak bisa diulang dengan "yes"; butuh justifikasi yang menyebut permintaan user | P0 |
| A5 | Per-session tool allowlist ditegakkan di dispatch, termasuk batch/subcall | P0 |
| A6 | Hook policy hanya dari config user, bukan repo; fail-closed untuk aksi berisiko | P1 |
| A7 | Sandbox shell per worker, egress allowlist; sadari file tool/hook/MCP di luar sandbox | P1 |
| A8 | Secret 0600/0700; token tidak di env global; kirim per-PTY | P0 |
| A9 | Redaksi saat egress, bukan saat baca; log shape, bukan value | P0 |
| A10 | Audit append-only dan tamper-evident; actor, action, digest, decision, result | P1 |
| A11 | Satu jalur exec; hapus dual path `/ws open` dan settings launch | P1 |
| A12 | Quarantine memory dan tool definition yang berubah | P1 |

Jcode tidak punya sandbox dan approval-nya advisory. Jangan warisi.

---

## 10. Kebutuhan kecerdasan

| # | Kebutuhan | Prioritas |
|---|---|---|
| I1 | Kontrak tugas sebelum berpikir: objective, file scope, acceptance command, output schema | P0 |
| I2 | Satu plan DAG maksimal ~7 node, acceptance per node, budget per node | P0 |
| I3 | Planner model kuat, executor murah, verifier independen | P1 |
| I4 | Verifikasi sebagai loop inti: test/build/lint lalu satu verifier pass | P0 |
| I5 | Refleksi hanya saat verifikasi gagal; satu ronde dengan bukti kegagalan | P1 |
| I6 | Ask policy: hanya jika ambiguity memblokir acceptance, dua attempt gagal, atau aksi irreversible | P1 |
| I7 | Batch pertanyaan maksimal 2, lalu lanjut dengan asumsi tertulis | P1 |
| I8 | Static capability table, bukan learned router sebelum ada traffic | P2 |
| I9 | Cross-model jury hanya untuk aksi berisiko tinggi | P2 |
| I10 | Raw evidence retrieval, bukan ringkasan LLM sebagai fakta | P1 |
| I11 | Gating memori: sertakan outcome "ini berhasil/gagal" pada item yang diambil | P1 |
| I12 | Deteksi false success dengan sinyal murah (state diff/TF-IDF), bukan judge | P0 |

---

## 11. Kebutuhan observability dan evaluasi

| # | Kebutuhan | Prioritas |
|---|---|---|
| E1 | Satu run record per task: model, token, cost, durasi, outcome, failure label | P0 |
| E2 | Trace OTel GenAI: invoke_workflow -> plan -> invoke_agent -> chat/tool | P1 |
| E3 | Deterministic grader: build, test, typecheck, file scope, artifact hash | P0 |
| E4 | False-success metric: klaim selesai tanpa bukti | P0 |
| E5 | Evidence coverage: persentase claim dengan artifact ref | P0 |
| E6 | Coordination gain diukur paired same-model, bukan lintas model | P1 |
| E7 | Handoff loss: subgoal hilang/duplikat/berubah | P1 |
| E8 | Failure attribution: planner, worker, tool, memory, context | P2 |
| E9 | Fault injection: kill worker, duplicate result, stale memory, rate limit, truncation | P1 |
| E10 | Regression suite T0 invariants, T1 golden tasks, T2 paired arms, T3 fault matrix | P1 |
| E11 | Dashboard minimal 6 tile; hardest quartile terlihat | P2 |
| E12 | Jangan pakai pass@k jika n = jumlah test; jangan pakai token sebagai proxy biaya | P1 |

---

## 12. Kebutuhan UX dan perhatian manusia

| # | Kebutuhan | Prioritas |
|---|---|---|
| U1 | State-first inbox: needs you, review ready, running, failed; bukan project-first | P0 |
| U2 | Satu baris ringkasan per agent, diperbarui di akhir turn | P1 |
| U3 | Peek -> reply -> attach; attach adalah lease, bukan kill | P1 |
| U4 | Approval ladder: policy sekali, plan sekali, diff sekali, irreversible per instance | P0 |
| U5 | Interrupt budget dan queue age; jangan notifikasi tiap turn | P1 |
| U6 | Satu inbox lintas project; project sebagai facet, bukan tab | P1 |
| U7 | Takeover yang terlihat: agent pause, context hidup, delta saat resume | P1 |
| U8 | Human edits win; agent diff dan hand back conflict | P0 |
| U9 | Aksesibilitas WCAG 2.2 AA; state bukan warna saja; reduced motion | P1 |
| U10 | Audit dan export Markdown/JSON per project | P1 |
| U11 | Jangan tampilkan token/cost/heatmap sebagai wallpaper | P1 |
| U12 | Jangan "approve all" tanpa diff; jangan percaya self-report | P0 |

---

## 13. Kebutuhan data lifecycle

| # | Kebutuhan | Prioritas |
|---|---|---|
| D1 | Data lokal terbaca tanpa app: SQLite + Markdown + JSONL | P0 |
| D2 | Backup konsisten (snapshot + WAL checkpoint), restore teruji | P1 |
| D3 | Enkripsi at rest opsional, key di Keychain, bukan di repo | P2 |
| D4 | Retention dan delete per project; transcript arsip tetap bisa dibaca | P1 |
| D5 | Export/portability: Markdown, JSON, SQLite dump | P1 |
| D6 | Redaksi PII/secret di log dan export | P0 |
| D7 | Multi-device sync ditunda; konflik kepemilikan transcript berisiko | Defer |
| D8 | Corruption recovery: integrity check, backup sebelum migrasi | P1 |

---

## 14. Kebutuhan yang belum terpikirkan sebelumnya

1. **Cache-aware fan-out.** Pre-warm satu prefix per role sebelum melepas banyak worker.
2. **Prefix regression alert.** Prefix yang kemarin hit, hari ini 0, adalah bug.
3. **Budget envelope per project**, bukan hanya per task. Denial of wallet adalah risiko nyata.
4. **Cross-agent context ledger.** Jcode hanya punya per-session; orkestrator perlu total occupancy.
5. **False-success detector** murah dan deterministik, terpisah dari verifier.
6. **Memory order poisoning.** Urutan konsolidasi harus deterministik dan dicatat.
7. **Authority non-amplification.** Ringkasan tidak boleh menaikkan otoritas sumber.
8. **Tool definition hashing** dan rug-pull alert.
9. **Attention budget** dan queue age, bukan hanya notification count.
10. **Blocking approval** yang tidak bisa di-forge oleh teks agent.
11. **Single-writer transcript lease** dengan epoch, untuk mencegah dua host menulis.
12. **Data export** agar user tidak terkunci.
13. **Prompt/tool list pinning** agar resume tidak silent miss cache.
14. **Quarantine**, bukan auto-delete, untuk memori dan tool yang mencurigakan.

---

## 15. Prioritas implementasi

**P0 (fondasi, wajib sebelum otonomi):**
- Multi-subscriber output + event log + seq.
- Ledger task/agent/project/decision/run, lease, fence, wake scheduler.
- Scoped token, principal selalu ada, blocking approval.
- Blast-radius deny + satu jalur exec.
- Evidence verification + false-success detector.
- Budget cap lokal + cache/usage accounting dasar.

**P1 (orkestrasi yang berguna):**
- Project orchestrator + plan/task + spawn/prompt/wait.
- Memory files + FTS5 + claim promotion + supersede/quarantine.
- Cache prefix hash + sticky routing + fan-out prewarm.
- Tool catalog + deferred search + output spill.
- Inbox/peek/reply/attach + approval ladder + audit.
- Regression suite T1 + fault injection dasar.

**P2 (skala dan kenyamanan):**
- Consolidation jobs + defrag.
- Portfolio projection + agent pusat tipis.
- OTel/Phoenix, eval dashboard, attribution.
- Sandbox per worker, microVM untuk install.
- Data encryption/export/sync.

**Defer:**
- Embedding/graph DB, A2A penuh, engine durable, cloud handoff, multi-user RBAC.

---

## 16. Kebutuhan omnichannel (O1-O22)

Kanal eksternal adalah adapter ingress, bukan control plane kedua. Detail arsitektur:
`04-OMNICHANNEL.md`. Fase memakai F1-F5 (F1=P0 ... F5=P4, lalu P5 omnichannel penuh).

| Grup | ID | Kebutuhan | Pri | Fase |
|---|---|---|---|---|
| Adapter | O1-O3 | contract, normalisasi inbound, outbound idempoten | P0 | F2 |
| Identitas | O4-O5 | link code sekali pakai, conversation -> project/task | P0 | F3 |
| Routing | O6-O7 | intent vs command, grammar deterministik | P1/P0 | F4/F2 |
| Approval | O8 | digest, nonce, expiry, single-use, blocking | P0 | F4 |
| Notifikasi | O9 | transisi state, quiet hours, digest | P1 | F5 |
| Dedupe/rate | O10-O11 | update id, outbox idem, token bucket | P0/P1 | F3 |
| Keamanan/audit | O12-O13 | allowlist, redaksi, audit hash chain | P0/P1 | F2/F3 |
| Offline | O14 | outbox, retry, dead-letter | P0 | F4 |
| Preferensi | O15-O16 | route per project/severity, satu kanal authoritative | P1/P2 | F5 |
| UX | O17 | SettingsChannels, link/revoke/status | P1 | F5 |
| Telegram | O18-O21 | auth, update, format/limit, delivery | P0-P2 | F5 |
| Metrik | O22 | lag, gagal, dedupe, approval latency, dead-letter | P2 | F4 |

Urutan wajib: O1 -> O2/O7 -> O10 -> O5 -> O8 -> O14 -> O18. O8 tidak boleh mendahului F4
(approval blocking milik orkestrator). O18 tidak boleh mendahului O10/O14.

Konflik yang sudah diputuskan:

- Penamaan: prioritas P0/P1/P2, fase P0-P5, pemetaan kanal F1-F5. Jangan campur.
- Kanal tidak dimulai sebelum P1/P2/P3; kanal awal hanya bisa menulis PTY langsung, melanggar A11.
- Approval chat wajib digest + nonce; tanpa diff tombol approve tidak dirender.
- Token bot adalah secret baru: Keychain/0600, bukan settings JSON; egress allowlist per kanal.
- Multi-user/RBAC tetap defer; v1 satu principal + allowlist chat.
- Bucket rate-limit kanal terpisah dari kuota spawn/token orkestrator.
- Audit menyimpan hash chat id + digest, bukan body.

---

## 17. Sumber

- Jcode clone: `/Users/bip/.jcode/scratch/jcode-src`, commit `cb602e1`.
- Artefak Jcode: `~/.jcode/scratch/orchestra/wave4-jcode-*.md`.
- Artefak eksternal: `~/.jcode/scratch/orchestra/wave4-caching.md`, `wave4-tools.md`,
  `wave4-memory2.md`, `wave4-reliability.md`, `wave4-eval.md`, `wave4-ux.md`,
  `wave4-intelligence.md`, `wave4-data.md`, `wave6-*.md`.
- `01-TEMUAN.md`, `90-REFERENSI/AGENT_PUSAT.md`.
