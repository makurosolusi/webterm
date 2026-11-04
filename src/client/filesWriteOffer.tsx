// Aksi tulis file manager yang terkunci karena kemampuan "Ubah dan unggah file" (filesWrite) mati:
// baris menu tetap terlihat dengan ikon gembok + alasan (pola Orca `disabledReason` sebagai tooltip,
// WorktreeOpenInMenu.tsx:278), dan klik membuka tawaran menyalakan (pola VS Code Restricted Mode:
// aksi yang butuh trust memunculkan dialog permintaan, bukan menghilang). Dialognya sama dengan tawaran
// browser di Dock (`<CapabilityOffer>` di dalam Dialog): tombol "Nyalakan" = konfirmasi satu klik.
import { useSyncExternalStore } from 'react'
import { CAPABILITIES } from '../shared/featureCapabilities'
import { CapabilityOffer } from './CapabilityOffer'
import { codicon } from './FilesMenu'
import type { SlotMenuRow } from './filesSlots'
import { resetCapabilitiesCache as resetFsCaps } from './fsClient'
import { resetCapabilitiesCache as resetCapabilityViews } from './useCapabilities'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const TITLE = CAPABILITIES.filesWrite.title
export const WRITE_OFFER_TEXT = {
  dialogTitle: `Turn on “${TITLE}”`,
  lockedHint: `Locked: “${TITLE}” is off. Click to turn it on.`,
  enableAction: 'Turn on…',
} as const

/** Node yang dialog tawarannya terbuka, dan hitungan "baru dinyalakan" yang memicu slot menanya ulang. */
let openFor: string | null = null
let epoch = 0
const subs = new Set<() => void>()
const emit = (): void => { subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

/** Buka tawaran menyalakan filesWrite untuk node `nodeId`. */
export function offerFilesWrite(nodeId: string): void {
  resetCapabilityViews() // status kemampuan bisa basi (diubah dari Settings/tab lain): muat ulang
  openFor = nodeId
  emit()
}

function close(): void { openFor = null; emit() }

function enabled(): void {
  resetFsCaps() // `capabilities()` fsClient di-cache; slot menanya ulang begitu `epoch` naik
  epoch++
  close()
}

/** Naik setiap filesWrite berhasil dinyalakan dari tawaran; jadikan dependensi efek pemuat kemampuan. */
export const useFilesWriteEpoch = (): number => useSyncExternalStore(subscribe, () => epoch)

/** Kembalikan state modul ke awal (untuk tes). */
export function resetFilesWriteOffer(): void { openFor = null; epoch = 0; emit() }

/** Baris menu terkunci: terlihat, ber-gembok, alasan di tooltip; klik membuka tawaran. */
export const lockedRow = (nodeId: string, label: string, keybinding?: string): SlotMenuRow =>
  ({ label, icon: codicon('lock'), keybinding, hint: WRITE_OFFER_TEXT.lockedHint, onClick: () => offerFilesWrite(nodeId) })

/** Dialog tawaran milik node `nodeId`; tak merender apa pun bila tertutup. */
export function FilesWriteOffer({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribe, () => openFor) === nodeId
  if (!open) return null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{WRITE_OFFER_TEXT.dialogTitle}</DialogTitle></DialogHeader>
        <CapabilityOffer id="filesWrite" onDone={enabled} />
      </DialogContent>
    </Dialog>
  )
}
