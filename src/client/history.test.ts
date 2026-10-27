import { describe, expect, it } from "vitest"
import { createHistory } from "./history"

describe("createHistory", () => {
  it("push 3: canUndo true, canRedo false, current = last", () => {
    const h = createHistory<number>()
    h.push(1)
    h.push(2)
    h.push(3)
    expect(h.canUndo()).toBe(true)
    expect(h.canRedo()).toBe(false)
    expect(h.current()).toBe(3)
  })

  it("undo/redo walks the ring and clamps at the end", () => {
    const h = createHistory<number>()
    h.push(1)
    h.push(2)
    h.push(3)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.redo()).toBe(2)
    expect(h.redo()).toBe(3)
    expect(h.canRedo()).toBe(false)
  })

  it("push after undo truncates the redo branch", () => {
    const h = createHistory<number>()
    h.push(1)
    h.push(2)
    h.push(3)
    h.undo()
    h.push(99)
    expect(h.canRedo()).toBe(false)
    expect(h.current()).toBe(99)
  })

  it("undo at start / redo at end return undefined and keep the pointer", () => {
    const h = createHistory<number>()
    h.push(1)
    expect(h.undo()).toBeUndefined()
    expect(h.current()).toBe(1)
    expect(h.redo()).toBeUndefined()
    expect(h.current()).toBe(1)
  })

  it("rings to max, dropping the oldest entries", () => {
    const h = createHistory<number>(3)
    for (const n of [1, 2, 3, 4, 5]) h.push(n)
    expect(h.current()).toBe(5)
    let undos = 0
    while (h.undo() !== undefined) undos++
    expect(undos).toBe(2)
    expect(h.current()).toBe(3)
  })

  it("empty history: current undefined, no undo/redo", () => {
    const h = createHistory<number>()
    expect(h.current()).toBeUndefined()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
    expect(h.undo()).toBeUndefined()
    expect(h.redo()).toBeUndefined()
  })
})
