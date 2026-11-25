// The runbook designer's LLM side: system prompt, few-shot examples (the
// repo's own runbooks), the two call paths (extension callLLM with the
// user's model, or the free tier directly), and local quality checks.

import { ext, FREE_LLM } from './extension.js';
import { validateRunbook, normalizeManifest, slugify, SLUG_RE } from './runbook-format.js';

const EXAMPLE_SLUGS = ['find-craigslist-cars', 'car-buying-agent', 'pay-my-bill'];

export const DESIGNER_SYSTEM = `You design "runbooks" for Runbook AI, a browser agent that runs inside the user's own Chrome, logged into their own accounts.

A runbook is two files:
- manifest.json: {"title", "description", "note"?, "params": [...]}
- prompt.md: the task prompt, with {{param_name}} placeholders filled from the form.

How a runbook runs: the prompt becomes a planner task. The planner delegates browsing to worker agents and can also:
- browse and act on any site (click, type, read pages, fill forms, download);
- <subTask>...</subTask> blocks: delegate that block to a fresh worker (sees only that block and the task files);
- <forEachItem>...</forEachItem> blocks: run the block once per item found (max ~10 per call);
- save/load task files (JSON/CSV) to pass data between steps -- name the file and its shape;
- create_monitor (recurring checks, at least hourly) and set_schedule (run on a schedule);
- read files the user attached (photos, PDFs) by name;
- read the user's secret vault (passwords, card numbers) and personal notes (name, email, address);
- finish by returning a short summary and, when useful, an HTML file (tables render on the page).

Manifest params: {"name" (letters/digits/_), "label", "type": text|number|textarea|date|file, "default"?, "placeholder"?, "required"?, "options"? (array -> dropdown), "accept"? and "multiple"? (file only)}.

Authoring rules:
1. Make every user-specific value a param with a sensible default (place, price range, counts, names of sites, recipients). Every {{x}} in the prompt must be a param; every non-file param must be used.
2. Never make passwords, card numbers or other secrets params: say "use my details from the secret vault". Name/email come from personal notes.
3. Put setup requirements (log in to X first, add card to vault) in "note", not the prompt.
4. Structure the prompt as numbered stages ("## 1. Find listings"). Say exactly what to collect, and save intermediate data to a named task file with its shape (e.g. save "leads.json" as an array of {title, price, url}).
5. Verify before claiming success (e.g. open Sent and confirm the email is there; confirm an on-page success message). If it can't be confirmed, record it as failed.
6. End with what to return (e.g. "an HTML table with columns title (link), price, date").
7. The agent can't ask questions mid-run. Put assumptions and open questions in "notes" instead.
8. Keep the prompt focused, under ~4 KB. Prefer a few clear stages over a complex multi-agent system.
9. File params: refer to attached files with {{param}} (expands to the file names).

Respond with ONE JSON object, nothing else:
{"slug": "kebab-case-id", "manifest": {...}, "prompt": "...", "summary": "one or two sentences for the user", "notes": ["assumption or question", ...], "changes": ["what changed and why", ...]}

When revising an existing runbook ("Current runbook" is given):
- Diagnose from the run evidence first (status, result, step trace, errors), then make minimal targeted edits. Don't rewrite parts that worked.
- Keep the slug and param names stable unless the user asks (renaming breaks saved values).
- If the failure is environmental (logged out, captcha, site down), say so in notes and adjust "note" rather than the prompt.
- "changes" must list every change. If nothing needs changing, return the runbook unchanged with changes: [] and explain in summary.`;

let examplesP = null;

/** Few-shot examples: the repo's runbooks, fetched from this site. */
export function loadExamples(baseUrl = '') {
  if (!examplesP) {
    examplesP = Promise.all(EXAMPLE_SLUGS.map(async slug => {
      try {
        const [m, p] = await Promise.all([
          fetch(`${baseUrl}${slug}/manifest.json`).then(r => (r.ok ? r.json() : null)),
          fetch(`${baseUrl}${slug}/prompt.md`).then(r => (r.ok ? r.text() : null)),
        ]);
        return m && p ? { slug, manifest: m, prompt: p } : null;
      } catch { return null; }
    })).then(list => list.filter(Boolean));
  }
  return examplesP;
}

function exampleText(examples) {
  if (!examples.length) return '';
  return 'Example runbooks (good style to follow):\n\n' + examples.map(e =>
    `### ${e.slug}\nmanifest.json:\n${JSON.stringify(e.manifest, null, 2)}\nprompt.md:\n${e.prompt.trim()}`).join('\n\n');
}

/**
 * Build the messages for one designer turn.
 * history: earlier turns [{role:'user'|'assistant', content}] (short).
 * current: {slug, manifest, prompt} | null; evidence: run evidence | null.
 */
