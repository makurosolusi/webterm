# 26 — CA2: Channel & Bot (central bisa dihubungi lewat chat, dan membuat bot sendiri)

Tanggal: 2026-11-03. Status: R&D, tanpa perubahan kode. Pemilik: `wkr-rnd-channels-01`.
Fondasi: `04`, `08` D7/D10/I10, `11` §5, `13` Phase D.

Metode: `WebSearch`/`WebFetch` gagal (API error 400); sumber primer dibaca dengan `curl` baca-saja pada dokumentasi resmi
publik, 2026-11-03. Tanpa login, tanpa panggilan API bot, `.env` tidak dibaca.

---

## 1. Ringkasan keputusan

1. **Telegram bisa membuat bot secara terprogram, tapi tidak tanpa manusia.** Sejak Bot API 9.6
   (2026-04-03) ada *Managed Bots*: bot "manager" menghasilkan link `https://t.me/newbot/{manager}/{username}?name=...`;
   **manusia harus membuka link dan menekan konfirmasi**; manager lalu menerima update `managed_bot` dan memanggil
   `getManagedBotToken` `[terverifikasi]`. Itu satu-satunya jalur resmi "bot buat bot" di Telegram. Pakai ini.
2. **Platform lain: akun bot tetap manual** (Discord, WhatsApp, LINE) atau semi-otomatis (Slack: `apps.manifest.create` + OAuth manusia).
3. **Central tidak pernah memegang token.** Ia hanya meminta (`channel.bot.propose`, tier R2); server yang memegang token
   di `SecretStore` 0600 yang sudah ada dan hanya mengembalikan `botId` + `@username` ke model.
4. **Bereskan celah Telegram dulu** (§2.2): webhook menunggu LLM, `callback_query` tak diterima, satu token global, dispatcher terkunci ke Telegram.
5. **Kanal kedua = Discord (interactions webhook) atau Slack, bukan WhatsApp.** Urutan: Telegram rapi -> adapter generik
   -> kanal ke-2 sebagai bukti kontrak. A2A/MCP-server ditunda (§3.9).

---

## 2. Temuan

### 2.1 Fondasi kode (fakta, dibaca dari kode)
| Hal | Bukti |
|---|---|
| Funnel: poll/webhook -> `dispatchTelegramUpdate` -> claim `update_id` -> binding -> parse -> authorize -> aksi -> outbox | `channels/channelDispatch.ts:249-282` |
| Chat non-command diteruskan ke central (`TelegramCentralPort.ask`) per `projectId` binding | `channelDispatch.ts:212-218`, `telegramCentralBridge.ts:19-49` |
| Grup ditolak total (`group_not_allowed`), tak ada mirror keluar | `channelDispatch.ts:200-203` |
| Pengirim tak dikenal ditolak diam-diam; chat tertunda dicatat (`PendingChatStore`) untuk pairing dari web | `channelDispatch.ts:204-208`, `channelPending.ts:6-8` |
| Role `viewer/operator/approver/owner`; approve/reject hanya `approver|owner` dan bukan dari grup | `identity.ts:6-9,76-90` |
| Grammar hanya `status/inbox/task/approve/reject/pause/resume` | `identity.ts:~99-107` |
| `/approve` butuh mengetik `approvalId digest nonce` | `identity.ts`, `channelApprovals.ts` |
| Store kanal = **satu file JSON** `channels.json` v1 (binding, dedupe 24 jam/4096, outbox 500, mode 0600 atomik), bukan SQLite seperti di `04` §2.2 | `channelStoreSchema.ts:5-10,27-36` |
| Egress: sender interval 5 dtk, backoff 1->60 dtk, 5 percobaan, dead-letter, token dibaca per kirim dari env | `telegramSender.ts:23-25`, `telegramSend.ts:23-29` |
| Token bot **hanya env**: `WEBTERM_TELEGRAM_BOT_TOKEN` (alias `TELEGRAM_BOT_TOKEN`); satu bot per proses | `telegramSend.ts:12-29` |
| Poll hanya meminta `allowed_updates: ['message']` -> `callback_query` & `managed_bot` tidak pernah tiba | `telegramPoll.ts:17,110` |
| Handler webhook `await runtime.dispatch(update)`; di jalur central itu menunggu LLM hingga `TIMEOUT_MS = 120_000` | `telegramWebhookHandler.ts:75`, `telegramCentralBridge.ts:8` |
| Ada `SecretStore` file 0600/dir 0700 (key `^[A-Z][A-Z0-9_]{0,63}$`), nilai tak masuk pesan error | `envSecrets.store.ts:9-13,25-30` |
| Webhook generik HMAC-SHA256 atas `${ts}.${body}`, replay 5 menit | `webhookSignature.ts:12-22` |
| Flag: `WEBTERM_CHANNELS` (kill switch), `WEBTERM_TELEGRAM`, `WEBTERM_CENTRAL_TELEGRAM`; butuh ledger | `channelsRuntime.ts:1-12`, `telegramCentralBridge.ts:12-14` |

