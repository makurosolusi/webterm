// Overlay slot mutate: dialog konfirmasi hapus (pengganti window.confirm) dan tumpukan toast
// (hasil, Undo, galat). Tidak merender apa pun bila tak ada state — jadi aman saat flag mati.
import { useRef, type ReactNode } from 'react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { VscodeNotification, VscodeNotificationStack } from './components/vscode/vscodeNotification'
import { CONFIRM } from './filesMessages'
import { dismissToast, setConfirm, useMutateUi } from './filesMutate.store'

/** Dialog + toast milik node `nodeId`. */
export default function FilesMutateOverlay({ nodeId }: { nodeId: string }) {
  const { confirm, toasts } = useMutateUi(nodeId)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const close = () => setConfirm(nodeId, null)

  let dialog: ReactNode = null
  if (confirm) {
    const [first, n] = [confirm.names[0], confirm.names.length]
    const perm = confirm.permanent
    const ok = (
      <button key="ok" ref={okRef} type="button" className="files-btn files-btn--primary" onClick={() => { close(); confirm.onConfirm() }}>
        {perm ? CONFIRM.permOk : CONFIRM.trashOk}
      </button>
    )
    const cancel = <button key="cancel" ref={cancelRef} type="button" className="files-btn" onClick={close}>{CONFIRM.cancel}</button>
    dialog = (
      <VscodeDialog
        open onOpenChange={(open) => { if (!open) close() }}
        title={perm ? CONFIRM.permTitle(n, first) : CONFIRM.trashTitle(n, first)}
        description={perm ? CONFIRM.permBody : CONFIRM.trashBody}
        width={420}
        // Hapus permanen: fokus awal di Batal supaya Enter tak sengaja tidak menghancurkan data.
        initialFocus={perm ? cancelRef : okRef}
        footer={arrangeDialogButtons([ok, cancel], 1)}
      />
    )
  }

  return (
    <>
      {dialog}
      {toasts.length > 0 && (
        <VscodeNotificationStack>
          {toasts.map((t) => (
            <VscodeNotification
              key={t.id} id={t.id} severity={t.severity} title={t.title} message={t.message}
              actions={t.actions?.map((a) => ({ label: a.label, onClick: () => { dismissToast(nodeId, t.id); a.onClick() } }))}
              onClose={() => dismissToast(nodeId, t.id)}
            />
          ))}
        </VscodeNotificationStack>
      )}
    </>
  )
}
