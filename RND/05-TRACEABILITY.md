# 05 — Traceability

Tanggal: 2026-10-31
Status: ringkasan perencanaan. Detail matriks mentah: `~/.jcode/scratch/orchestra/wave5-trace.md`,
`wave6-requirements.md`.

---

## 1. Angka

| Metrik | Nilai |
|---|---|
| Total requirement ID | 167 (145 + 22 omnichannel O) |
| Punya deliverable + file + test + evidence | 88 (52,7%) |
| Implisit (dibutuhkan, tidak dinyatakan) | 13 (7,8%) |
| Belum punya fase | 64 (38,3%) |
| Deferred eksplisit | 2 (1,2%) |
| Owner eksplisit | 0 |

Angka ini mengukur kelengkapan **perencanaan**, bukan bukti kode. Hanya P0 observation seam
yang punya executable test saat ini.

---

## 2. Domain dan fase

| Domain | ID | Fase utama | Catatan |
|---|---|---|---|
| Koordinasi | K1-K10 | P3 | parent edge, depth, plan, cap, recovery |
| State/ledger | S1-S15 | P2 | lease, fence, event, evidence, transcript owner |
| Memori | M1-M16 | P4 | claim/FTS5, supersede, quarantine, consolidation |
| Cache | C1-C14 | P2 data, P3 policy | prefix hash, sticky route, hit accounting |
| Context | X1-X11 | P3/P4 | measurement, compaction, cross-agent budget |
| Tool | T1-T12 | P3/P4 | catalog, deferred search, output spill, policy |
| Routing/auth | R1-R11 | P2 | route object, fallback, usage outbox, budget |
| Security | A1-A12 | P1/P3 | principal, blocking approval, blast radius, audit |
| Intelligence | I1-I12 | P3 | contract, plan, verify, reflection, ask policy |
| Eval | E1-E12 | P2/P3 | run record, false success, fault injection |
| UX | U1-U12 | P4 | inbox, peek/reply/attach, approval ladder, a11y |
| Data | D1-D8 | P2/P4 | backup, retention, export, encryption |

---

## 3. Omnichannel O1-O22

| Grup | ID | Fase |
|---|---|---|
| Adapter, normalisasi, outbound | O1-O3 | F2 |
| Identity, conversation mapping | O4-O5 | F3 |
| Intent routing, command grammar | O6-O7 | F2/F4 |
| Approval chat | O8 | F4 |
| Notifikasi | O9 | F5 |
| Dedupe, rate limit | O10-O11 | F3 |
| Security, audit | O12-O13 | F2/F3 |
| Offline/outbox | O14 | F4 |
| Preferensi, cross-channel | O15-O16 | F5 |
| UX link/revoke | O17 | F5 |
| Telegram auth/update/format/delivery | O18-O21 | F5 |
| Metrik kanal | O22 | F4 |

Pemetaan F ke P: F1=P0, F2=P1, F3=P2, F4=P3, F5=P4, lalu P5 omnichannel penuh. Lihat
`04-OMNICHANNEL.md`.

---

## 4. Gap terbesar

1. **Cache C1-C14** hampir seluruhnya belum punya fase, padahal hit rate mendominasi biaya.
2. **Context X1-X11** terdokumentasi tetapi belum ada owner.
3. **Tool catalog T1-T12** belum ada, padahal policy A3/A5 bergantung padanya.
4. **Routing R1-R10** belum dijadwalkan meski prioritas P0/P1.
5. **Reliability tail S9/S12-S15** (transcript epoch, crash vs detach, lazy revive,
   stall != failure) belum punya fase.
6. **Data D2-D8** (backup, restore drill, retention, export, encryption) belum dijadwalkan.
7. **UX U5/U7-U11** (interrupt budget, takeover, a11y, audit export) belum dijadwalkan.
8. **Eval E6-E8/E11/E12** belum dijadwalkan, sehingga coordination gain tidak terukur.
9. **Inverse hole:** deliverable P0 (multi-subscriber, seq log, fake harness, close/exit)
   tidak punya requirement ID. Blocker tidak terlihat di dokumen requirement.
10. **Autosave ETag/versioning** belum jadi requirement, padahal U8 membutuhkannya.

---

## 5. Kontradiksi yang sudah diputuskan

| # | Kontradiksi | Keputusan |
|---|---|---|
| 1 | Tiga taksonomi P (prioritas, fase, F) | Pakai P0-P4 untuk fase, F1-F5 hanya pemetaan omnichannel; prioritas ditulis P0/P1/P2 |
| 2 | Memori sebelum vs sesudah orkestrator | P4a claim/FTS5 sesudah P3; file promotion P4b |
| 3 | Satu jalur exec vs REST wrapper | WS `open` dan control `spawn` memanggil `sessions.open`; tidak ada jalur ketiga |
| 4 | Human edits win vs last-write-wins | ETag/CAS 409 di P2; UI konflik wajib |
| 5 | Principal selalu ada vs loopback token-free | Principal minimal `local-human`; agent route wajib capability |
| 6 | Cap 3 vs 3-5 | Pin 3 worker paralel, 3 attempt, lease 10 menit |
| 7 | Depth 2 spawn vs lane lead | Lane lead depth 2 tidak spawn |
| 8 | WAL vs db.ts tanpa pragma | P2 migration runner + `BEGIN IMMEDIATE` |
| 9 | E12 no pass@k vs acceptance n=1 | T2 paired arms untuk klaim koordinasi; acceptance n=1 hanya regresi |
| 10 | Transcript owner vs single send | P0 subscriber + P2 transcript lease epoch |

---

## 6. Cara memakai

1. Setiap PR menyebut ID requirement di judul/komentar.
2. Setiap test baru menyebut ID di nama atau komentar.
3. Matrix penuh diperbarui saat fase selesai, bukan saat dokumen ditulis.
4. Requirement tanpa owner harus diberi owner sebelum masuk implementasi.
5. Jangan menambah ID tanpa fase, file, test, dan evidence.
