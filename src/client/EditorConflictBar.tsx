import { Button as VscodeButton } from '@/vscode/register'
import type { EditorConflict } from './useEditorFile'

export interface EditorConflictBarProps {
  conflict: EditorConflict
  fileName: string
  /** Ganti buffer dengan isi disk. Tidak ditawarkan saat file hilang (tak ada yang dimuat ulang). */
  onReload: () => void
  /** Tulis buffer pengguna ke disk: menimpa versi baru, atau membuat ulang file yang terhapus. */
  onOverwrite: () => void
}

/** Strip konflik simpan: file berubah di disk (EVERSION) atau terhapus (ENOENT); buffer tidak dibuang. */
export function EditorConflictBar({ conflict, fileName, onReload, onOverwrite }: EditorConflictBarProps) {
  const missing = conflict.kind === 'missing'
  return (
    <div className="editor-node__conflict nodrag" role="alert">
      <span className="editor-node__conflict-msg">
        {missing ? `${fileName} was deleted on disk.` : `${fileName} changed on disk since you opened it.`}
      </span>
      {!missing && (
        <VscodeButton secondary title="Discard your edits and load the disk version" onClick={onReload}>
          Reload
        </VscodeButton>
      )}
      <VscodeButton secondary title={missing ? 'Create the file again from your buffer' : 'Replace the disk version with your edits'} onClick={onOverwrite}>
        {missing ? 'Recreate' : 'Overwrite'}
      </VscodeButton>
    </div>
  )
}
