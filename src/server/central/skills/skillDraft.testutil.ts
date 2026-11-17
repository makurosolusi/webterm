// test-only: a title and a body that satisfy the skill template, for tests that need a lint-clean proposal.
export const GOOD_TITLE = 'Demo skill'

/** A template-conformant body; `label` becomes the first step so two bodies can differ. */
export const tpl = (label = 'Read the portfolio.'): string =>
  `## Purpose\nSummarize the project.\n\n## When to use\nWhen asked for status.\n\n## Steps\n1. ${label}\n2. Write five lines.\n\n## Do not\n- Guess.\n\n## Done when\nThe summary is written.\n`

export const GOOD_BODY = tpl()
