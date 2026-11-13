import { Button as VscodeButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import type { EditorConflict } from './useEditorFile'

export interface EditorConflictBarProps {
  conflict: EditorConflict
  fileName: string
  /** Ganti buffer dengan isi disk. Tidak ditawarkan saat file hilang (tak ada yang dimuat ulang). */
  onReload: () => void
  /** Tulis buffer pengguna ke disk: menimpa versi baru, atau membuat ulang file yang terhapus. */
  onOverwrite: () => void
  /** Show the disk version against the buffer (VS Code's "Compare"); only when the file still exists. */
  onCompare?: () => void
}

/** Strip konflik simpan: file berubah di disk (EVERSION) atau terhapus (ENOENT); buffer tidak dibuang. */
export function EditorConflictBar({ conflict, fileName, onReload, onOverwrite, onCompare }: EditorConflictBarProps) {
  const missing = conflict.kind === 'missing'
  return (
    <div className="editor-node__conflict nodrag" role="alert">
      <span className="editor-node__conflict-msg">
        {missing ? `${fileName} was deleted on disk.` : `${fileName} changed on disk since you opened it.`}
      </span>
      {!missing && onCompare && (
        <IconTooltip label="Show the disk version next to your edits">
          <VscodeButton secondary onClick={onCompare}>Compare</VscodeButton>
        </IconTooltip>
      )}
      {!missing && (
        <IconTooltip label="Discard your edits and load the disk version">
          <VscodeButton secondary onClick={onReload}>Reload</VscodeButton>
        </IconTooltip>
      )}
      <IconTooltip label={missing ? 'Create the file again from your buffer' : 'Replace the disk version with your edits'}>
        <VscodeButton secondary onClick={onOverwrite}>{missing ? 'Recreate' : 'Overwrite'}</VscodeButton>
      </IconTooltip>
    </div>
  )
}