### 2.2 Celah yang menghambat central lewat chat (analisis, belum diuji runtime)
- **G1 Webhook menunggu LLM.** Di mode webhook, balasan 200 baru keluar setelah central selesai (sampai 120 dtk).
  Telegram menganggap non-2xx/timeout sebagai kegagalan dan mengirim ulang (`04` §3: "Ack cepat"). Dedupe `update_id`
  mencegah dobel-proses, tapi pesan bisa tertunda/hilang. Poll mode memblokir loop poll selama turn berjalan.
  Fix: ack setelah claim durable, jalankan turn async, kirim hasil lewat outbox.
- **G2 Approval chat canggung.** Tanpa `callback_query` user harus menyalin digest+nonce. `callback_data` 1-64 byte
  `[terverifikasi: core.telegram.org/bots/api, 2026-11-03]` cukup untuk id opak; digest/nonce tetap di server.
- **G3 Satu bot, satu token, binding global `channel:chatId`.** Tanpa `accountId`, bot sendiri/bot per project mustahil.
- **G4 Dispatcher Telegram-spesifik** (`TELEGRAM_CHANNEL`, `parseTelegramUpdate`).
- **G5 Hanya teks balasan.** Tak ada kartu status editable; `threadId` outbound (`StoredReply`) tak dipakai central.
- **G6 Central tak punya intent selain "ask"** (butuh `22-CA2-CONTROL-PLANE`).

### 2.3 Fakta platform (sumber primer, dibaca 2026-11-03)
**Telegram** `[terverifikasi]` — https://core.telegram.org/bots/api-changelog dan https://core.telegram.org/bots/api:
- Versi terbaru **Bot API 10.3, 2026-08-24**; 10.2 (2026-07-14), 10.1 (2026-06-11), 10.0 (2026-05-08), 9.6 (2026-04-03).
- 9.6: `User.can_manage_bots`, `KeyboardButtonRequestManagedBot`, `Update.managed_bot` (`ManagedBotUpdated{user,bot}`),
  `getManagedBotToken`, `replaceManagedBotToken`, link `t.me/newbot/...`. 10.0: `getManagedBotAccessSettings` /
  `setManagedBotAccessSettings` (`is_access_restricted`, `added_user_ids` maks 10; "owner selalu punya akses").
- https://core.telegram.org/bots/features#managed-bots: manager harus mengaktifkan "Bot Management Mode" di
  BotFather MiniApp (manual, sekali); pembuat bot = pengguna yang menekan konfirmasi di jendela pembuatan
  (username/nama terisi tapi dapat diubah). Manager menerima `managed_bot`, lalu memanggil `getManagedBotToken`.
- 10.0: *Guest Mode* dan *bot-to-bot communication* (harus diaktifkan di BotFather).
- 10.1 *Rich Messages*; 10.2 *Ephemeral messages* (pesan grup terlihat satu user); 10.3 `MessageGenerationStopped`, `can_stop` pada `sendMessageDraft`.
- features: *Streaming Replies* (`sendMessageDraft`) hanya private chat; *Topics in private chats*.
- Batas: teks 4096, upload 50 MB, unduh 20 MB, broadcast 30 pesan/dtk (`retry_after` pada 429); webhook `secret_token` via header
  `X-Telegram-Bot-Api-Secret-Token`; getUpdates dan webhook saling eksklusif.

