---
name: webterm-skill-authoring
description: "How to draft a skill proposal that passes lint and review. Use when a procedure repeats and should be written down."
metadata:
  webterm.version: "1"
  webterm.origin: "builtin"
  webterm.caps: "skill.propose,skill.load"
  webterm.audience: "central"
---
# Writing a skill proposal

Propose a skill only for a procedure that has repeated and that you can state as steps. Call skill.propose with name, description, body, caps and audience. The draft stays in quarantine until a human approves it.

## Shape
- name: `webterm-` plus lowercase words joined by hyphens.
- description: up to 300 characters. Say what it does and when to use it.
- body: up to 4000 characters of Markdown. Numbered steps, short.
- caps: the tool verbs the steps rely on. List only what the steps need.
- audience (required, no default): `central` for rules Central itself follows, `canvas` for procedures canvas agent sessions follow. A skill has exactly one kind; Central cannot load `canvas` skills and agents never see `central` ones.

## Lint rejects
- Shell commands, download-and-run patterns, or anything that needs a terminal.
- Links, absolute paths, parent-folder paths and file URLs.
- Anything shaped like a key, token or password.
- Text that tells the reader to skip rules, hide output or activate a skill.
- Hidden or control characters, and bodies over the size limit.

## Habits
- One skill, one job. Do not copy another skill; name it and let the reader load it.
- Prefer steps that call registered tools over prose about what to do.
- After a rejection, fix the listed code and propose again; there is a daily proposal limit.
