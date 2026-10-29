// Ambient types for the Bun test runner so `tsc --noEmit` stays clean over src/
// without adding @types/bun (its global fetch override reddens unrelated files).
// The *.bun.test.ts files run under `bun test`, never vitest.
declare module 'bun:test' {
  // `timeoutMs` dipakai test PTY: batas default `bun test` 5 s, sedangkan satu login shell nyata
  // (`bash -l`) kadang butuh lebih dari 2 s untuk start dan test itu menunggu beberapa putaran.
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  interface Matchers {
    toContain(expected: string): void
    toBe(expected: unknown): void
  }
  export function expect(value: unknown): Matchers & { not: Matchers }
}

// bun:sqlite self-typed too — only the slice db.ts uses.
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename?: string)
    exec(sql: string): void
    query(sql: string): {
      all(...params: unknown[]): unknown[]
      get(...params: unknown[]): unknown
      run(...params: unknown[]): void
    }
  }
}
