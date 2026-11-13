// Canvas header and breadcrumb of an editor node, VS Code style: the title is the file name (ellipsis,
// hover = full path), the breadcrumb is the path relative to the Files node that opened it (absolute
// when there is none), and every icon action is an IconButton with a real tooltip and its chord.
import { useCallback } from 'react'
import { useStore, type ReactFlowState } from '@xyflow/react'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { VscodeBreadcrumbs, type VscodeBreadcrumbSegment } from './components/vscode/vscodeBreadcrumbs'
import { fileIconToneClass } from './fileIcon'
import { isUnder } from './editorFile'
import { NodeNameLabel } from './nodeName.label'
import { NodeResizeToggle } from './nodeResize/NodeLayoutResizer'
import { ShowInFilesButton, filesSourceOf } from './ShowInFilesButton'
import { WRAP_COMMAND_ID } from './editorWrap'

/** Registry command (`commandRegistry.defaults`) for the hover-gated Markdown preview toggle. */
export const PREVIEW_COMMAND_ID = 'editor.togglePreview'
/** Breadcrumb segments shown before older ones fold into the leading "…" menu. */
const CRUMBS_VISIBLE = 4

/** Folder of the Files node that opened editor `id` (its `dirPath`), or '' when there is none. */
export function useFilesRoot(id: string): string {
  return useStore(useCallback((s: ReactFlowState) => {
    const src = filesSourceOf(s, id)
    return (src && (s.nodeLookup.get(src)?.data as { dirPath?: string } | undefined)?.dirPath) || ''
  }, [id]))
}

/** Path segments of `filePath` with each one's full path: relative to `root` when the file is under it. */
export function crumbParts(filePath: string, root: string): { label: string; path: string }[] {
  const p = filePath.replace(/\\/g, '/')
  const base = root && root !== '/' && isUnder(p, root) && p !== root ? root.replace(/\/+$/, '') : ''
  const names = p.slice(base.length).split('/').filter(Boolean)
  let at = base
  return names.map((label) => ({ label, path: (at = `${at}/${label}`) }))
}

export function EditorCrumbs({ filePath, root, onFolder }: { filePath: string; root: string; onFolder: (() => void) | null }) {
  const parts = crumbParts(filePath, root)
  const segments: VscodeBreadcrumbSegment[] = parts.map((s, i) => {
    const last = i === parts.length - 1
    return {
      id: s.path,
      label: s.label,
      title: last || !onFolder ? s.path : `${s.path} (Show in Files)`,
      icon: last ? <span className={`${fileIconToneClass(s.label)} editor-node__icon`} aria-hidden="true" /> : undefined,
      onClick: last ? undefined : onFolder ?? undefined,
    }
  })
  return <VscodeBreadcrumbs className="nodrag editor-node__crumbs" ariaLabel="File path" maxVisible={CRUMBS_VISIBLE} segments={segments} />
}

export interface EditorHeaderProps {
  id: string
  name?: string
  fileName: string
  filePath: string
  dirty: boolean
  /** Text editor mounted: the view actions apply. */
  editable: boolean
  /** Markdown file: offer Preview/Edit. */
  markdown: boolean
  preview: boolean
  onTogglePreview: () => void
  wrap: boolean
  onToggleWrap: () => void
  /** Language server present: offer the symbol outline. */
  onOutline?: () => void
  onClose: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

export function EditorHeader(p: EditorHeaderProps) {
  return (
    <div className="node-header" onContextMenu={p.onContextMenu}>
      <IconTooltip label={p.filePath || p.fileName}>
        <span className="node-title editor-node__name">
          <span className={`${fileIconToneClass(p.fileName)} editor-node__icon`} aria-hidden="true" />
          <span className="editor-node__label"><NodeNameLabel name={p.name} label={p.fileName} /></span>
          {p.editable && p.dirty && (
            <span className="codicon codicon-circle-filled editor-node__dirty" role="img" aria-label="Unsaved changes" />
          )}
        </span>
      </IconTooltip>
      <span className="editor-node__spacer" />
      <span className="nodrag editor-node__actions">
        <ShowInFilesButton editorId={p.id} />
        <NodeResizeToggle />
        {p.editable && p.markdown && (
          <IconButton size="icon-xs" label={p.preview ? 'Edit' : 'Preview'} tooltip={p.preview ? 'Back to Editor' : 'Open Preview'}
            commandId={PREVIEW_COMMAND_ID} aria-pressed={p.preview} onClick={p.onTogglePreview}>
            <span className={`codicon codicon-${p.preview ? 'edit' : 'open-preview'}`} aria-hidden="true" />
          </IconButton>
        )}
        {p.editable && (
          <IconButton size="icon-xs" label="Word wrap" tooltip="Toggle Word Wrap" commandId={WRAP_COMMAND_ID} aria-pressed={p.wrap} onClick={p.onToggleWrap}>
            <span className="codicon codicon-word-wrap" aria-hidden="true" />
          </IconButton>
        )}
        {p.editable && p.onOutline && (
          <IconButton size="icon-xs" label="Outline" tooltip="Go to Symbol in Editor" shortcut="⇧⌘O" onClick={p.onOutline}>
            <span className="codicon codicon-symbol-class" aria-hidden="true" />
          </IconButton>
        )}
        <IconButton size="icon-xs" label="Close" onClick={p.onClose}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </IconButton>
      </span>
    </div>
  )
}