export function buildMessages({ examples, history = [], current = null, evidence = null, request, startFrom = null }) {
  const parts = [];
  if (current) parts.push(`Current runbook:\n${JSON.stringify({ slug: current.slug, manifest: current.manifest, prompt: current.prompt }, null, 2)}`);
  else if (startFrom) parts.push(`Start from this runbook and adapt it:\n${JSON.stringify(startFrom, null, 2)}`);
  if (evidence) parts.push(`Run evidence from the latest test run:\n${JSON.stringify(evidence, null, 2)}`);
  parts.push(current
    ? `User request: ${request || '(no feedback given -- diagnose the run evidence and fix what went wrong)'}`
    : `Design a new runbook for this goal: ${request}`);
  return [
    { role: 'system', content: DESIGNER_SYSTEM + '\n\n' + exampleText(examples) },
    ...history.slice(-6),
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function stripFence(s) {
  const t = String(s || '').trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

/** One LLM call returning parsed JSON. */
export async function callDesignerLLM(messages, { useFree }) {
  if (!useFree) {
    const resp = await ext('callLLM', { messages, role: 'planner', timeout: 180000 });
    if (resp?.error) throw Object.assign(new Error(resp.message || resp.error), { code: resp.error });
    let result = resp?.result;
    if (Array.isArray(result)) result = result[0];
    if (!result || typeof result !== 'object') throw Object.assign(new Error('The model returned no JSON.'), { code: 'bad-json' });
    return result;
  }
  const res = await fetch(`${FREE_LLM.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FREE_LLM.llmApiKey}`,
      // Required: the router turns away free-tier calls without an
      // X-Runbook-Task-Id / -Version / -Role header. Role also labels these
      // calls in the router's call log.
      'X-Runbook-Role': 'designer',
      'X-Runbook-Source': 'runbooks-designer',
    },
    body: JSON.stringify({ model: 'free', temperature: 0.3, response_format: { type: 'json_object' }, messages }),
  });
  if (res.status === 429) throw Object.assign(new Error('Free limit reached — try again in a few minutes, or install the Runbook AI extension and add your own API key.'), { code: 'rate-limited' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `LLM error ${res.status}`), { code: 'llm-error' });
  const content = data?.choices?.[0]?.message?.content;
  try {
    return JSON.parse(stripFence(content));
  } catch {
    throw Object.assign(new Error('The model did not return valid JSON.'), { code: 'bad-json' });
  }
}

/** Local checks before showing a draft (§6.5). */
export function checkDraft(out, { existingSlugs = [], ownSlug = null } = {}) {
  const problems = [];
  if (!out || typeof out !== 'object') return { problems: ['Response was not an object.'] };
  const slug = SLUG_RE.test(String(out.slug || '')) ? out.slug : slugify(out.slug || out.manifest?.title);
  const draft = { slug: ownSlug || slug, manifest: normalizeManifest(out.manifest || {}), prompt: String(out.prompt || '') };
  const { errors, warnings } = validateRunbook(draft);
  problems.push(...errors);
  problems.push(...warnings.filter(w => /no matching param|is not used/.test(w)));
  if (!ownSlug && existingSlugs.includes(draft.slug)) {
    // Not a problem for the model; the page picks a unique slug.
  }
  return {
    problems,
    draft,
    summary: String(out.summary || ''),
    notes: Array.isArray(out.notes) ? out.notes.map(String).slice(0, 8) : [],
    changes: Array.isArray(out.changes) ? out.changes.map(String).slice(0, 20) : [],
  };
}

/**
 * Full designer turn: call, check, and retry once with the problems fed
 * back. Returns {draft, summary, notes, changes, problems}.
 */
export async function designTurn(args, { useFree, ownSlug = null, existingSlugs = [] }) {
  const examples = await loadExamples(args.baseUrl || '');
  const messages = buildMessages({ ...args, examples });
  let out = await callOnceWithJsonRetry(messages, useFree);
  let checked = checkDraft(out, { ownSlug, existingSlugs });
  if (checked.problems.length) {
    const retry = [...messages,
      { role: 'assistant', content: JSON.stringify(out) },
      { role: 'user', content: `Fix these problems and return the full JSON object again:\n- ${checked.problems.join('\n- ')}` }];
    try {
      out = await callOnceWithJsonRetry(retry, useFree);
      const again = checkDraft(out, { ownSlug, existingSlugs });
      if (again.problems.length <= checked.problems.length) checked = again;
    } catch { /* keep the first answer */ }
  }
  return checked;
}

async function callOnceWithJsonRetry(messages, useFree) {
  try {
    return await callDesignerLLM(messages, { useFree });
  } catch (err) {
    if (err.code !== 'bad-json') throw err;
    return callDesignerLLM([...messages, { role: 'user', content: 'Return only the JSON object.' }], { useFree });
  }
}
