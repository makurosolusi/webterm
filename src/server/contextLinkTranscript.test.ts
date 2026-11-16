import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linesFromClaude, readTranscriptFile, renderTranscriptLines } from './contextLinkTranscript'

const line = (o: unknown): string => JSON.stringify(o)
const assistant = (...content: unknown[]): string => line({ type: 'assistant', message: { content } })
const user = (content: unknown): string => line({ type: 'user', message: { content } })

describe('linesFromClaude', () => {
  it('prefixes assistant text blocks and skips empty ones', () => {
    expect(linesFromClaude(assistant({ type: 'text', text: 'done' }, { type: 'text', text: '' }))).toEqual(['assistant: done'])
  })
  it('renders a tool call with its most telling argument, cut at 200 chars', () => {
    expect(linesFromClaude(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }))).toEqual(['  $ Read /a/b.ts'])
    const long = linesFromClaude(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(300) } }))
    expect(long[0]).toBe(`  $ Bash ${'x'.repeat(200)}`)
  })
  it('names an anonymous tool "tool" and prints no argument when none is known', () => {
    expect(linesFromClaude(assistant({ type: 'tool_use', input: { unrelated: 1 } }))).toEqual(['  $ tool'])
    expect(linesFromClaude(assistant({ type: 'tool_use', name: 'T' }))).toEqual(['  $ T'])
  })
  it('prefers command over path-like keys', () => {
    expect(linesFromClaude(assistant({ type: 'tool_use', name: 'X', input: { path: '/p', command: 'ls' } }))).toEqual(['  $ X ls'])
  })
  it('accepts a plain-string user message and block-form user text', () => {
    expect(linesFromClaude(user('hello'))).toEqual(['user: hello'])
    expect(linesFromClaude(user([{ type: 'text', text: 'hi' }]))).toEqual(['user: hi'])
  })
  it('summarises a tool result to 3 lines joined by spaces', () => {
    expect(linesFromClaude(user([{ type: 'tool_result', content: 'a\nb\nc\nd' }]))).toEqual(['  = a b c'])
  })
  it('joins text parts of an array-form tool result and ignores non-text parts', () => {
    const parts = [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]
    expect(linesFromClaude(user([{ type: 'tool_result', content: parts }]))).toEqual(['  = one two'])
  })
  it('drops an empty tool result and truncates a long one at 500 chars', () => {
    expect(linesFromClaude(user([{ type: 'tool_result', content: '' }]))).toEqual([])
    expect(linesFromClaude(user([{ type: 'tool_result', content: 'y'.repeat(900) }]))[0]).toBe(`  = ${'y'.repeat(500)}`)
  })
  it('yields nothing for corrupt JSON, other entry types and missing content', () => {
    expect(linesFromClaude('{"type":"assistant","mess')).toEqual([])
    expect(linesFromClaude('not json')).toEqual([])
    expect(linesFromClaude('null')).toEqual([])
    expect(linesFromClaude(line({ type: 'summary', summary: 'x' }))).toEqual([])
    expect(linesFromClaude(line({ type: 'assistant' }))).toEqual([])
    expect(linesFromClaude(line({ type: 'assistant', message: { content: 'plain string' } }))).toEqual([])
  })
})

describe('renderTranscriptLines', () => {
  it('flattens in order, skipping blank and broken lines without throwing', () => {
    const buf = [user('q'), '', '  ', '{broken', assistant({ type: 'text', text: 'a' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } })].join('\n')
    expect(renderTranscriptLines(buf)).toEqual(['user: q', 'assistant: a', '  $ Bash ls'])
  })
  it('returns [] for an empty buffer', () => {
    expect(renderTranscriptLines('')).toEqual([])
  })
})

describe('readTranscriptFile', () => {
  let dir = ''
  let prev: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webterm-tr-'))
    prev = process.env.WEBTERM_DATA_DIR
    process.env.WEBTERM_DATA_DIR = dir
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
    else process.env.WEBTERM_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a small file whole and an empty file as ""', () => {
    writeFileSync(join(dir, 'a.jsonl'), 'one\ntwo\n')
    writeFileSync(join(dir, 'empty.jsonl'), '')
    expect(readTranscriptFile(join(dir, 'a.jsonl'))).toBe('one\ntwo\n')
    expect(readTranscriptFile(join(dir, 'empty.jsonl'))).toBe('')
  })
  it('returns only the last 4 MiB of a bigger file', () => {
    const MiB = 1024 * 1024
    writeFileSync(join(dir, 'big.jsonl'), Buffer.concat([Buffer.alloc(2 * MiB, 'a'), Buffer.alloc(4 * MiB, 'b')]))
    const got = readTranscriptFile(join(dir, 'big.jsonl')) as string
    expect(got.length).toBe(4 * MiB)
    expect(/^b+$/.test(got)).toBe(true)
  })
  it('refuses a symlink, a directory, a missing file and paths outside the roots', () => {
    const outside = join(tmpdir(), `webterm-tr-out-${process.pid}.jsonl`)
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(outside, join(dir, 'link.jsonl'))
      mkdirSync(join(dir, 'sub'))
      expect(readTranscriptFile(join(dir, 'link.jsonl'))).toBeNull()
      expect(readTranscriptFile(join(dir, 'sub'))).toBeNull()
      expect(readTranscriptFile(join(dir, 'nope.jsonl'))).toBeNull()
      expect(readTranscriptFile(outside)).toBeNull()
      expect(readTranscriptFile('/etc/passwd')).toBeNull()
      expect(readTranscriptFile('/dev/zero')).toBeNull()
    } finally {
      rmSync(outside, { force: true })
    }
  })
})
