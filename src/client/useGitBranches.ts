// Git branch per workspace folder for the Sessions view headers. One `POST /api/git/info` for ALL
// folders (never one request per workspace), again when the set of folders changes or the window
// regains focus (a checkout in a terminal elsewhere). No polling. A failed lookup shows no branch.
import { useEffect, useState } from 'react'
import { GIT_INFO_MAX_PATHS, GIT_INFO_PATH, type GitInfoResponse } from '../shared/gitInfo'

/** Branch by cwd (exactly as passed in); folders outside a repo or on a detached HEAD are absent. */
export function useGitBranches(cwds: readonly (string | undefined)[]): Record<string, string> {
  // A stable key, so a new `workspaces` array with the same folders does not refetch.
  // ponytail: folders past the server cap (64) get no branch; split into chunks if boards ever get there.
  const key = [...new Set(cwds.filter((c): c is string => !!c && c.trim() !== ''))]
    .sort()
    .slice(0, GIT_INFO_MAX_PATHS)
    .join('\n')
  const [branches, setBranches] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!key) {
      setBranches({})
      return
    }
    const paths = key.split('\n')
    let alive = true
    let seq = 0
    const load = () => {
      const mine = ++seq
      fetchBranches(paths).then(
        (next) => {
          if (alive && mine === seq) setBranches(next)
        },
        (err: unknown) => {
          console.warn(`Sessions: git branch lookup failed for ${paths.length} workspace folder(s)`, err)
          if (alive && mine === seq) setBranches({})
        },
      )
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
    }
  }, [key])

  return branches
}

async function fetchBranches(paths: string[]): Promise<Record<string, string>> {
  const res = await fetch(GIT_INFO_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
  if (!res.ok) throw new Error(`POST ${GIT_INFO_PATH} -> ${res.status}`)
  const { results } = (await res.json()) as GitInfoResponse
  const out: Record<string, string> = {}
  for (const r of results) if (r.repo?.branch) out[r.path] = r.repo.branch
  return out
}
