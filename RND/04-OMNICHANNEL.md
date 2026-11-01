# 04 — Omnichannel Control Plane

Tanggal: 2026-10-31
Status: riset dan desain, belum diimplementasikan.
Induk: `README.md`. Kebutuhan: `02-KEBUTUHAN.md` O1-O22. Rencana: `03-RENCANA.md` P5.

---

## 1. Keputusan

Agent pusat harus bisa dikendalikan dari web UI **dan** kanal eksternal, tetapi kanal
adalah **adapter ingress yang tidak tepercaya**, bukan control plane kedua.

Aturan inti:

1. Semua perintah kanal masuk ke control API/ledger yang sama dengan web.
2. Kanal tidak pernah menulis PTY, task, decision, atau settings secara langsung.
3. Approval dari chat tetap **blocking**, terikat digest, nonce, expiry, dan identitas.
4. Web UI tetap sumber kebenaran dan tampilan kaya. Chat adalah proyeksi + intent.
5. Telegram adalah kanal remote pertama. v1: in-app inbox, CLI, generic webhook,
   Web Push, Telegram (flag off). Slack/Discord/WhatsApp/SMS ditunda.

Alasan Telegram v1:

- Tanpa OAuth, app review, atau biaya platform.
- Mendukung webhook `secret_token`, inline keyboard, edit message, topic/thread.
- Batasnya jelas: 4096 char, 64 byte callback, at-least-once update.
- Risikonya bisa dikontrol dengan binding, dedupe, dan approval blocking.

---

## 2. Arsitektur satu funnel

```
provider -> verify + size cap -> dedupe -> normalize -> identity -> conversation bind
         -> command grammar -> route -> controlService / decisionService
         -> ledger event + outbox -> provider send
```

Setiap langkah pure kecuali tiga service eksplisit: `controlService`, `decisionService`,
`channelService`. Tidak ada command yang cocok menjadi `ask` ke agent; balasan agent
adalah proposal, bukan aksi.

### 2.1 Modul

| Modul | Tanggung jawab | Batas |
|---|---|---|
| `channels/types.ts`, `registry.ts` | adapter contract, capabilities, registrasi | 200 |
| `channels/ingress.ts`, `normalize.ts`, `dedupe.ts` | body cap, signature, replay window, event kanonik | 300 |
| `channels/identity.ts`, `conversation.ts`, `grammar.ts` | principal, bind/relink, command parse | 300 |
| `channels/commands.ts`, `decisions.ts` | panggil control/decision service | 200 |
| `channels/outbox.ts`, `notifyPolicy.ts`, `health.ts` | enqueue/claim/send, rate/quiet/presence | 300 |
| `channels/telegram/*` | parse update, render, callback, delivery | 200 per file |
| `channelsApi.ts` | route + auth | 150 |

`api.ts` hanya mendaftarkan `channelsRoute(...)` satu baris. Tidak menambah logika ke
`sessions.ts` atau `api.ts` yang sudah di batas.

### 2.2 Tabel

- `channel_account`: kind, external_id, label, secret_hash, config_json, status.
- `channel_identity`: account_id, external_user_id, principal_id, role, verified_at.
- `channel_conversation`: account, chat/thread, project/workspace/node, state, version.
- `channel_message`: external_event_id, idem_key, payload, status, result_ref,
  `UNIQUE(account_id, external_event_id)`.
- `channel_outbox`: dedupe_key, kind, payload, urgency, attempts, next_at, lease,
  provider_message_id.
- `channel_presence`, `channel_policy`: heartbeat, quiet hours, fallback.
- `channel_audit` atau reuse `event` P2: actor, update_id, callback_id, digest, result.

Semua `*_json` memakai `json_valid`. Satu koneksi SQLite, satu writer per domain.

### 2.3 Route

| Route | Auth | Perilaku |
|---|---|---|
| `POST /api/channels/:id/webhook` | signature kanal | 200/202 setelah durable insert, bukan setelah LLM |
| `GET /api/channels`, `/:id/health` | principal admin | adapter, breaker, backlog, last error |
| `POST /api/channels/:id/link` / `unlink` | principal | kode sekali pakai, revoke binding |
| `GET /api/channels/:id/conversations`, `/audit` | principal | mapping/status, audit |
| `POST /api/channels/outbox/:id/retry` | principal | retry dead-letter |

