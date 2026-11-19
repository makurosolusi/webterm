import { useEffect, useState } from 'react'
import { NodeToolbar, Position, useReactFlow, useStore } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { STICKY_COLORS, STICKY_TAG_MAX, cleanStickyTag, type StickyColorId } from '../shared/sticky.palette'
import { STICKY_COLOR_NAME, STICKY_TEXT } from './sticky.labels'
import { setLastStickyColor } from './sticky.state'

/** Selected stickies, as a primitive so the selector does not re-render the toolbar on unrelated store changes. */
const selectedStickyIds = (nodes: { id: string; type?: string; selected?: boolean }[]): string =>
  nodes.filter((n) => n.type === 'sticky' && n.selected).map((n) => n.id).join('\n')

interface Props { id: string; tag: string; color: StickyColorId }

/**
 * Floating toolbar over a selected note: a 5x2 color grid (applies to EVERY selected note) and the corner
 * label field (only when one note is selected). Rendered by the lead note of the selection only.
 */
export function StickyToolbar({ id, tag, color }: Props) {
  const rf = useReactFlow()
  const selectedIds = useStore((s) => selectedStickyIds(s.nodes))
  const ids = selectedIds.split('\n')
  const lead = ids[0] === id
  const [draft, setDraft] = useState(tag)
  useEffect(() => setDraft(tag), [tag])
  if (!lead) return null

  const pick = (c: StickyColorId): void => {
    setLastStickyColor(c)
    for (const nid of ids) rf.updateNodeData(nid, { stickyColor: c })
  }
  const saveTag = (): void => {
    const next = cleanStickyTag(draft)
    setDraft(next)
    if (next !== tag) rf.updateNodeData(id, { stickyTag: next })
  }

  return (
    <NodeToolbar nodeId={id} isVisible position={Position.Top} offset={12} className="sticky-toolbar nodrag nopan nowheel">
      <div role="group" aria-label={STICKY_TEXT.colorGroup} className="sticky-toolbar__swatches">
        {STICKY_COLORS.map((c) => (
          <IconTooltip key={c.id} label={STICKY_COLOR_NAME[c.id]} side="bottom">
            <Button
              type="button" variant="ghost" size="xs" className="sticky-swatch" style={{ background: c.hex }}
              aria-label={STICKY_COLOR_NAME[c.id]} aria-pressed={c.id === color}
              // Keep the note's text field from blurring before the color lands.
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.id)}
            />
          </IconTooltip>
        ))}
      </div>
      {ids.length === 1 && (
        <Input
          className="sticky-toolbar__tag" value={draft} maxLength={STICKY_TAG_MAX} aria-label={STICKY_TEXT.tagFieldLabel} placeholder={STICKY_TEXT.tagPlaceholder}
          onChange={(e) => setDraft(e.target.value)} onBlur={saveTag}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); saveTag() } }}
        />
      )}
    </NodeToolbar>
  )
}
