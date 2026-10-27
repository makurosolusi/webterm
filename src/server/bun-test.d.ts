// Ambient types for the Bun test runner so `tsc --noEmit` stays clean over src/
// without adding @types/bun (its global fetch override reddens unrelated files).
// The *.bun.test.ts files run under `bun test`, never vitest.
declare module 'bun:test' {
  export function test(name: string, fn: () => void | Promise<void>): void
  export function expect(value: unknown): {
    toContain(expected: string): void
    toBe(expected: unknown): void
  }
}