Webhook tidak boleh memakai `WEBTERM_TOKEN`; verifikasi per kanal. Admin route memakai
principal biasa. Duplikat `requestId` me-replay ack.

---

## 3. Telegram: fakta yang membentuk desain

Bot API 10.3 (2026-08-24):

| Kebutuhan | Primitive | Batas |
|---|---|---|
| Terima update | `setWebhook` atau `getUpdates` | saling eksklusif |
| Auth webhook | `secret_token` header | 1-256 char `[A-Za-z0-9_-]` |
| Ack cepat | return 2xx, proses async | non-2xx memicu retry |
| Status hidup | `editMessageText` | 4096 char |
| Approval | inline keyboard + `callback_query` | `callback_data` 1-64 byte |
| Command menu | `setMyCommands` | <=100, UI saja, bukan authz |
| Binding user | deep link `?start=<payload>` | payload <=64 char |
| Project thread | forum topic `message_thread_id` | private chat + topic enabled |
| File | `sendDocument`/`getFile` | download 20 MB, upload 50 MB |
| Rate | ~1 msg/s per chat, 20/min group, 429 `retry_after` | hormati persis |
| Retensi update | 24 jam | downtime >24 jam kehilangan command |

Konsekuensi:

- Satu pesan status editable per task, bukan satu pesan per event.
- Project = topic, task = anchor message; reply memakai `reply_to_message`.
- Update at-least-once: dedupe `update_id`, persist sebelum 200.
- Callback hanya opaque id; state dan digest ada di server.
- Jangan render Markdown/HTML dari teks tak tepercaya; escape.
- Jangan pakai `drop_pending_updates` sembarangan.
- Jangan taruh token di URL, log, env PTY, atau settings JSON.

---

## 4. Identitas dan izin

- Satu principal manusia (owner) untuk v1, dengan allowlist numeric Telegram user id.
- Binding hanya lewat kode sekali pakai dari web UI: 8-10 char, TTL 5-10 menit,
  single-use, hash at rest, terikat channel dan principal.
- Unknown sender: tolak diam-diam + audit. Jangan auto-enroll dari first message.
- Role: viewer (status), operator (prompt/spawn dalam workspace), approver (decision),
  owner (link/revoke). Role adalah subset capability principal.
- Group chat boleh menjadi mirror/read-only. **Group tidak boleh approve** karena
  identitas dan kerahasiaan ambigu.
- Revoke/unlink mencabut capability tanpa restart; conversation menjadi suspended.
- Setiap command memvalidasi channel, identity, conversation, project, workspace,
  mapping version, dan project epoch. Mismatch -> 409 `mapping_stale`, minta relink.

---

## 5. Command grammar

Deterministik, case-insensitive, ASCII prefix, maks 512 char:

```
/status [project]        /projects
/task <id>               /plan [project]
/approve <decision-id>   /deny <decision-id> [reason]
/pause [project]         /resume [project]
/peek <task>             /reply <task> <text>
/attach <task>           /logs <task> [n]
/link <code>             /help  /cancel
```

- Tidak ada `/exec`, shell, raw cmd, file write, atau settings.
- `/approve` membuka kartu decision; tidak langsung mengeksekusi.
- Bare "yes" hanya berlaku jika tepat satu pending decision di conversation itu,
  ditampilkan dengan digest <=10 menit, dan identity linked. Selain itu tanya.
- Pesan bebas menjadi `ask` berbiaya, tidak dieksekusi; agent membalas proposal +
  command berikutnya.
- Command tidak dikenal -> daftar command, bukan tebakan.

---

## 6. Approval di chat

Kartu wajib memuat:

- project/task, aksi, alasan, digest pendek, evidence (test/lint/diff hash), expiry.
- Tombol `Approve...`, `Deny...`, `Open in webterm`.
- Aksi irreversible: dua tahap, tombol kedua menyebut objek (`Push to main`), plus
  typed confirm. Expiry tidak pernah auto-approve.

Alur:

1. P2/P3 membuat blocking `decision`; control service menunggu.
2. Transaksi yang sama enqueue `approval.request`.
3. Callback diverifikasi signature + identity + chat binding, lalu resolve berdasarkan
   `(decision_id, project_id, conversation_id, principal_id, digest)`.
4. `decision.applied` commit sebelum service bangun; service membaca ulang dan
   menolak jika stale.
