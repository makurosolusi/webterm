// Registry of editor nodes with unsaved changes, keyed by node id. Editor nodes
// report here; the canvas close gate reads it to decide whether to ask
// "Save / Don't Save / Cancel" and to run the save before closing.

const dirtyEditors = new Map<string, (() => Promise<boolean>) | undefined>();

/** Mark an editor node dirty (with its save action) or clean. */
export function setEditorDirty(nodeId: string, dirty: boolean, save?: () => Promise<boolean>): void {
  if (dirty) dirtyEditors.set(nodeId, save);
  else dirtyEditors.delete(nodeId);
}

/** True when the editor node has unsaved changes. */
export function isEditorDirty(nodeId: string): boolean {
  return dirtyEditors.has(nodeId);
}

/** Run the editor's registered save; false if none is registered or the write failed. */
export async function saveEditor(nodeId: string): Promise<boolean> {
  const save = dirtyEditors.get(nodeId);
  if (!save) return false;
  try {
    return await save();
  } catch (err) {
    console.error(`[webterm] saving editor ${nodeId} failed:`, err);
    return false;
  }
}
