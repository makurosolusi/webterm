// Name and glyph of ANY node kind (files and editors included, unlike `./sessionList`), as shown by
// the node tab strip above the canvas and by tab mode.
import { SESSION_KINDS, sessionTitle } from './sessionList'
import { isAutoName } from './nodeIdentity'
import { folderTitle } from './fileBrowse'
import { fileBaseName } from './editorFile'
import type { WsNode, WsNodeKind } from '../shared/workspace'

export const NODE_KIND_LABEL: Record<WsNodeKind, string> = {
  terminal: 'Terminal',
  agent: 'Agent',
  agentChat: 'Agent Chat',
  files: 'Files',
  editor: 'Editor',
  browser: 'Browser',
  diff: 'Changes',
  plan: 'Plan',
  app: 'App',
  skill: 'Skill',
}

/** Codicon per kind, shared by the node tab strip and tab mode: shape tells kinds apart
 *  because a custom title ("notes", "scratch") could belong to any kind. */
export const KIND_ICON: Record<WsNodeKind, string> = {
  agent: 'hubot',
  agentChat: 'comment-discussion',
  terminal: 'terminal',
  editor: 'file',
  files: 'folder',
  browser: 'globe',
  diff: 'git-compare',
  plan: 'type-hierarchy',
  app: 'window',
  skill: 'book',
}

/** Nama node seperti yang dilihat pengguna di chrome-nya. Tiap kind memakai rantai fallback milik
 *  komponennya sendiri (`FilesNode` → `folderTitle`, `EditorNode` → `fileBaseName`, sisanya
 *  `sessionTitle`), supaya satu node tidak bernama dua hal di dua tempat. */
export function nodeRowLabel(n: WsNode): string {
  const title = isAutoName(n.title) ? undefined : n.title?.trim()
  if (title) return title
  if (n.kind === 'files') return n.dirPath ? folderTitle(n.dirPath) : NODE_KIND_LABEL.files
  if (n.kind === 'skill') return n.skill || NODE_KIND_LABEL.skill
  if (n.kind === 'editor') return n.filePath ? fileBaseName(n.filePath) : NODE_KIND_LABEL.editor
  // Only sessions are named by `sessionTitle` (its fallback is "Terminal"); the rest by their kind.
  return SESSION_KINDS.includes(n.kind) ? sessionTitle(n) : NODE_KIND_LABEL[n.kind]
}
