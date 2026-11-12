// Shipped Central skills as Bun text imports, so `bun build --compile` embeds them: in the binary the
// `builtin/` folder only exists in /$bunfs and cannot be listed. Under `bun run dev` Bun reads the same
// files from source. Bun-only (vitest reads builtin/ from disk); builtinSkills.embedded.bun.test.ts fails
// when a folder in builtin/ is missing here.
import approvalFlow from './builtin/webterm-approval-flow/SKILL.md' with { type: 'text' }
import centralBasics from './builtin/webterm-central-basics/SKILL.md' with { type: 'text' }
import projectStatus from './builtin/webterm-project-status/SKILL.md' with { type: 'text' }
import skillAuthoring from './builtin/webterm-skill-authoring/SKILL.md' with { type: 'text' }

/** SKILL.md text of every shipped skill, by skill name. */
export const BUILTIN_SKILLS: Readonly<Record<string, string>> = {
  'webterm-approval-flow': approvalFlow,
  'webterm-central-basics': centralBasics,
  'webterm-project-status': projectStatus,
  'webterm-skill-authoring': skillAuthoring,
}
