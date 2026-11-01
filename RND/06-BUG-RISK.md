# 06 — Bug, Risiko, dan Deteksi Dini

Tanggal: 2026-10-31
Status: hasil bug hunt wave 5, read-only. Detail: `~/.jcode/scratch/orchestra/wave5-bughunt.md`.

---

## 1. Bug yang harus dicegah lebih dulu

| # | Bug | Trigger | Dampak | Mitigasi | Test |
|---|---|---|---|---|---|
| B1 | Save lintas-workspace menulis board salah | Edit lalu pindah workspace <400 ms | Dua board hilang diam-diam | Clear timer di `applyWorkspace`; capture refs; ETag | Harness: PUT body workspace A |
| B2 | Subscriber kedua mencuri stream; close tak terlihat | Dua tab/orkestrator | Viewer lain bisu; status beku | Set subscriber + broadcast exit | Dua open, satu close |
| B3 | Shell injection via `nodeId` | `id` berisi quote | Host RCE saat hook | Validasi `^[A-Za-z0-9_-]{1,64}$`; escape | Quote/newline test |
| B4 | Token root diwarisi child; status bisa dipalsukan | Agent POST status node lain | Forgery, arbitrary file read | Per-PTY token; `stateVerified`; path allowlist | Token A ke node B; `/etc` |
| B5 | Reconnect race, dua socket, output ganda | Drop saat node mount | Duplikat output, socket orphan | Single-flight connect; capture socket | Error socket lama |
| B6 | Tanpa backpressure; body/transcript unbounded | Output/JSONL besar | RSS naik, event loop stall | `bufferedAmount` gate; 413; baca tail | 413, drop frame |
| B7 | JSON blob korup membuat list 500 | PUT `nodes:null` | App tidak boot | Validasi shape; safe parse fallback; migration | Malformed row |
| B8 | Status `done` untuk shell biasa; token/transcript hantu | Shell exit | Badge salah; resume salah | `done` hanya agent; TTL; cleanup sama | Plain PTY tanpa status |
| B9 | Save error tidak terlihat | 403/disk penuh | Kehilangan data | Dirty flag, retry, indikator | Fetch reject |
| B10 | Re-attach mengabaikan geometry | Reconnect setelah resize | TUI wrap salah | Apply winsize saat reattach | Resize 120x40 |
| B11 | `generate-name` spawn tanpa batas | Loop endpoint | Process/fd exhaustion | Single-flight, timeout, secret scrub | Dua call satu child |
| B12 | Duplicate subscription saling menghapus | Split pane id sama | Terminal mati | Refcount; delete handler sendiri | Subscribe 2x |

B1 dan B3 diperbaiki di P0/P1. B2/B4 adalah blocker orkestrasi.

---

## 2. Risiko baru dari omnichannel

| # | Risiko | Mitigasi | Test |
|---|---|---|---|
| O-R1 | Bot token bocor lewat env/log/settings | Keychain/0600; tidak di env PTY; redaksi; rotasi | `env` child, log scan |
| O-R2 | Webhook forgery/replay | `secret_token` constant-time; `update_id` dedupe; 200 setelah persist | Replay 100x |
| O-R3 | Approval forgery dari chat | Callback MAC, digest, nonce, expiry, single-use, binding | Tamper/expired/replay |
| O-R4 | Cross-project leak | Conversation binding eksplisit; scoped query; approval project match | A query B |
| O-R5 | Group/unknown user approve | Group read-only; allowlist numeric id; role subset | Unbound press |
| O-R6 | Prompt injection lewat pesan/file | Teks = data; tidak auto-execute; upload quarantine | "approve rm -rf" |
| O-R7 | Rate limit/429 storm | Token bucket; `retry_after`; coalesce | Burst 30 |
| O-R8 | Channel down memblokir ledger | Outbox transaksional; dispatcher lease; dead-letter | Provider 500 1 jam |
| O-R9 | Duplikat outbound | `idem_key`; provider message id reconcile | Crash setelah send |
| O-R10 | Stale mapping setelah project archived | `mapping_version` + `project_epoch`; 409, suspend | Archived project |

---

## 3. Invariant yang harus dijaga

1. `map.get(id) === session` adalah satu-satunya gerbang exit; respawn tidak mewarisi exit.
2. `close` memberi tahu subscriber sebelum menghapus map dan sebelum kill.
3. Replay hanya ke joiner; subscriber lama tidak menerima scrollback ulang.
4. Task row dan event berubah dalam satu transaksi.
5. Setiap worker write memakai fence; stale fence ditolak.
6. Evidence wajib sebelum `verified`.
7. Chat tidak menulis PTY/task/decision/settings.
8. Approval hanya dari decision row, bukan teks.
9. Token bot tidak pernah masuk child PTY, log, settings JSON, atau URL.
10. Outbox insert dalam transaksi yang sama dengan state/event.

---

## 4. Deteksi dini

Metrics per fase:

| Fase | Metrics |
|---|---|
| P0 | subscribers/session, replay dup, dropped chunk, exit delivery miss, log truncation |
| P1 | 4xx per reason, hook 403 (harus 0), spawn failure, time-to-first-output, kill switch |
| P2 | migration ms, SQLITE_BUSY, lease expiry, suspect, stale-fence reject, wake latency, orphan |
| P3 | cap rejection, claimed->verified rate, verify failure reason, attempt/task, gate denial, orphan worktree |
| P4 | actionable inbox count, decision latency, unapproved irreversible, claim reject, stale fact |
| P5 | inbound lag, send failure, dedupe hit, approval latency, dead-letter, 429 count |

Alerts awal:

- Hook 403 > 0 setelah warn release.
- Replay duplicate > 0 pada sesi baru.
- Stale-fence reject > 0.
- Outbox backlog age > 5 menit.
- Approval expired tanpa notifikasi.
- Child env mengandung `WEBTERM_`/token pattern.
- Migration rollback atau `integrity_check` gagal.

---

## 5. Stop/go

- **G1 Seam:** dua subscriber output/exit sama; late join tanpa duplikat. Gagal = stop.
- **G2 Auth:** matriks token negatif lulus; hook Claude 200; tidak ada token di child.
- **G3 Data:** migrasi idempoten; crash tidak setengah state; row/byte sama.
- **G4 Orchestrator:** verified butuh evidence; human input tidak mencuri stream; cap memblokir.
- **G5 Memory:** worker tidak tulis fact/CORE; claim tanpa bukti ditolak.
- **G6 Central:** 2 project x 2 minggu, verified rate >=80%.
- **G7 Omnichannel:** replay 100x satu aksi; cross-project ditolak; approval blocking;
  channel down tidak memblokir ledger; token tidak ada di env/log.

---

## 6. Cara memakai

1. Setiap bug mendapat test regresi sebelum fix di-merge.
2. Jangan menambah fitur ke file yang sudah over-limit; pecah dulu.
3. Setiap alert harus punya runbook singkat dan owner.
4. Jangan menutup bug dengan "tidak tereproduksi" tanpa bukti log/metric.
5. Update tabel ini saat bug baru ditemukan; jangan biarkan di kepala agent.
