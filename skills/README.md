# Skills

Reusable, shareable procedural knowledge for the Runbook AI browser agent:
how a specific site really works, which of its endpoints are usable, which
traps to avoid. The agent sees a one-line brief for every skill and loads the
full text on demand, so a skill costs almost nothing until it is needed.

Each skill is a directory with a `SKILL.md` and, optionally, `scripts/*.js`
holding the code the agent runs (see [Scripts](#scripts)). The format follows the
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

## Scripts

Code the agent runs with `evalJavaScript` goes in `scripts/*.js`, not in
the body. The agent then calls it by name, e.g.
`skills.youtubeDataApi.search({query})`, instead of retyping a code block
on every call -- far fewer output tokens and no copy mistakes.

```js
// scripts/innertube.js -- plain JS, runs in the page (main world).

// No JSDoc: a private helper, not shown to the agent.
function cfg() { return window.ytcfg.data_; }

/** Search videos; pages of ~20 results each. -> [{videoId, title, channel}] */
async function search({ query, pages = 1 } = {}) { ... }
```

- Every **column-0 function with a `/** JSDoc */` block** is public. The
  prompt shows its signature and the JSDoc on one line, so the JSDoc should
  say what it takes and returns (`-> {shape}`), briefly. Functions without
  JSDoc, `const`s and other declarations are private to the skill.
- The namespace is the skill name in camelCase: `google-sheets-web` ->
  `skills.googleSheetsWeb`. Every function is called as async (the wrapper
  awaits it), so the agent awaits each call in its own code.
- When an `evalJavaScript` expression mentions `skills.<namespace>`, the
  extension prepends that skill's scripts (all files of the skill, wrapped in
  one function scope) to the expression. Nothing is installed on the page;
  each call is evaluated fresh. The skill does not have to be loaded.
- A throw comes back to the agent as `skills.<namespace>.<fn>: <message>`,
  so throw errors that tell the agent what to do ("no Discord token -- is
  this tab logged in?").
- Take an options object (`{guild, query, limit = 8}`) rather than
  positional arguments, return compact data (strings, small objects -- not
  raw API payloads), and keep `fetch`/DOM work inside the function.
- The body says when to use which function and what does NOT work; it can
  name functions (`skills.<namespace>.<fn>`), and the pack step fails if a
  named function does not exist. The agent can read the source with
  `readTextFile("skills/<name>/scripts/<file>.js")` when it must adapt one.
- The pack step (`sync-skills.sh`) syntax-checks every script and requires
  each file to have at least one public function.

## How the extension uses skills

At pack time the extension copies every `skills/*/SKILL.md` and its
`scripts/*.js` into a single bundled `skills.json`. At run time:

1. The system prompt lists every skill's `name -- description` under
   `## Skills`.
2. Each turn, skills whose `sites` match an open tab are listed under
   `## Skills for this page` (or loaded outright if `autoload` is set).
3. The agent calls `loadSkill({name})` -- in the same response as its page
   action, so it costs no extra turn -- and the body appears under
   `## Loaded skills` for the rest of the task, followed by one signature
   line per script function. At most 5 skills / ~15,000 tokens are loaded
   at once; `unloadSkill` frees a slot.
4. A task can force skills with `config.preloadSkills: ["name"]`.
5. Local skills in the extension's file store (below) are merged in; one
   with the same `name` overrides the bundled one.

## Local skills

A skill does not have to be in this catalog to be used. The extension's
file store (the Files panel; `tool/skill-store.js` in auto-chrome) holds
local skills in the same layout as this catalog:

```
skills/<name>/SKILL.md
skills/<name>/scripts/<file>.js
```

They are read at the start of every task and every turn, so an edit takes
effect without repacking, and a local skill with the same `name` as a
bundled one replaces it. Every way of running the agent sees them -- chat,
runbooks, the planner and MCP clients alike.

1. Write the skill directory exactly as described above. Validate it from
   `auto-chrome/`:

   ```bash
   node -e "const s=require('./extension/skills.js'),fs=require('fs'),d=process.argv[1];const sc={};for(const f of fs.existsSync(d+'/scripts')?fs.readdirSync(d+'/scripts'):[])sc['scripts/'+f]=fs.readFileSync(d+'/scripts/'+f,'utf8');const k=s.buildSkill(fs.readFileSync(d+'/SKILL.md','utf8'),sc);console.log(k.error?k:{name:k.name,functions:k.functions.map(f=>f.name),errors:s.skillScriptErrors(k)})" path/to/my-skill
   ```

   A malformed local skill (missing frontmatter, name or description, or a
   name that differs from its directory) is skipped at run time with a
   console warning, so check here first.

2. Copy it into the store. From a dev machine with the dev Chrome (CDP on
   :9222):

   ```bash
   node tool/skill-store.js push path/to/my-skill   # replaces skills/<name>/
   node tool/skill-store.js ls
   node tool/skill-store.js rm my-skill
   ```

   Or let the agent write it (next section).
   `auto-chrome/extension-test/skills-e2e.js` is a complete example:
   it pushes a fixture skill with a script and runs the task both ways
   (brief + `loadSkill`, and `autoload`).

3. From there the skill behaves like a bundled one: its brief is in
   `## Skills`, a `sites` match nudges or autoloads it, and
   `config.preloadSkills: ["name"]` loads it at task start regardless of
   site.

To debug, run with `returnTaskState: true` and look at
`taskState.loadedSkills` (bodies that were loaded) and the `actionLog` for
the `loadSkill` call and the `evalJavaScript` expressions. Once a local
skill is proven, promote it: add the folder here and repack the extension
(`./pack-extension.sh` regenerates `skills.json`), then remove the local
copy.

## Skills the agent learns

When the agent gets a site's API or a procedure working, it can save it with
its `saveSkill` tool as a **draft**: the same layout, kept in that task's
files. The task and its follow-ups use the draft right away; nothing else
sees it. The task's reply shows a skill card with icons to view the source,
approve, or delete the draft. Approving copies it into `skills/<name>/` in
the file store (replacing the whole folder at once), and from then on every
task uses it like any local skill. To change a skill, ask in a follow-up; the
agent saves a new complete draft for you to approve. An unapproved draft goes
away with its task.

## Contributing

Open a PR adding `skills/<name>/SKILL.md` (and `scripts/`). Test the functions live before
submitting and put the date in `tested`; a reviewer will run them again.
Sites change -- if a skill stops working, a PR updating it (or an issue
naming what broke) is the fix.
