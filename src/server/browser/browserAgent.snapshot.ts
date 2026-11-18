// Snapshot ber-ref: pohon aksesibilitas (AX) -> teks `[e12] button "Kirim"` + peta ref -> backendNodeId per snapId.
// Teks hasilnya data tak tepercaya (dibungkus pemanggil lewat `wrapUntrusted`). Nilai field input TIDAK disertakan.
import { SNAPSHOT_MAX_CHARS } from '../../shared/browser.contract'
import { BrowserError } from './browserHost.targets'

const NAME_MAX_CHARS = 200
const INDENT = '  '
export const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'option', 'treeitem',
])
export const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak'])

interface AxValue { value?: unknown }
export interface AxNode {
  nodeId?: string; ignored?: boolean; role?: AxValue; name?: AxValue; backendDOMNodeId?: number
  childIds?: string[]; properties?: Array<{ name?: string; value?: AxValue }>
}
export interface BuiltSnapshot { text: string; refs: Map<string, number>; truncated: boolean }

export const cleanName = (v: unknown): string => {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\p{Cc}\s]+/gu, ' ').trim().replaceAll('"', "'")
  return s.length > NAME_MAX_CHARS ? `${s.slice(0, NAME_MAX_CHARS)}...` : s
}

const flag = (n: AxNode, prop: string): boolean =>
  !!n.properties?.some((p) => p.name === prop && (p.value?.value === true || p.value?.value === 'true'))

/** Bangun teks snapshot dari hasil `Accessibility.getFullAXTree`; dipotong tepat di baris pada `maxChars`. */
export function buildSnapshot(nodes: AxNode[], maxChars: number = SNAPSHOT_MAX_CHARS): BuiltSnapshot {
  const byId = new Map<string, AxNode>()
  for (const n of nodes) if (typeof n.nodeId === 'string') byId.set(n.nodeId, n)
  const childSet = new Set(nodes.flatMap((n) => n.childIds ?? []))
  const roots = nodes.filter((n) => typeof n.nodeId === 'string' && !childSet.has(n.nodeId))
  const stack = roots.reverse().map((n) => ({ id: n.nodeId as string, depth: 0, parentName: '' }))
  const lines: string[] = []
  const refs = new Map<string, number>()
  let size = 0
  let truncated = false
  const seen = new Set<string>()
  while (stack.length) {
    const { id, depth, parentName } = stack.pop() as (typeof stack)[number]
    const n = byId.get(id)
    if (!n || seen.has(id)) continue
    seen.add(id)
    const role = typeof n.role?.value === 'string' ? n.role.value : ''
    const name = cleanName(n.name?.value)
    const interactive = INTERACTIVE.has(role)
    const emit = !n.ignored && !SKIP_ROLES.has(role) && (interactive || name !== '') && !(role === 'StaticText' && name === parentName)
    let childDepth = depth
    let childParent = parentName
    if (emit) {
      const ref = interactive && Number.isInteger(n.backendDOMNodeId) ? `e${refs.size + 1}` : undefined
      const state = `${flag(n, 'disabled') ? ' (disabled)' : ''}${flag(n, 'checked') ? ' (checked)' : ''}`
      const line = `${INDENT.repeat(depth)}${ref ? `[${ref}] ` : ''}${role}${name ? ` "${name}"` : ''}${state}`
      if (size + line.length + 1 > maxChars) { truncated = true; break }
      size += line.length + 1
      lines.push(line)
      if (ref) refs.set(ref, n.backendDOMNodeId as number)
      childDepth = depth + 1
      childParent = name
    }
    const kids = n.childIds ?? []
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: childDepth, parentName: childParent })
  }
  return { text: lines.join('\n'), refs, truncated }
}

interface Stored { snapId: string; url: string; refs: Map<string, number> }

/** Snapshot terakhir per node; ref hanya sah untuk snapshot terakhir dan URL halaman yang sama. */
export class SnapshotStore {
  private readonly byNode = new Map<string, Stored>()
  private counter = 0

  /** Simpan snapshot baru (menggantikan yang lama) dan kembalikan `snapId`. */
  save(nodeId: string, url: string, refs: Map<string, number>): string {
    const snapId = `s${++this.counter}`
    this.byNode.set(nodeId, { snapId, url, refs })
    return snapId
  }

  /** backendNodeId untuk ref; `stale_ref` bila snapId bukan yang terakhir, URL berubah, atau ref tak dikenal. */
  resolve(nodeId: string, snapId: string, ref: string, currentUrl: string): number {
    const s = this.byNode.get(nodeId)
    if (!s || s.snapId !== snapId || s.url !== currentUrl) throw new BrowserError('stale_ref', `node ${nodeId}: snapshot is stale, take a new snapshot`)
    const id = s.refs.get(ref)
    if (id === undefined) throw new BrowserError('stale_ref', `node ${nodeId}: unknown ref ${ref} in snapshot ${snapId}`)
    return id
  }

  /** backendNodeId dari snapshot terakhir tanpa snapId (untuk `wait`); undefined bila tak ada. */
  latest(nodeId: string, ref: string): number | undefined {
    return this.byNode.get(nodeId)?.refs.get(ref)
  }

  /** Buang snapshot node (setelah navigasi). */
  drop(nodeId: string): void {
    this.byNode.delete(nodeId)
  }
}
