// Under Bun, writing the prompt to a child that already died raises EPIPE on its stdin; without a listener
// that is an uncaught exception, which ends the whole server (the native app exits through forceExit).
// The helper runner must turn it into the normal "claude exited" rejection instead. The prompt is larger than a
// pipe buffer (64 KiB), so the write is still pending when the child dies: EPIPE every time, not by luck.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStructuredRunner } from './claudeStructured'

const dir = mkdtempSync(join(tmpdir(), 'structured-stdin-'))
const prevData = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = join(dir, 'data') // provider store lookups stay inside the test dir
afterAll(() => {
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(dir, { recursive: true, force: true })
})

describe('structured runner stdin', () => {
  test('a claude killed before it reads the prompt rejects with its exit, never an uncaught EPIPE', async () => {
    const bin = join(dir, 'claude-dies')
    writeFileSync(bin, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 }) // test-only: SIGTERM at once (exit 143)
    const uncaught: unknown[] = []
    const seen = (err: unknown): void => { uncaught.push(err) }
    process.on('uncaughtException', seen)
    try {
      const run = createStructuredRunner('checkpoint', { bin })
      const out = await run({ prompt: 'x'.repeat(1 << 20), schema: {} }, new AbortController().signal)
        .then(() => 'resolved', (err: Error) => err.message)
      await new Promise((r) => setTimeout(r, 100))
      expect(out).toBe('checkpoint: claude exited null')
    } finally {
      process.off('uncaughtException', seen)
    }
    expect(uncaught).toEqual([])
  })
})
