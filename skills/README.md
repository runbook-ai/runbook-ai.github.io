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

## SKILL.md

```markdown
---
name: youtube-data-api
description: One sentence, <= 1024 chars. This IS the trigger -- the agent reads it to decide whether to load the skill.
license: MIT
metadata:
  runbookai:
    agent: worker            # worker | planner | both  (only worker is consumed today)
    sites: ["*.youtube.com", "youtu.be"]   # host patterns (see below); optional
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
- `description`: at most 1,024 characters (keep it to a sentence or two:
  every description sits in the system prompt). It is the only thing the agent sees
  until it loads the skill, so say *when* to use it, not just what it is.
- Body: at most ~5,000 tokens (~20,000 characters, ~500 lines). Longer material does not
  belong in a skill; it belongs in the site's own docs.
- `sites`: hostname patterns, matched case-insensitively against every open
  tab. They are the only automatic trigger. A skill without `sites` is loaded
  when the agent picks it from the brief, or when a task names it in
  `config.preloadSkills`. Pattern forms:
  - `example.com` -- exact host.
  - `*.example.com` -- `example.com` and any subdomain.
  - `quip*.com` -- `*` anywhere matches any run of characters
    (`quip.com`, `quip-acme.com`, but not `www.quip.com`); `*.quip*.com`
    combines both rules. Use this for per-tenant hosts so the catalog does not
    have to list tenant names.
  - `'/^quip(-\w+)?\.com$/'` -- a JavaScript regex between slashes (flags
    allowed, e.g. `/…/i`); anchor it yourself. Single-quote it in YAML so
    backslashes survive.
  - Hosts keep their port (`localhost:9007`): a glob written with a port
    matches only that port, one without matches regardless of port; a regex
    is tested against the host including its port.
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
   `## Loaded skills` for the rest of the task. At most 5 skills / ~15,000
   tokens are loaded at once; `unloadSkill` frees a slot.
4. A task can force skills with `config.preloadSkills: ["name"]`, and supply
   private ones with `config.localSkills: ["<SKILL.md text>"]` (a local skill
   with the same `name` overrides the bundled one).

## Local skills

A skill does not have to be in this catalog to be used. Any task can pass
private or in-progress skills through its config; they overlay the bundled
catalog for that task only, and a local skill with the same `name` as a
bundled one replaces it. There is no settings page or file drop -- the only
entry point is `config.localSkills`.

1. Write a `SKILL.md` exactly as described above (same frontmatter, same
   rules). Validate it from `auto-chrome/`:

   ```bash
   node -e "console.log(require('./extension/skills.js').parseSkillMd(require('fs').readFileSync('SKILL.md','utf8')))"
   ```

   A malformed skill (missing frontmatter, name or description) is dropped
   silently at run time, so check for an `error` field here first.

2. Pass the file's **text** (not its path) in `config.localSkills`, an array
   so several can go together. Via the action hub:

   ```bash
   WS_PORT=9004 node tool/action.js runHeadlessTaskWithConfig \
     prompt="Find Jane Doe's desk on http://intranet.corp" \
     config="$(jq -n --rawfile s SKILL.md '{localSkills: [$s], ephemeralSession: true}')"
   ```

   Anything that reaches `runHeadlessTaskWithConfig` / `runPlannerTask`
   config works the same way. `auto-chrome/extension-test/skills-e2e.js`
   is a complete example: it builds the SKILL.md inline and runs the task
   both ways (brief + `loadSkill`, and `autoload`).

3. From there the skill behaves like a bundled one: its brief is in
   `## Skills`, a `sites` match nudges or autoloads it, and
   `config.preloadSkills: ["name"]` loads it at task start regardless of
   site.

To debug, run with `returnTaskState: true` and look at
`taskState.loadedSkills` (bodies that were loaded) and the `actionLog` for
a `loadSkill` call. Once a local skill is proven, promote it: add the
folder here and repack the extension (`./pack-extension.sh` regenerates
`skills.json`), after which `localSkills` is no longer needed.

## Contributing

Open a PR adding `skills/<name>/SKILL.md`. Test the recipes live before
submitting and put the date in `tested`; a reviewer will run them again.
Sites change -- if a skill stops working, a PR updating it (or an issue
naming what broke) is the fix.