**Slack** `[terverifikasi]` — https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests dan
https://docs.slack.dev/reference/methods/apps.manifest.create (dibaca 2026-11-03): `apps.manifest.create` membuat app dari
manifest dengan *app configuration token* (di-generate manual per workspace+user, **kedaluwarsa 12 jam**, dirotasi via
`tooling.tokens.rotate`), rate limit Tier 1 (1+/menit). Respons memuat `credentials{client_secret,signing_secret}` dan
`oauth_authorize_url` -> **instalasi ke workspace tetap butuh persetujuan OAuth manusia**. Events butuh Request URL atau Socket Mode.

**Discord** `[terverifikasi]` — https://discord.com/developers/docs/resources/application, `/events/gateway`,
`/interactions/overview`, `/topics/rate-limits`: Application hanya `Get/Edit Current Application` (tak ada create; **manual** di Developer Portal). `MESSAGE_CONTENT` intent privileged (app >=100 guild wajib verifikasi
+ persetujuan); tanpa itu field konten kosong kecuali DM, mention, dan pesan sendiri. Interactions via HTTPS wajib verifikasi
header `X-Signature-Ed25519` + `X-Signature-Timestamp`. Global limit 50 req/dtk; baca header, jangan hardcode.

**WhatsApp Cloud API** — https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages (2026-11-03)
`[terverifikasi sebagian]`: pesan bebas ("service message") hanya dalam *customer service window* 24 jam sejak user terakhir
menulis; di luar itu wajib template yang disetujui. Throughput default 80 pesan/dtk per nomor (halaman overview, berbahasa
Indonesia). Verifikasi bisnis & WABA: manual di Meta. Header tanda tangan webhook (`X-Hub-Signature-256`) `[belum terverifikasi]`
(tidak ditemukan di halaman yang berhasil diambil; hanya dari ingatan).

**LINE** `[terverifikasi sebagian]` — https://developers.line.biz/en/docs/messaging-api/overview/ dan `/receiving-messages/`:
harus membuat LINE Official Account lalu Messaging API channel (console, manual); webhook **wajib verifikasi signature**
sebelum diproses; event redelivery membawa `replyToken` yang sama; kuota pesan gratis bergantung paket akun. Nama header
`x-line-signature` `[belum terverifikasi]`.

**Matrix** `[terverifikasi]` — https://spec.matrix.org/latest/ (v1.19), `/application-service-api/`: registrasi appservice
hanya lewat file konfigurasi homeserver (butuh admin); bot ringan = akun biasa + access token.

**A2A / MCP** `[terverifikasi]`: A2A **v1.0** (rilis GitHub terbaru v1.0.1, 2026-05-28; milik Linux Foundation; binding
JSON-RPC/gRPC/REST; breaking change dari 0.3: enum SCREAMING_SNAKE_CASE, `supportedInterfaces[]`, tanpa `kind` pada stream)
— https://a2a-protocol.org/latest/whats-new-v1/, https://api.github.com/repos/a2aproject/A2A/releases/latest.
MCP spesifikasi terbaru **2026-07-28**; ekstensi opsional *Tasks* (operasi panjang), *Skills over MCP*, *MCP Apps* —
https://modelcontextprotocol.io/specification/.

---

## 3. Opsi dan rekomendasi

### 3.1 Cara "central membuat bot"
| Opsi | Verdict | Alasan |
|---|---|---|
| A. Telegram Managed Bots (link + konfirmasi manusia + `getManagedBotToken`) | **PILIH** | API resmi, token tak pernah lewat chat/LLM, akses bisa dibatasi |
| B. Manusia buat di BotFather, tempel token di Settings | Fallback | Selalu jalan; dipakai untuk bot manager pertama |
| C. Otomasi BotFather lewat akun user (MTProto) | **TOLAK** | Butuh login akun pribadi, rapuh, risiko ToS |
| D. Slack manifest API | Tunda | Perlu config token 12 jam + OAuth install manusia; nilai rendah untuk pengguna tunggal |
| E. Discord/WhatsApp/LINE otomatis | **Mustahil** | Tak ada API create (Discord) / butuh verifikasi bisnis (WA, LINE) |

