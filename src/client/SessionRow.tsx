// Satu baris sesi di sidebar kiri, plus glyph statusnya. Dipisah dari `SessionsPanel` supaya
// kerangka panel (tab, filter, grup) tetap terbaca dalam satu layar. Mengikuti nodeterm v0.4.5
// `src/renderer/components/SessionRow.tsx`.
import { Bell, Check, X } from 'lucide-react'
import type { SessionRowVM } from './sessionList'

/** Nama folder terakhir dari sebuah path — cwd penuh tidak muat di baris selebar 300px. */
function dirName(p: string | undefined): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Kalimat glyph belum-dibaca, dipakai juga sebagai bagian nama aksesibel barisnya. */
const UNREAD_TITLE = 'Finished — new for you'

/** Apakah baris ini memakai glyph belum-dibaca? Bel (giliranmu) dan turn yang sedang jalan
 *  MENGALAHKANNYA — prompt izin atau turn baru lebih mendesak daripada tanda lama; sama dengan
 *  prioritas `sessionStatusGroup`. Satu predikat karena dua pembaca (glyph dan aria-label). */
const showsUnread = (row: SessionRowVM): boolean =>
  row.unread === true && row.statusKind !== 'attention' && row.statusKind !== 'working'

/** Urutan prioritas glyph: bel (giliranmu) → centang belum-dibaca → centang (selesai) → titik
 *  status. Satu baris hanya punya satu slot, jadi sinyal yang paling menuntut tindakan yang menang. */
function StatusGlyph({ row }: { row: SessionRowVM }) {
  if (row.statusKind === 'attention') {
    return (
      <span className="ss-row__glyph ss-bell" title={row.stateLabel}>
        <Bell aria-hidden />
      </span>
    )
  }
  if (showsUnread(row)) {
    return (
      <span className="ss-row__glyph ss-check ss-check--unread" title={UNREAD_TITLE}>
        <Check aria-hidden />
      </span>
    )
  }
  if (row.statusKind === 'done') {
    return (
      <span className="ss-row__glyph ss-check" title={row.stateLabel}>
        <Check aria-hidden />
      </span>
    )
  }
  return (
    <span className="ss-row__glyph" title={row.stateLabel}>
      <span className={`ss-dot ss-dot--${row.statusKind}`} />
    </span>
  )
}

export interface SessionRowProps {
  row: SessionRowVM
  /** Tampilkan nama workspace di meta. Mode status meratakan semua workspace, jadi di sana
   *  nama itu satu-satunya petunjuk sesi ini milik siapa. */
  showProject: boolean
  onFocusNode: (id: string) => void
  onCloseSession: (id: string) => void
}

export default function SessionRow({ row, showProject, onFocusNode, onCloseSession }: SessionRowProps) {
  const meta = [showProject ? row.projectName : '', dirName(row.cwd)].filter(Boolean)
  return (
    <li>
      <div
        className="ss-row"
        role="button"
        tabIndex={0}
        // Glyph belum-dibaca hanya punya `title`, yang tidak diumumkan dengan andal — jadi fakta
        // itu ikut ke nama aksesibel barisnya, bukan hanya ke warna centangnya.
        aria-label={`${row.label} — ${row.stateLabel}${showsUnread(row) ? ` — ${UNREAD_TITLE}` : ''}`}
        onClick={() => onFocusNode(row.id)}
        // Klik tengah menutup sesi: kebiasaan tab browser, dan nodeterm memakainya juga.
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          onCloseSession(row.id)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          onFocusNode(row.id)
        }}
      >
        <StatusGlyph row={row} />
        <span className="ss-row__text">
          <span className="ss-row__title" style={row.color ? { color: row.color } : undefined}>
            {row.label}
          </span>
          {meta.length > 0 && <span className="ss-meta">{meta.join(' · ')}</span>}
        </span>
        <button
          type="button"
          className="ss-iconbtn ss-row__close"
          aria-label={`End session ${row.label}`}
          title="End session"
          onClick={(e) => {
            e.stopPropagation()
            onCloseSession(row.id)
          }}
        >
          <X aria-hidden />
        </button>
      </div>
    </li>
  )
}
