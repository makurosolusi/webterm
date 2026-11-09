// One collapsible section of the left side bar (Layers, Sessions), drawn like a VS Code pane
// header: twisty, uppercase title, optional count badge, and actions that show on hover/focus.
// Collapsed = header only; the body unmounts and the other section takes the height.
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import './sessions-panel.section.css'

export interface SidebarSectionProps {
  id: string
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}

export function SidebarSection({ id, title, count, open, onToggle, actions, children }: SidebarSectionProps) {
  const bodyId = `ss-section-${id}`
  return (
    <section className={`ss-section ss-section--${id}`} data-open={open} aria-label={title}>
      <div className="ss-section__head">
        <Button type="button" variant="ghost" className="ss-section__toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden />
          <span className="ss-section__title">{title}</span>
          {count !== undefined && <span className="sessions-sidebar__count">{count}</span>}
        </Button>
        {actions && (
          <div className="ss-section__actions" role="toolbar" aria-label={`${title} actions`}>
            {actions}
          </div>
        )}
      </div>
      {open && (
        <div id={bodyId} className="ss-section__body">
          {children}
        </div>
      )}
    </section>
  )
}
