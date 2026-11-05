// One server call the dialogs make before Create / Clone: the resolved target, whether that name is
// taken (and the next free one), wrong-place warnings, and for a clone "already cloned at ...".
// Advisory only: cloneRepo/createProject still refuse a non-empty target and the data dir.
import { findExistingClone, type Candidate, type ExistingClone, type FindDeps } from './alreadyCloned'
import { deriveRepoDirName, expandCloneUrl } from './cloneUrl'
import { isTaken, nextFreeName, placeWarnings, projectsFolder, type FolderEnv, type PlaceWarning } from './projectsFolder'
import { resolveTarget } from './workspaceCreate'

export interface PreflightInput { parent: string; name?: string; url?: string }
export interface Preflight {
  target: string
  /** Exists and is not empty: Create/Clone would be refused. */
  taken: boolean
  /** Next free `name-N` when taken. */
  suggestion: string | null
  warnings: PlaceWarning[]
  /** Clone only: a folder already holding this repo. */
  existing: Candidate | null
  /** The already-cloned scan ran out of time and was skipped. */
  existingSkipped: boolean
}

export interface PreflightDeps {
  env: FolderEnv
  workspaces: () => Promise<Candidate[]>
  find?: FindDeps
}

/** Throws CreateError('bad_request') for an unusable parent/name, as the create calls would. */
export async function preflight(input: PreflightInput, deps: PreflightDeps): Promise<Preflight> {
  const url = input.url ? expandCloneUrl(input.url) : ''
  const name = input.name?.trim() || (url ? deriveRepoDirName(url) ?? '' : '')
  const target = resolveTarget(input.parent, name)
  const taken = await isTaken(target)
  const [suggestion, warnings, existing] = await Promise.all([
    taken ? nextFreeName(input.parent, name) : Promise.resolve(null),
    placeWarnings(target, deps.env),
    url
      ? Promise.all([deps.workspaces(), projectsFolder(deps.env)]).then(([ws, folder]) => findExistingClone(url, ws, [folder, input.parent], deps.find))
      : Promise.resolve<ExistingClone>({ match: null, skipped: false }),
  ])
  return { target, taken, suggestion, warnings, existing: existing.match, existingSkipped: existing.skipped }
}
