// Folder picker "New Folder" (folderPicker.mkdir.ts): every refusal rule, the symlinked parent, the
// data-dir guard and success, on a real temp tree.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickerMkdir } from './folderPicker.mkdir'

const root = mkdtempSync(join(tmpdir(), 'wt-picker-mkdir-'))
const dataDir = join(root, 'data') // test-only
mkdirSync(dataDir)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const err = async (parent: unknown, name: unknown) => {
  const r = await pickerMkdir(parent, name, dataDir)
  return { status: r.status, error: 'error' in r.body ? r.body.error : null, message: 'message' in r.body ? r.body.message : '' }
}

describe('pickerMkdir', () => {
  test('creates exactly one folder and returns its path', async () => {
    const r = await pickerMkdir(root, 'proj', dataDir)
    expect(r).toEqual({ status: 200, body: { path: join(root, 'proj') } })
    expect(statSync(join(root, 'proj')).isDirectory()).toBe(true)
  })

  // 'é' x128 = 256 bytes in 128 characters.
  for (const name of ['', 'a/b', 'a\\b', 'a\0b', '.', '..', ' lead', 'trail ', 'é'.repeat(128), 42]) {
    test(`rejects the name ${JSON.stringify(name).slice(0, 20)}`, async () => {
      expect(await err(root, name)).toMatchObject({ status: 400, error: 'bad_name' })
    })
  }

  test('a 255-byte name is allowed', async () => {
    expect((await pickerMkdir(root, 'x'.repeat(255), dataDir)).status).toBe(200)
  })

  test('rejects a relative or missing parent', async () => {
    expect(await err('rel/dir', 'x')).toMatchObject({ status: 400, error: 'bad_parent' })
    expect(await err(undefined, 'x')).toMatchObject({ status: 400, error: 'bad_parent' })
    const missing = await err(join(root, 'nope'), 'x')
    expect(missing).toMatchObject({ status: 404, error: 'not_found' })
    expect(missing.message).toContain(join(root, 'nope'))
  })

  test('rejects a parent that is a file', async () => {
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(await err(join(root, 'file.txt'), 'x')).toMatchObject({ status: 400, error: 'bad_parent' })
  })

  test('refuses when the folder already exists (no mkdir -p "ok")', async () => {
    mkdirSync(join(root, 'taken'))
    const r = await err(root, 'taken')
    expect(r).toMatchObject({ status: 409, error: 'exists' })
    expect(r.message).toContain('"taken"')
  })

  test('never follows a symlinked parent', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-picker-outside-'))
    try {
      symlinkSync(outside, join(root, 'link'))
      expect(await err(join(root, 'link'), 'x')).toMatchObject({ status: 400, error: 'symlink_parent' })
      expect(existsSync(join(outside, 'x'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('refuses inside the webterm data dir, the data dir itself included', async () => {
    expect(await err(dataDir, 'x')).toMatchObject({ status: 400, error: 'data_dir' })
    mkdirSync(join(dataDir, 'sub'))
    expect(await err(join(dataDir, 'sub'), 'x')).toMatchObject({ status: 400, error: 'data_dir' })
    expect(existsSync(join(dataDir, 'x'))).toBe(false)
  })

  test('permission denied is a 403 with context', async () => {
    if (process.getuid?.() === 0) return // root ignores the mode bits
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      const r = await err(locked, 'x')
      expect(r).toMatchObject({ status: 403, error: 'denied' })
      expect(r.message).toContain(join(locked, 'x'))
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
