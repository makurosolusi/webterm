export interface History<T> {
  push(snapshot: T): void
  undo(): T | undefined
  redo(): T | undefined
  canUndo(): boolean
  canRedo(): boolean
  current(): T | undefined
}

export function createHistory<T>(max = 50): History<T> {
  const items: T[] = []
  let ptr = -1

  return {
    push(snapshot) {
      items.splice(ptr + 1)
      items.push(snapshot)
      if (items.length > max) items.splice(0, items.length - max)
      ptr = items.length - 1
    },
    undo() {
      if (ptr <= 0) return undefined
      ptr--
      return items[ptr]
    },
    redo() {
      if (ptr >= items.length - 1) return undefined
      ptr++
      return items[ptr]
    },
    canUndo() {
      return ptr > 0
    },
    canRedo() {
      return ptr < items.length - 1
    },
    current() {
      return ptr >= 0 ? items[ptr] : undefined
    },
  }
}