### 3.2 Alur Managed Bot (rancangan)
```
central: tool channel.bot.propose{purpose, project?, suggestedUsername}      [R2: approval manusia]
  -> server buat link t.me/newbot/<manager>/<username>?name=...  (state: link_issued, TTL 24 jam)
  -> approval web/Telegram (kartu: nama, username, tujuan, scope, role awal)
  -> manusia buka link & konfirmasi di Telegram            [langkah manusia, tak bisa dilompati]
  -> update managed_bot{user,bot} ke manager (allowed_updates + 'managed_bot')
  -> server cek: user.id == pemilik terikat (owner binding) & ada pending proposal cocok -> else abaikan+audit
  -> getManagedBotToken (server) -> SecretStore.write('CHBOT_<ID>_TOKEN') -> getMe verifikasi
  -> setManagedBotAccessSettings{is_access_restricted:true, added_user_ids:[owner]}
  -> state active; tool result ke model: {botId, username}  (TANPA token)
```
Rotasi: `replaceManagedBotToken` lalu tulis ulang secret. Revoke: hapus secret, state `revoked`, hentikan poll bot itu.

### 3.3 Arsitektur adapter (minimal, bukan framework)
```ts
interface ChannelAdapter {
  kind: string                         // 'telegram' | 'discord' | 'webhook' ...
  caps: { maxText: number; edit: boolean; buttons: boolean; threads: boolean; stream: boolean; groupMirror: boolean }
  verify(req): InboundEvent | null     // signature/secret + normalisasi; murni
  render(msg: OutMessage): ProviderPayload   // blok netral -> format provider, escape teks tak tepercaya
  send(accountId, payload): Promise<SendResult> // 429/retry_after dihormati, token dari SecretStore
}
```
- `InboundEvent{kind, accountId, externalEventId, chatId, userId, isGroup, threadId?, text, callbackId?}` menggantikan
  `NormalizedMessage` Telegram. `dispatchInbound` = `dispatchTelegramUpdate` yang dibuat generik (rename + ganti tipe; logika
  claim/authorize/outbox tidak diubah).
- `OutMessage{text, card?: {title, status, actions[{id,label}]}, replyTo?, threadKey?}`; `render` per kanal memotong sesuai
  `caps.maxText` (Telegram 4096).
- Registrasi kanal = array statis `ADAPTERS` di satu file (cukup; "plugin" dinamis dari disk TIDAK dibuat: kode asing = risiko).
- Ukuran: `channelAdapter.ts` <=120, `inboundDispatch.ts` <=300, tiap adapter <=250 (Rule 8).

### 3.4 Akun, binding, penyimpanan
- `channels.json` v1 -> **v2 aditif**: `accounts: Record<accountId,{kind,username,purpose,state,managed:boolean,createdAt}>`; kunci binding
  `channel:accountId:chatId`; migrasi otomatis v1 -> `accountId='default'` dengan backup `channels.json.v1.bak` (I12/Rule 4).
  Tetap JSON sampai terbukti kurang; jangan pindah SQLite demi estetika.
- Token: `SecretStore` (`envSecrets.store.ts`), key `CHBOT_<ACCOUNTID>_TOKEN` (cocok regex key); fallback env lama untuk akun `default`.
  Token tak boleh di `channels.json`, settings, env PTY, log, outbox; error lewat `redactSecrets`.
- Pairing tetap: kode sekali pakai dari web (`11` §5), unknown sender ditolak; **bot baru tidak mewarisi binding** — owner
  harus pair ulang per bot (mencegah bot hasil buat-sendiri otomatis dipercaya).

### 3.5 Approval lewat chat
- Tambah `callback_query` ke `allowed_updates` (juga di `setWebhook`). Tombol `Approve`/`Deny` dengan `callback_data = "a:<opaqueId>"`
  (<=64 byte). Server memuat kartu (digest, nonce, expiry) dari ledger; menekan tombol = `decideApproval` dengan identitas
  `userId` Telegram yang cocok binding `approver|owner`, private chat saja.