5. Deny menulis alasan dan membangunkan service dengan refusal.
6. Teks agent tidak pernah bisa approve. Approval out-of-band, single-use, digest-bound.

`callback_data` = `v1.<id>.<exp>.<mac>` <=64 byte. Server row adalah kebenaran; MAC,
expiry, binding, message ownership, single-use dicek sebelum efek.

---

## 7. Notifikasi dan perhatian

| Level | Event | Aksi |
|---|---|---|
| N0 | rutin selesai | silent, cukup inbox |
| N1 | update status | edit topic/task card |
| N2 | needs you, irreversible pending, broken, approval expiring | push |
| N3 | masih blocked setelah T | satu escalation |

- Interrupt budget: <=1 push/10 menit, coalesce per project.
- Quiet hours default 22:00-07:00; hanya approval irreversible/expiring yang menembus.
- Digest saat quiet berakhir atau `/digest`.
- Jangan notifikasi tiap turn; notifikasi spam melatih dismissal.
- Presence 90 detik hanya untuk memilih kanal, bukan auth.
- Fallback: Telegram -> Web Push -> in-app inbox. Tidak ada baris yang hilang.

---

## 8. Dedupe, ordering, dan reliabilitas

- Inbound key: `(account_id, external_event_id)` unik. Duplikat mengembalikan hasil
  tersimpan tanpa efek kedua.
- Provider tanpa id: `raw_hash` + window 10 menit.
- Action key: `hash(conversation_id, message_id, verb, target_version)`, disimpan di
  message dan ledger event.
- Ordering: `received_at` lokal adalah otoritas; `provider_ts`/`external_seq` hint.
  Per-thread `last_applied_seq` adalah fence; command lama disimpan `stale`, tidak
  dieksekusi.
- Outbox transaksional: insert di transaksi yang sama dengan state/event; dispatch
  setelah commit; tidak ada network call di dalam transaksi.
- Single dispatcher lease; satu in-flight per conversation; backoff + jitter;
  dead-letter + alert; ledger tidak pernah diblokir.
- 429: hormati `retry_after`; jangan retry buta.
- Channel down: inbound tetap jalan, outbound pending, backlog age = health signal.

---

## 9. Keamanan

- Bot token, webhook secret, dan callback HMAC key di Keychain atau file 0600/0700.
  Tidak di env global, settings JSON, repo, log, atau child PTY.
- Webhook: HTTPS, path acak, `secret_token` constant-time, optional IP allowlist,
  body <=64 KiB, rate limit per akun.
- Callback: MAC, expiry, binding, message ownership, single-use, digest re-check.
- Chat bukan sistem audit: pesan bisa diforward/screenshot. Jangan kirim secret,
  transcript penuh, diff besar, env, path home, atau token.
- Redaksi egress: token pattern, Bearer, `wcap_`, `sk-`, base64 panjang, home path.
- Upload: quarantine di luar repo, MIME/size allowlist, tidak dieksekusi, hash.
- Audit: actor, update_id, callback_id, action_digest, result, hash chain. Body tidak
  disimpan mentah; simpan sha256/len/class.
- Emergency revoke: flag off, stop adapter, delete webhook, revoke bindings, expire
  callback, rotate token/secret/HMAC, drain backlog, audit.

---

## 10. Integrasi dengan webterm

Prasyarat: P0 subscriber, P1 control API/scoped token, P2 ledger/dedupe, P3 approval,
P4 inbox. Kanal **tidak boleh** mulai sebelum P3.

File baru:

- `src/server/channels/` (types, registry, ingress, normalize, dedupe, identity,
  conversation, grammar, commands, decisions, outbox, notifyPolicy, health).
- `src/server/channels/telegram/` (auth, update, render, callback, delivery, adapter).
- `src/server/channelsApi.ts`.
- `src/client/SettingsChannels.tsx`, `channelLink.ts`.

Reuse: `controlApi`, `capabilities`, `decisionsRepo`, `eventRepo`, `sessions.outputLog`,
`config.dataDir()`, redactor.

Config: `WEBTERM_CHANNELS=off|shadow|on`, `WEBTERM_TELEGRAM=off|readonly|control`,
`WEBTERM_CHANNEL_BASE_URL`, `WEBTERM_CHANNEL_SECRETS_FILE`, max body, rate, outbox
interval/attempts/backoff. Token bot hanya env/Keychain; DB hanya `secret_hash`.

