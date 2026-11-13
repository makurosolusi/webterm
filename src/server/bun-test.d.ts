// Ambient types for the Bun test runner so `tsc --noEmit` stays clean over src/
// without adding @types/bun (its global fetch override reddens unrelated files).
// The *.bun.test.ts files run under `bun test`, never vitest.
declare module 'bun:test' {
  // `timeoutMs` dipakai test PTY: batas default `bun test` 5 s, sedangkan satu login shell nyata
  // (`bash -l`) kadang butuh lebih dari 2 s untuk start dan test itu menunggu beberapa putaran.
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  /** Dipakai test PTY untuk membersihkan direktori temp `mkdtempSync` sesudah file selesai. */
  export function afterAll(fn: () => void | Promise<void>): void
  export function beforeAll(fn: () => void | Promise<void>): void
  // WS-19: describe/it + hooks + the matchers the CA2 suites use.
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  interface Matchers {
    toContain(expected: unknown): void
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toMatchObject(expected: unknown): void
    toBeNull(): void
    toBeDefined(): void
    toBeTruthy(): void
    toHaveLength(expected: number): void
    toBeGreaterThan(expected: number): void
    toMatch(expected: RegExp | string): void
  }
  export const expect: ((value: unknown) => Matchers & { not: Matchers }) & {
    arrayContaining(items: unknown[]): unknown
    any(ctor: unknown): unknown
  }
}

// bun:sqlite self-typed too — only the slice db.ts uses.
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename?: string)
    exec(sql: string): void
    query(sql: string): {
      all(...params: unknown[]): unknown[]
      get(...params: unknown[]): unknown
      /** `changes` = rows a write touched (Db.save's precondition check reads it). */
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    }
    close(): void
  }
}