- Pertahankan: blocking, digest-bound, kedaluwarsa, satu keputusan authoritative.
- Grup tetap tidak boleh approve (D10). *Ephemeral messages* 10.2 membuat kartu approval di grup terlihat satu user, tetapi
  identitas grup tetap ambigu; **tidak** dipakai untuk approval sampai ada keputusan produk.
- "yes" bukan consent; `/approve id digest nonce` jadi fallback tanpa tombol.

### 3.6 Rate limit, outbox, idempotensi
- Outbox yang ada sudah punya `dedupeKey`, backoff, dead-letter; tambah **antrean per akun+chat** (<=1 pesan/dtk/chat, 20/menit
  grup — angka `04` §3, belum diverifikasi ulang di §2.3) dan hormati `retry_after` dari 429 (cek apakah sudah di `telegramSend.ts`
  `[belum diperiksa]`).
- Idempotensi egress: `turnId:partIndex`.
- Pesan status = **satu pesan editable per task** (edit <=1 per 2-3 dtk); `sendMessageDraft` untuk streaming hanya private chat.
- Ack cepat (G1): `claimUpdate` -> 200 -> turn async -> hasil ke outbox; "central bekerja" hanya bila turn >3 dtk.

### 3.7 Mirror read-only untuk grup
Satu arah: ledger event (task selesai, approval minta, error) -> `OutMessage` ke grup opt-in owner. Inbound grup tetap ditolak
kecuali `/pair` dari owner (membuat mirror, role `viewer`). Isi: ringkasan ber-ID, tanpa path absolut/transcript/secret (I13).
Pesan grup tidak pernah diteruskan ke central sebagai instruksi.

### 3.8 Pengendalian worker dari chat (jembatan ke `22`)
Grammar tambahan deterministik (tanpa `/exec`): `/spawn <jenis> <task>`, `/agents`, `/assign <agent> <teks>`, `/close <agent>`, `/kill`.
Semuanya hanya membuat intent/proposal ke control plane (`22-CA2-CONTROL-PLANE.md`); tier R0-R3 dan approval ada di sana.

### 3.9 Kanal lain dan protokol
| Kanal | Prioritas | Catatan |
|---|---|---|
| Telegram | sekarang | rapikan G1-G5, lalu Managed Bots |
| Webhook generik (ada) | sekarang | HMAC sudah ada; jadikan adapter `webhook` (inbound+outbound ke URL allowlist) |
| Discord (interactions, bukan gateway) | ke-2 | tanpa `MESSAGE_CONTENT`: hanya slash command/tombol; bot manual; verifikasi Ed25519 |
| Slack | ke-3 | Socket Mode menghindari URL publik; instal tetap OAuth manusia |
| Email | opsional | risiko spoofing tinggi (From dapat dipalsukan); butuh keputusan |
| WhatsApp, LINE, Matrix | tunda | verifikasi bisnis/console/admin manual; template & kuota |
| A2A server | tunda | v1.0 baru (breaking vs 0.3); hanya bila agen eksternal perlu memanggil central |
| MCP | bukan kanal | tool central sudah MCP stdio (`08` §5) |

---

## 4. Risiko & mitigasi
| Risiko | Mitigasi |
|---|---|
| **Prompt injection via pesan kanal** (teks, forward, nama, caption) | Pesan kanal = data tak tepercaya (I10); central tidak punya tool tulis tanpa approval; sender harus ter-bind; sanitasi/escape saat render; jangan menyertakan isi pesan kanal ke tool args mentah |
| **Spoofing pengirim** | Cek `userId` numerik vs binding (ada: `user_mismatch`), `secret_token` webhook, signature Discord/LINE/HMAC; tolak update dari bot lain kecuali bot-to-bot sengaja diaktifkan |
| **Confused deputy via bot manager** | Hanya `ManagedBotUpdated.user.id == owner` + proposal pending; selain itu abaikan+audit; akses bot baru dibatasi ke owner |
| **Token bocor** | SecretStore 0600; tak ada di prompt/tool result/log; `redactSecrets`; token dibaca per kirim; rotasi `replaceManagedBotToken` |
| **Bot buat bot tanpa batas** | Maks bot aktif (mis. 3), TTL proposal 24 jam, 1 pending, kill-switch `WEBTERM_CHANNELS=off` |
| **Eksfiltrasi lewat channel** | Kirim hanya ke chat ter-bind/mirror opt-in; tak ada "send to arbitrary chat_id"; redaksi sebelum outbox |
| **Guest Mode / bot-to-bot (10.0)** jalur masuk baru | Biarkan nonaktif di BotFather; abaikan `guest_message` |

