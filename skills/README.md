# Skills

Reusable, shareable procedural knowledge for the Runbook AI browser agent:
how a specific site really works, which of its endpoints are usable, which
traps to avoid. The agent sees a one-line brief for every skill and loads the
full text on demand, so a skill costs almost nothing until it is needed.

Each skill is a directory with a `SKILL.md`. The format follows the
[Agent Skills](https://agentskills.io) convention (YAML frontmatter with
`name`, `description`, `license`, `metadata`; markdown body), so the same
directory also works in other skill-aware agents. Everything Runbook-specific
sits under `metadata.runbookai`.

```
skills/
  youtube-data-api/
    SKILL.md
  gmail-web/
    SKILL.md
  README.md
```

## SKILL.md

```markdown
---
name: youtube-data-api
description: One sentence, <= 200 chars. This IS the trigger -- the agent reads it to decide whether to load the skill.
license: MIT
metadata:
  runbookai:
    agent: worker            # worker | planner | both  (only worker is consumed today)
    sites: ["*.youtube.com", "youtu.be"]   # hostname globs; optional
    autoload: true           # load the body automatically when an open tab matches `sites`
    tags: [site, api, video]
    tested: 2026-08-28       # when the recipes were last verified live
---

Body: what to do, in the agent's terms (tool names, exact URLs, field
names, the traps). Imperative, concrete, no marketing.
```

### Rules

- `name`: lowercase letters, digits and hyphens, unique across the catalog;
  matches the directory name.
- `description`: at most 200 characters. It is the only thing the agent sees
  until it loads the skill, so say *when* to use it, not just what it is.
- Body: at most ~1,500 tokens (~6,000 characters). Longer material does not
  belong in a skill; it belongs in the site's own docs.
- `sites`: exact hostname globs (`*.example.com`, `example.com`). They are
  the only automatic trigger. A skill without `sites` is loaded when the
  agent picks it from the brief, or when a task names it in
  `config.preloadSkills`.
- `autoload`: reserve it for site recipes that are needed on nearly every
  task on that site; it skips the agent's decision and the `loadSkill` call.
- One skill per trigger context. Knowledge that fires on the same site for
  the same kind of task is one skill with sections (YouTube search +
  comments + metadata + transcripts = one skill). Different contexts (reading
  Gmail vs sending Gmail) are separate skills.
- Never include credentials, cookies, tokens, or anything user-specific.
- Say what does NOT work, with the reason. "Video bytes are not obtainable
  from the page (signature cipher + per-video token); say so and stop" saves
  more iterations than any recipe.

## How the extension uses skills

At pack time the extension copies every `skills/*/SKILL.md` into a single
bundled `skills.json`. At run time:

1. The system prompt lists every skill's `name -- description` under
   `## Skills`.
2. Each turn, skills whose `sites` match an open tab are listed under
   `## Skills for this page` (or loaded outright if `autoload` is set).
3. The agent calls `loadSkill({name})` -- in the same response as its page
   action, so it costs no extra turn -- and the body appears under
   `## Loaded skills` for the rest of the task. At most 3 skills / ~4,500
   tokens are loaded at once; `unloadSkill` frees a slot.
4. A task can force skills with `config.preloadSkills: ["name"]`, and supply
   private ones with `config.localSkills: ["<SKILL.md text>"]` (a local skill
   with the same `name` overrides the bundled one).

## Contributing

Open a PR adding `skills/<name>/SKILL.md`. Test the recipes live before
submitting and put the date in `tested`; a reviewer will run them again.
Sites change -- if a skill stops working, a PR updating it (or an issue
naming what broke) is the fix.
