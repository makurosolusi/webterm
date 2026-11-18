// Finds the "scanner" tests (guards that read many source files, so `vitest related` never selects
// them). The manifest test compares this list with scripts/test.policy.manifest.ts, so a new
// scanner cannot be forgotten. Pure: callers pass the file list and a reader.

const TEST_FILE = /\.test\.tsx?$/
/** File-name shapes that mark a guard: *olicy*, *.grep.test.ts, *invariants*. */
const SCANNER_NAME = /olicy|\.grep\.test\.|invariants/
/** Reads a directory tree... */
const READS_TREE = /readdirSync|Glob\(|import\.meta\.glob/
/** ...and walks it for source files. */
const WALKS_SOURCES = /\b(sources|walk|filesUnder|sourcesUnder|serverSources)\(|readdirSync\(\s*(join\(\s*)?([A-Z][A-Z_]*|clientRoot|__dirname)[\s\S]{0,40}recursive: true/

/** The scanner tests among `files` (repo-relative, `/` separated), sorted. */
export function discoverScanners(files: string[], read: (file: string) => string): string[] {
  return files
    .filter((f) => TEST_FILE.test(f))
    .filter((f) => {
      if (SCANNER_NAME.test(f.slice(f.lastIndexOf('/') + 1))) return true
      const text = read(f)
      return READS_TREE.test(text) && WALKS_SOURCES.test(text)
    })
    .sort()
}