## 5. Dampak ke invarian/keputusan lama
- **D10 / `08` §10.7 tetap.** Tidak ada approval dari grup, tidak ada auto-enroll; ditambah "bot hasil buat-sendiri tidak mewarisi binding".
- **Baru (usulan I15):** pembuatan bot butuh approval R2 + konfirmasi manusia di platform; token tak pernah masuk model.
- **I5** tidak diubah di sini; `/spawn` di chat hanya intent ke `22`.
- `04` §2.2 (tabel SQLite channel) tidak diimplementasi; store aktual JSON. Usul: ubah `04` menjadi "JSON v2 aditif" atau catat penyimpangan.
- `04`/`11` belum mencatat Managed Bots (9.6); Bot API 10.3 di `04` benar per changelog.

## 6. Urutan kerja (slice flag-gated)
1. **S1** Ack cepat + turn async (G1) dan `callback_query` + tombol approval (G2). Test: webhook <1 dtk saat runtime lambat; tombol -> `decideApproval`.
2. **S2** Rename dispatcher generik + `ChannelAdapter` + `accountId` (channels.json v2 + migrasi/backup) (G3/G4). Test migrasi v1->v2.
3. **S3** Kartu status editable + topic per project (G5).
4. **S4** Managed Bots: `channel.bot.propose`, handler `managed_bot`, SecretStore, `getMe`. Butuh bot manager nyata + 1 konfirmasi manusia
   (uji manual wajib; unit test dengan fetch palsu).
5. **S5** Adapter Discord interactions (kontrak terbukti oleh kanal ke-2).

## 7. Pertanyaan terbuka (butuh keputusan produk)
1. Bot per project, atau satu bot + topic per project? Rekomendasi: satu bot + topic dulu.
2. Bot manager: pakai bot Telegram yang sudah ada milik user atau bot baru khusus? (Mode "Bot Management Mode" diaktifkan manual.)
3. Kanal ke-2 yang benar-benar dipakai user: Discord, Slack, atau cukup Telegram + webhook?
4. Tombol approval menggantikan ketik `/approve ... digest nonce` sebagai default? 5. Mirror grup di v1?

## 8. Yang TIDAK terverifikasi
- Perilaku nyata Managed Bots (tidak ada panggilan API; hanya dokumentasi). Nama pasti string `allowed_updates` untuk `managed_bot`/`callback_query` diturunkan dari nama field `Update`, belum dites.
- Apakah ada method hapus bot terkelola; apakah ada batas jumlah bot per manager/akun; biaya/kuota.
- Header signature WhatsApp (`X-Hub-Signature-256`) dan LINE (`x-line-signature`); batas karakter pesan Discord/Slack/WhatsApp/LINE (tidak dikutip).
- Angka rate limit per chat Telegram (1 pesan/dtk, 20/menit grup) berasal dari `04` §3, tidak diverifikasi ulang; beberapa tabel §2.3 hanya dibaca dari teks halaman yang di-scrape, bukan dari browser.
- ToS Telegram untuk otomasi BotFather via akun user (opsi C ditolak tanpa membaca ToS).
- Seluruh isi §2.1-2.2 adalah pembacaan statis kode; tidak ada tes dijalankan. Hubungan G1 pada mode poll belum dibuktikan dengan eksekusi.
- Tanpa pencarian sumber sekunder (WebSearch/WebFetch error); hanya dokumentasi resmi.
