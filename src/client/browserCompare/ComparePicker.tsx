// Small dialog that asks which two panes to compare (defaults: the first two on screen).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { PaneInfo } from './capture'

export interface ComparePickerProps {
  panes: PaneInfo[]
  onConfirm: (left: string, right: string) => void
  onCancel: () => void
}

function PaneSelect({ id, label, value, panes, onChange }: { id: string; label: string; value: string; panes: PaneInfo[]; onChange: (v: string) => void }) {
  return (
    <div className="bc-pick-row">
      <Label id={`${id}-l`}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-labelledby={`${id}-l`}><SelectValue /></SelectTrigger>
        <SelectContent>{panes.map((p) => <SelectItem key={p.tabId} value={p.tabId}>{p.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}

export function ComparePicker({ panes, onConfirm, onCancel }: ComparePickerProps) {
  const [left, setLeft] = useState(panes[0]?.tabId ?? '')
  const [right, setRight] = useState(panes[1]?.tabId ?? '')
  const same = left === right
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Compare panes</DialogTitle>
          <DialogDescription>Pick the two pages to lay over each other.</DialogDescription>
        </DialogHeader>
        <PaneSelect id="bc-left" label="Left/Base" value={left} panes={panes} onChange={setLeft} />
        <PaneSelect id="bc-right" label="Right/Compare" value={right} panes={panes} onChange={setRight} />
        {same && <p role="alert" className="bc-pick-warn">Pick two different panes.</p>}
        <DialogFooter>
          <Button size="bui" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="bui" disabled={same} onClick={() => onConfirm(left, right)}>Compare</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
