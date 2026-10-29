// Satu tanggung jawab: memetakan stdin JSON sebuah hook Claude Code ke `AgentStatus`. Dipecah dari
// `hooks.ts` (yang sudah di batas budget service-nya) karena ini satu-satunya bagian modul itu yang
// MENAFSIRKAN payload hook — sisanya merakit langganan, token, dan baris peluncuran.
import type { AgentStatus } from '../shared/workspace'

/**
 * Field payload hook yang menentukan status. `agent_id` ADA hanya pada event yang berasal dari
 * SUBAGENT claude, dan itulah yang membuatnya penting di sini (lihat guard pertama di bawah).
 */
export interface HookStatusBody {
  hook_event_name?: string
  /** Id subagent claude. Absen pada event agent utama. */
  agent_id?: string
  /** Sub-jenis sebuah `Notification`. Satu event, beberapa arti — lihat `NOTIFICATION_STATUS`. */
  notification_type?: string
}

/**
 * Sub-jenis `Notification` yang BENAR-BENAR memindahkan status, disalin dari nodeterm
 * `src/shared/agents/normalize.ts:451-481` (`normalizeClaude`, cabang `Notification`).
 *
 * `Notification` bukan satu keadaan: ia satu event dengan beberapa arti, dan memetakannya borongan
 * ke `waiting` menggabungkan "aku minta izinmu" dengan "turn-ku sudah habis". Selama chip webterm
 * membaca keduanya "NEEDS YOU" kesalahan itu tak terlihat; begitu labelnya dipecah, notifikasi izin
 * jadi terbaca "turn selesai" — kebalikan dari maksudnya.
 *
 * Yang SENGAJA tidak ada di sini, dan kenapa:
 * - `idle_prompt` → TIDAK memetakan ke apa pun. nodeterm memakainya sebagai penyelamat node yang
 *   tersangkut `working`, tapi hanya di bawah aturan sempit "ia boleh memindahkan node yang MASIH
 *   working" (normalize.ts:472-479). `hookStatus` fungsi murni atas payload — ia tidak tahu status
 *   sekarang — jadi webterm tak bisa menyatakan aturan itu, dan tanpa aturan itu `idle_prompt`
 *   menurunkan node yang sedang `blocked`: nodeterm mencatat ia BISA menyala saat prompt izin masih
 *   terbuka ("`blocked`/`waiting` → must NOT be cleared"). Menurunkan badge merah padahal dialog
 *   izinnya masih menunggu adalah kebohongan ke arah yang berbahaya. Node yang tersangkut `working`
 *   di webterm sudah punya penyelamatnya sendiri: sapuan basi (`src/shared/agentStale.ts`).
 * - `auth_success`, `elicitation_complete`, `elicitation_response`, `agent_completed`, dan jenis
 *   apa pun yang belum kita kenal: informasional. Default-nya no-op, bukan badge yang menempel —
 *   aturan nodeterm yang sama (normalize.ts:454-456, `return null` di akhir cabangnya).
 *
 * TIDAK ADA sniff regex atas `message`-nya: mencocokkan kata di teks notifikasi salah ke dua arah
 * (nudge idle yang menyebut "approve" terbaca blocked; prompt izin dalam bahasa lain tidak terbaca
 * sama sekali). `notification_type` adalah field yang memang menyatakannya.
 */
const NOTIFICATION_STATUS: Record<string, AgentStatus> = {
  // Prompt izin yang datang sebagai notifikasi, bukan sebagai `PermissionRequest`. MANDEG.
  permission_prompt: 'blocked',
  // Agent menanyakan sesuatu lewat dialog, bukan memblokir sebuah tool.
  elicitation_dialog: 'waiting',
  agent_needs_input: 'waiting',
}