Fase P5. Gate G7: replay 100x satu aksi, cross-project ditolak, approval blocking,
channel down tidak memblokir ledger, token tidak ada di env/log.

---

## 11. Requirement O1-O22 (ringkas)

| Grup | ID | Isi |
|---|---|---|
| Adapter | O1-O3 | contract, normalisasi inbound, outbound idempoten |
| Identitas | O4-O5 | link code, conversation -> project/session/task |
| Routing | O6-O7 | intent vs command, grammar deterministik |
| Approval | O8 | digest, nonce, single-use, blocking |
| Notifikasi | O9 | transisi state, quiet hours, digest |
| Dedupe/rate | O10-O11 | update id, outbox idem, token bucket |
| Keamanan/audit | O12-O13 | allowlist, redaksi, audit hash chain |
| Offline | O14 | outbox, retry, dead-letter |
| Preferensi | O15-O16 | route per project/severity, satu kanal authoritative |
| UX | O17 | SettingsChannels, link/revoke/status |
| Telegram | O18-O21 | auth, update semantics, format/limit, delivery |
| Metrik | O22 | lag, gagal, dedupe, approval latency, dead-letter |

Fase: F2 (O1-O3, O7, O12), F3 (O4, O5, O10, O11, O13), F4 (O6, O8, O14, O22),
F5 (O9, O15-O21).

---

## 12. Yang tidak boleh dilakukan

1. Menjadikan chat sebagai ledger atau sumber audit.
2. Menganggap "yes" sebagai approval.
3. Satu adapter yang meng-hardcode semua kanal di orkestrator.
4. Mengirim token, env, transcript, atau diff besar ke chat.
5. Approve dari group atau unknown chat.
6. Auto-enroll user dari first message.
7. Return 200 sebelum persist, atau kerja sinkron di handler webhook.
8. Streaming edit per token; coalesce.
9. Raw `cmd`, shell, SQL, file write dari chat.
10. Mengandalkan `callback_data` sebagai bukti; server row adalah bukti.

---

## 13. Acceptance test

- Replay webhook 100x: satu `channel_message`, satu aksi, ack identik.
- Command out-of-order: yang baru menang, yang lama `stale`.
- Conversation A query B: tidak ada teks/id yang bocor; approval cross-project ditolak.
- Project archived/unlinked: 409, tanpa aksi.
- Provider 500 satu jam: outbox pending, ledger aman, recovery mengirim sekali.
- Quiet hours menahan status, approval urgent menembus.
- Approval expired/digest mismatch/replay: ditolak.
- Static check: `channels/` tidak mengimpor `sessions` dan tidak `UPDATE task`.
- Child PTY `env`: tidak ada token bot/HMAC/webhook secret.
- Audit chain mendeteksi edit/hapus.

---

## 14. Prior art (2026)

- **OpenClaw/Hermes**: gateway sebagai control plane, adapter per kanal, pairing deny-by-default,
kode 8 karakter, allowlist per platform, hardline blocklist yang tidak bisa di-override, delivery
ledger at-least-once dengan label "mungkin duplikat".
- **Claude Code Telegram bot**: SQLite per user/project, approved directory, token bucket, project
  topics, voice/image, tanpa kartu approval interaktif.
- **CLI-WeChat-Bridge**: pairing dari terminal, meneruskan approval CLI ke chat; AGPL, tidak cocok
  untuk reuse proprietary.
- **Omnara**: agent di thread Slack/Discord/GitHub, approval di thread, platform bukan bridge tipis.
- **LangBot/n8n**: layer kanal populer, tetapi auth/approval harus dibangun sendiri.

Pola yang dipakai: pairing code, allowlist, gateway control plane, durable delivery, project topic.
Pitfall: "yes" teks sebagai approval, identitas hanya platform, tanpa allowlist, reuse lisensi AGPL,
platform yang bukan bridge tipis.

---

## 15. Sumber

- Telegram Bot API 10.3: https://core.telegram.org/bots/api
- Telegram Bots FAQ: https://core.telegram.org/bots/faq
- Slack rate limits: https://api.slack.com/docs/rate-limits
- Discord rate limits: https://discord.com/developers/docs/topics/rate-limits
- WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/overview
- Standard Webhooks: https://www.standardwebhooks.com/
- Web Push RFC 8030: https://datatracker.ietf.org/doc/html/rfc8030
- Artefak: `~/.jcode/scratch/orchestra/wave6-*.md`
