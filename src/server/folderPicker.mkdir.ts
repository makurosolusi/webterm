// "New Folder" in the Choose a folder dialog (POST /api/fs, next to the GET listing in
// routes/misc.routes.ts). Not the fs verb `mkdir` (fsOps.write.ts): that one is `mkdir -p`, so it
// makes missing parents, answers ok when the folder exists and has no data-dir guard. Here: exactly
// one new folder inside an existing, real (not symlinked) folder, never inside the webterm data dir.
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { folderNameError } from '../shared/folderName'
import { DATA_DIR_MESSAGE, insideDataDir } from './workspaceCreate/projectsFolder'

export type PickerMkdirResult =
  | { status: 200; body: { path: string } }
  | { status: 400 | 403 | 404 | 409 | 500; body: { error: string; message: string } }

const fail = (status: 400 | 403 | 404 | 409 | 500, error: string, message: string): PickerMkdirResult => ({ status, body: { error, message } })

/** Creates `parent/name`; `dataDir` is the webterm data dir (injected so tests use a temp one). */
export async function pickerMkdir(parent: unknown, name: unknown, dataDir: string): Promise<PickerMkdirResult> {
  if (typeof parent !== 'string' || !isAbsolute(parent)) return fail(400, 'bad_parent', 'Parent folder must be an absolute path.')
  if (typeof name !== 'string') return fail(400, 'bad_name', 'Enter a folder name.')
  const nameError = folderNameError(name)
  if (nameError) return fail(400, 'bad_name', nameError)

  // lstat, not stat: a symlinked parent would put the folder wherever the link points.
  let st
  try {
    st = await lstat(parent)
  } catch (e) {
    return fromErrno(e, `Cannot open ${parent}`)
  }
  if (st.isSymbolicLink()) return fail(400, 'symlink_parent', `${parent} is a symbolic link. Open the folder it points to instead.`)
  if (!st.isDirectory()) return fail(400, 'bad_parent', `${parent} is not a folder.`)

  const target = join(parent, name)
  if (await insideDataDir(target, dataDir)) return fail(400, 'data_dir', DATA_DIR_MESSAGE)
  try {
    await mkdir(target) // not recursive: EEXIST is the "already exists" answer
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fail(409, 'exists', `"${name}" already exists in ${parent}.`)
    return fromErrno(e, `Cannot create ${target}`)
  }
  return { status: 200, body: { path: target } }
}

function fromErrno(e: unknown, what: string): PickerMkdirResult {
  const code = (e as NodeJS.ErrnoException).code
  const why = (e as Error).message
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail(403, 'denied', `${what}: permission denied (${why}).`)
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail(404, 'not_found', `${what}: the folder does not exist (${why}).`)
  return fail(500, 'mkdir_failed', `${what}: ${why}`)
}
