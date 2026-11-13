// Navigasi keyboard tambahan untuk pohon sesi: Home/End dan type-ahead, yang tidak disediakan
// `vscode-tree`. Murni terhadap elemen DOM biasa (tanpa Lit) supaya bisa diuji di jsdom.

/** Jendela buffer type-ahead; sama dengan menu VS Code (`vscodeMenu`). */
export const TYPEAHEAD_BUFFER_MS = 500

type TreeItemEl = HTMLElement & { open?: boolean }

const isItem = (el: Element | null): el is TreeItemEl => el?.localName === 'vscode-tree-item'

/** Semua item yang tampak (setiap leluhur branch terbuka), urutan dokumen. */
export function visibleTreeItems(root: ParentNode): TreeItemEl[] {
  const all = Array.from(root.querySelectorAll<TreeItemEl>('vscode-tree-item'))
  return all.filter((item) => {
    for (let p = item.parentElement; isItem(p); p = p.parentElement) if (p.open !== true) return false
    return true
  })
}

/** Label baris untuk type-ahead: elemen label milik item itu sendiri, bukan teks anak-anaknya. */
export function treeItemLabel(item: Element): string {
  // A workspace header nests its label in `.ss-ws > .ss-ws__line` (SessionGroupItem), one level
  // deeper than leaves and bucket headers; without that path type-ahead skipped every workspace.
  const label = item.querySelector(':scope > .ss-tree__label, :scope > .ss-tree__group-label, :scope > .ss-ws > .ss-ws__line > .ss-tree__group-label')
  return (label?.textContent ?? '').trim()
}

/** Item tujuan Home/End, atau null bila tak ada baris. */
export function edgeTarget(key: 'Home' | 'End', items: TreeItemEl[]): TreeItemEl | null {
  if (items.length === 0) return null
  return key === 'Home' ? items[0] : items[items.length - 1]
}

/**
 * Baris berikutnya yang labelnya berawalan `buffer`. Satu huruf diulang berputar ke baris
 * berikutnya (seperti VS Code); buffer lebih panjang dicari mulai dari baris saat ini.
 */
export function typeaheadTarget(labels: string[], buffer: string, currentIndex: number): number {
  // "aaa" = menekan "a" berulang → berputar antar baris berawalan "a", bukan mencari "aaa".
  const needle = (/^(.)\1+$/.test(buffer) ? buffer[0] : buffer).toLowerCase()
  if (!needle || labels.length === 0) return -1
  const start = needle.length > 1 ? Math.max(currentIndex, 0) : currentIndex + 1
  for (let step = 0; step < labels.length; step += 1) {
    const index = (start + step) % labels.length
    if (labels[index].toLowerCase().startsWith(needle)) return index
  }
  return -1
}