/**
 * Memetakan stdin JSON sebuah hook claude ke status live. null = event yang kita abaikan.
 *
 * `Notification` bercabang pada `notification_type` (lihat `NOTIFICATION_STATUS`), TANPA sniff
 * regex atas teks pesannya: `PermissionRequest` dan `notification_type: 'permission_prompt'` adalah
 * sinyal yang sebenarnya untuk "sedang menunggu izin".
 *
 * `SessionStart` SENGAJA TIDAK ADA di tabel ini. Claude menyalakannya saat CLI start — sebelum
 * prompt pertama diketik — jadi memetakannya ke `working` membuat setiap node yang baru lahir,
 * yang sedang duduk diam di input box-nya, terbaca RUNNING padahal tidak ada yang berjalan. Ia
 * batas SIKLUS HIDUP sesi, bukan perubahan state; nodeterm memperlakukannya persis begitu
 * (`normalizeClaude` → `{ kind: 'session', sessionPhase: 'start' }`, yang di Canvas jatuh ke
 * `setState(id, undefined)`). Sinyal mulai-kerja yang jujur adalah `UserPromptSubmit`: pekerjaan
 * ada karena ada yang meminta. Node yang belum punya sinyal apa pun jadi TIDAK punya status, dan
 * webterm merendernya "Unknown" — jawaban yang benar untuk "kami belum tahu".
 *
 * AKTIVITAS ANAK TIDAK PERNAH MENGGERAKKAN INDUKNYA. Dua guard di bawah, keduanya aturan nodeterm
 * yang dikutip apa adanya, dan keduanya memperbaiki satu bug yang sama: badge yang tersangkut
 * RUNNING pada node yang jelas-jelas sudah diam.
 *
 * Kenapa itu bisa terjadi: status webterm hanya bisa TURUN kalau ada hook yang menyuruhnya turun —
 * tidak ada sweep, tidak ada jam. Jadi status apa pun yang ditulis TERAKHIR bertahan selamanya.
 * Dan hook subagent menyala SETELAH turn induknya berakhir (subagent latar), sehingga event
 * terakhir yang pernah diterima sebuah node adalah event anak. Memetakan event anak ke `working`
 * berarti tulisan terakhir itu `working`, dan tidak ada apa pun sesudahnya yang membatalkannya.
 *
 * `SubagentStart`/`SubagentStop` TETAP DILANGGANI (`CLAUDE_HOOK_EVENTS`) tapi tidak lagi memetakan
 * ke status apa pun: nodeterm merutekannya ke siklus hidup subagent tersendiri yang di-key dengan
 * `agent_id` ANAK dan tidak pernah menyentuh state node
 * (`src/shared/agents/normalize.ts:309-322` — keduanya menghasilkan `kind: 'subagent-start'` /
 * `'subagent-end'`, bukan `kind: 'state'`). Tidak ada yang hilang dari sisi induk: `PreToolUse`
 * dari tool yang MELUNCURKAN anak itu sudah menaikkan induknya ke `working`.
 *
 * Guard `agent_id` menutup lubang yang sama pada tool-use biasa — sebuah subagent memakai file
 * `--settings` yang sama, jadi `PreToolUse`/`PostToolUse`-nya sendiri juga mem-POST ke node induk.
 * nodeterm membuangnya di satu baris (`src/shared/agents/normalize.ts:280-281`):
 *   // Child tool activity cannot drive the parent, but permission requests still need a reply.
 *   if (p.agent_id && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(...)) return null
 * `PostToolUseFailure` tidak ikut disebut di sini karena webterm tidak melanggani event itu —
 * mencantumkannya hanya akan jadi cabang mati.
 *
 * `PermissionRequest` SENGAJA di luar guard, alasan yang sama dengan nodeterm: ia request yang
 * MENUNGGU jawaban, jadi ia tetap harus terlihat walau yang memintanya seorang anak.
 */
export function hookStatus(body: HookStatusBody): AgentStatus | null {
  const event = body.hook_event_name
  if (body.agent_id && (event === 'PreToolUse' || event === 'PostToolUse')) return null
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
    // CATATAN BEDA DARI NODETERM: nodeterm punya flag `errored` tersendiri untuk ini (`normalize.ts`
    // :429-437 → `state: 'done', errored: true`). `AgentStatus` webterm hanya punya empat nilai,
    // jadi turn yang gagal mendarat di `waiting` — benar dalam hal "turn-nya sudah berakhir,
    // giliranmu", kurang dalam hal "ia berakhir karena error". Upgrade: tambahkan 'errored' ke
    // AgentStatus di src/shared/workspace.ts bila ada permukaan yang merendernya.
    case 'StopFailure':
      return 'waiting'
    // Satu event, beberapa arti: jenisnya yang memutuskan, dan jenis yang tak dikenal no-op.
    case 'Notification':
      return NOTIFICATION_STATUS[body.notification_type ?? ''] ?? null
    case 'PermissionRequest':
      return 'blocked'
    case 'SessionEnd':
      return 'done'
    default:
      return null
  }
}
