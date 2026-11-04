import { describe, expect, it } from 'vitest'
import { commentableLines, parseDraft, parseFindings, reviewPayload, reviewPrompt, slugOfPrUrl, type PrDraft } from './prreview.model'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep1
-gone
+new2
+new3
 keep4
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
`
const SHA = 'a'.repeat(40)

describe('prreview model', () => {
  it('commentable lines are the added and context lines of the new side', () => {
    const m = commentableLines(DIFF)
    expect([...m.keys()]).toEqual(['src/a.ts'])
    expect([...m.get('src/a.ts')!]).toEqual([1, 2, 3, 4])
  })

  it('parses the last json block, drops malformed findings and marks inline ones', () => {
    const text = 'first ```json\n[1]\n``` then\n```json\n[{"file":"./src/a.ts","line":3,"severity":"high","summary":"bug"},{"file":"src/a.ts","line":9,"severity":"weird","summary":"far"},{"file":"../x","line":1,"summary":"escape"},{"line":2}]\n```\nLooks fine otherwise.'
    expect(parseFindings(text, DIFF)).toEqual({
      findings: [
        { file: 'src/a.ts', line: 3, severity: 'high', summary: 'bug', inline: true },
        { file: 'src/a.ts', line: 9, severity: 'medium', summary: 'far', inline: false },
      ],
      summary: 'Looks fine otherwise.',
    })
    expect(parseFindings('no json here', DIFF)).toBeNull()
    expect(parseFindings('{"not":"an array"}', DIFF)).toBeNull()
  })

  it('builds one COMMENT review: inline comments for diff lines, the rest in the body', () => {
    const d: PrDraft = { key: 'k', repo: '/r', slug: 'o/r', pr: 3, url: 'u', title: 't', commitId: SHA, summary: 'Sum.', findings: [
      { file: 'src/a.ts', line: 2, severity: 'high', summary: 'bug', inline: true },
      { file: 'src/a.ts', line: 9, severity: 'low', summary: 'far', inline: false },
    ] }
    const p = reviewPayload(d)
    expect(p).toMatchObject({ commit_id: SHA, event: 'COMMENT', comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**high**: bug' }] })
    expect(p.body).toContain('Sum.')
    expect(p.body).toContain('`src/a.ts:9` **low**: far')
  })

  it('validates a hand-edited draft before anything is posted', () => {
    const ok = { repo: '/r', slug: 'o/r', pr: 3, commitId: SHA, findings: [{ file: 'a', line: 1, summary: 's', inline: true }] }
    expect(parseDraft(ok)).toMatchObject({ slug: 'o/r', findings: [{ inline: true, severity: 'medium' }] })
    expect(parseDraft({ ...ok, slug: 'o/r/../x' })).toBe('draft.slug must be owner/repo')
    expect(parseDraft({ ...ok, slug: '../..' })).toBe('draft.slug must be owner/repo')
    expect(parseDraft({ ...ok, commitId: 'main' })).toBe('draft.commitId must be a commit sha')
    expect(parseDraft({ ...ok, findings: [{ file: 'a' }] })).toBe('every finding needs file, line and summary')
  })

  it('prompt follows the claude-code-action review structure; slug from the PR url', () => {
    const p = reviewPrompt({ slug: 'o/r', pr: 3, title: 'T', baseRef: 'main' }, DIFF)
    expect(p.startsWith('REPO: o/r\nPR NUMBER: 3\n')).toBe(true)
    expect(p).toContain('Security implications')
    expect(p).toContain('The PR branch is already checked out in the current working directory.')
    expect(slugOfPrUrl('https://github.com/o/r.js/pull/12')).toBe('o/r.js')
    expect(slugOfPrUrl('https://github.com/o/r/issues/12')).toBeNull()
  })
})
