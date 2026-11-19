// UI of the editor's secret masking: status-bar items ("N secrets masked", Reveal all, Edit, Hide), and the
// banners (hidden again / hide pending / truncated scan / editing). When the status bar is turned off in
// Settings the same actions render inside the banner, so masked secrets can still be revealed.
import { Button } from '@/components/ui/button'
import { useLiveSettings } from './useSettings'
import type { EditorMask } from './useEditorMask'
import './editorMask.css'

export type MaskItem = { id: string; text: string; tip: string; onClick?: () => void }

/** Status-bar items for the mask; empty while masking is not active for this file. */
export function maskStatusItems(m: EditorMask | undefined): MaskItem[] {
  if (!m || m.mode === 'off') return []
  const out: MaskItem[] = []
  if (m.mode === 'masked' && m.masked > 0) {
    out.push({ id: 'mask-count', text: `${m.masked} ${m.masked === 1 ? 'secret' : 'secrets'} masked`, tip: 'Secrets are hidden in this editor; saving is off while they are hidden' })
    out.push({ id: 'mask-reveal', text: 'Reveal all', tip: 'Show every secret (read-only)', onClick: m.revealAll })
  }
  if (m.mode === 'masked' && m.canEdit) out.push({ id: 'mask-edit', text: 'Edit', tip: 'Show secrets and edit the file', onClick: m.edit })
  if (m.revealed) out.push({ id: 'mask-hide', text: 'Hide', tip: 'Hide secrets again', onClick: m.hide })
  return out
}

const NOTICE_TEXT = {
  hidden: 'Secrets hidden again.',
  pending: 'Unsaved changes: secrets stay visible until you save or discard.',
} as const

export function EditorMaskBanner({ mask }: { mask: EditorMask }) {
  const statusBar = useLiveSettings().nodeStatusBar
  if (!mask.enabled) return null
  const lines: string[] = []
  if (mask.scan.truncated) lines.push('Only the first 1 MiB was scanned for secrets.')
  if (mask.notice) lines.push(NOTICE_TEXT[mask.notice])
  else if (mask.mode === 'edit') lines.push('Secrets visible — editing.')
  const actions = statusBar ? [] : maskStatusItems(mask).filter((i) => i.onClick)
  if (lines.length === 0 && actions.length === 0) return null
  return (
    <div className="editor-node__banner editor-node__mask nodrag" role="status">
      {lines.map((l) => <span key={l}>{l}</span>)}
      {actions.map((a) => <Button key={a.id} variant="ghost" size="xs" onClick={a.onClick}>{a.text}</Button>)}
    </div>
  )
}
