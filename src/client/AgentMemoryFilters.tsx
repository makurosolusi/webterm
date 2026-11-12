// Control › Memory filter bar: two dropdowns (Source, Kind) instead of stacked pill rows, so the panel keeps at
// most two tab levels. Kind filters the remembered list only, which shows under Source: All; for any other
// source it is disabled (Past sessions under Notes means nothing).
import { DropdownMenu } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { MEMORY_TEXT, type MemoryKindFilter } from './AgentMemory.api'
import './agentChat/agentChatToolbar.css'

export const MEMORY_FILTER_TEXT = {
  source: 'Source',
  kind: 'Kind',
  sources: { all: 'All', suggested: 'Suggested', notes: 'Notes', central: 'Central' },
  kindOnlyAll: 'Kind applies when Source is All',
  /** Trigger label: the filter and its active choice, e.g. "Kind: Rules". */
  label: (name: string, choice: string): string => `${name}: ${choice}`,
} as const
export type MemorySource = keyof typeof MEMORY_FILTER_TEXT.sources

interface FilterMenuProps<T extends string> {
  name: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void; disabled?: boolean; hint?: string
}

/** One dropdown filter; its trigger names the active choice. */
function FilterMenu<T extends string>({ name, value, options, labels, onChange, disabled, hint }: FilterMenuProps<T>): React.JSX.Element {
  const label = MEMORY_FILTER_TEXT.label(name, labels[value])
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <Button size="sm" variant="secondary" aria-label={label} title={hint}>
          {label}<span className="codicon codicon-chevron-down" aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer()}>
        <DropdownMenu.Content className="act-menu" align="start" sideOffset={4}>
          <DropdownMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <DropdownMenu.RadioItem key={o} value={o} className="act-menu__item act-menu__item--radio">
                <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
                {labels[o]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const KINDS = Object.keys(MEMORY_TEXT.kinds) as MemoryKindFilter[]

/** Source + Kind on one row (wraps when narrow). `central` = the Central source is offered. */
export function MemoryFilters({ source, kind, central, onSource, onKind }: {
  source: MemorySource; kind: MemoryKindFilter; central: boolean; onSource: (s: MemorySource) => void; onKind: (k: MemoryKindFilter) => void
}): React.JSX.Element {
  const sources = (Object.keys(MEMORY_FILTER_TEXT.sources) as MemorySource[]).filter((s) => central || s !== 'central')
  const kindOff = source !== 'all'
  return (
    <div data-testid="memory-filters" className="flex flex-wrap items-center gap-1">
      <FilterMenu name={MEMORY_FILTER_TEXT.source} value={source} options={sources} labels={MEMORY_FILTER_TEXT.sources} onChange={onSource} />
      <FilterMenu name={MEMORY_FILTER_TEXT.kind} value={kind} options={KINDS} labels={MEMORY_TEXT.kinds} onChange={onKind}
        disabled={kindOff} hint={kindOff ? MEMORY_FILTER_TEXT.kindOnlyAll : undefined} />
    </div>
  )
}
