// Kotak filter sidebar: input VS Code (24px) dengan tombol hapus codicon. Esc mengosongkan filter.
import { IconTooltip } from '@/components/ui/icon-button'
import { sidebarFilterKeyAction } from './sessionList'

export interface SessionsFilterProps {
  value: string
  onChange: (value: string) => void
}

/** Input filter sesi; keyboard-nya tidak boleh bocor ke canvas React Flow di document. */
export function SessionsFilter({ value, onChange }: SessionsFilterProps) {
  return (
    <div className="sessions-sidebar__search">
      <input
        type="text"
        value={value}
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
        onChange={(e) => onChange(e.target.value)}
        // Canvas React Flow mendengarkan keyboard di document: tanpa stopPropagation,
        // Backspace menghapus node terpilih dan panah menggeser canvas selagi mengetik.
        onKeyDown={(e) => {
          e.stopPropagation()
          if (sidebarFilterKeyAction(e.key, value) === 'clear') onChange('')
        }}
      />
      {value !== '' && (
        <IconTooltip label="Clear filter" shortcut="Esc">
          <button
            type="button"
            className="ss-search__clear"
            aria-label="Clear filter"
            onClick={() => onChange('')}
          >
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </IconTooltip>
      )}
    </div>
  )
}
