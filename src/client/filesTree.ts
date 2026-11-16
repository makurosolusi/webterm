// Pure tree model of the Files node: flatten {root listing, loaded children, expanded set} into the
// visible rows, keyed by the path RELATIVE to the node's cwd ("src/a.ts"). No DOM, no fetching
// (that is `useFilesTree`). Recursive tree-entry rendering.
import type { FileMeta } from '../shared/fsContract'

/** One visible row. `entry.name` is `rel` (slots see relative paths); the row renders `leafName(rel)`. */
export interface TreeRow { entry: FileMeta; rel: string; depth: number; open: boolean }

/** Last path segment of a relative path. */
export const leafName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** Relative parent of `rel`; '' = the cwd itself. */
export const relParent = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * Depth-first rows: a folder is followed by its children only when it is expanded AND its children
 * have been loaded. `arrange` orders/filters one level (view options), applied per level so
 * folders-first holds inside every folder.
 */
export function flattenTree(
  root: readonly FileMeta[],
  childrenByRel: ReadonlyMap<string, readonly FileMeta[]>,
  expanded: ReadonlySet<string>,
  arrange: (level: readonly FileMeta[]) => FileMeta[] = (l) => [...l],
): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (level: readonly FileMeta[], prefix: string, depth: number) => {
    for (const e of arrange(level)) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const open = e.dir && expanded.has(rel)
      out.push({ entry: { ...e, name: rel }, rel, depth, open })
      const kids = open ? childrenByRel.get(rel) : undefined
      if (kids) walk(kids, rel, depth + 1)
    }
  }
  walk(root, '', 0)
  return out
}

/** Rows whose leaf name contains `query` (case-insensitive), plus their ancestors so they stay reachable. */
export function filterRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  const keep = new Set<string>()
  for (const r of rows) {
    if (!leafName(r.rel).toLowerCase().includes(q)) continue
    for (let p = r.rel; p; p = relParent(p)) keep.add(p)
  }
  return rows.filter((r) => keep.has(r.rel))
}
