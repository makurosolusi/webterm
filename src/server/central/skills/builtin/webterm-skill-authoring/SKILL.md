---
name: webterm-skill-authoring
description: "How to write a skill that passes lint and review: kind, title, template and intake checklist. Use when a procedure repeats and should be written down."
metadata:
  webterm.title: "Writing a skill"
  webterm.version: "3"
  webterm.origin: "builtin"
  webterm.caps: "skill.propose,skill.load"
  webterm.audience: "central"
---
# Writing a skill

## Purpose
Skills are written only by an author agent together with the human, never typed by hand. Every skill is structured and complete so a reader can follow it without guessing. The draft stays in quarantine until the human approves it with one click.

## When to use
When a procedure has repeated and you can state it as steps, or when the human asks for a new skill or a revision of one.

## Steps
1. Settle the checklist yourself from the request: kind, title, name slug, purpose, trigger, steps, constraints, success criteria. Pick sensible defaults; ask (one question, with a default) only when the topic itself is missing, then write in the same turn.
2. Kind (required, no default): `central` for rules Central itself follows, `canvas` for procedures canvas agent sessions follow. A skill has exactly one kind and keeps it; Central cannot load `canvas` skills and agents never see `central` ones.
3. Title: 3 to 80 characters, one line, no markdown. Name: `webterm-` plus lowercase words joined by hyphens. Description: up to 300 characters, what it does and when to use it.
4. Body: up to 4000 characters of Markdown with these level-2 sections in this order: Purpose, When to use, Steps (a numbered list with at least 2 items), Do not, Done when. A Notes section may come last.
5. Propose with title, name, description, body, caps and audience. List in caps only the tool verbs the steps rely on.
6. After a rejection, fix the listed lint code (`structure` names the missing section) and propose again; there is a daily proposal limit.

## Do not
- Add shell commands, download-and-run patterns, links, absolute paths, parent-folder paths or file URLs.
- Add anything shaped like a key, token or password.
- Tell the reader to skip rules, hide output or activate a skill.
- Copy another skill; name it and let the reader load it.
- Say a draft is active: only the human can approve it.

## Done when
The proposal was accepted into review with a title, the full template and an explicit kind, and the human knows to approve it in the Skills tab.
