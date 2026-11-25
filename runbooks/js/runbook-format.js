// Runbook format: runbooks/<slug>/{manifest.json, prompt.md, trace.json?}.
// Pure functions (no DOM) so they run in Node tests too. Same rules as the
// Runbook AI extension's lib/runbook-format.js (a separate repo), which writes
// these folders when a user exports a runbook; keep the two in step.

export const PARAM_TYPES = ['text', 'number', 'textarea', 'date', 'file'];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PARAM_NAME_RE = /^[A-Za-z0-9_]+$/;
export const MAX_PROMPT_BYTES = 12 * 1024;

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return s || 'my-runbook';
}

export function placeholders(prompt) {
  const out = new Set();
  for (const m of String(prompt || '').matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return [...out];
}

export function fillTemplate(tpl, values) {
  return String(tpl || '').replace(PLACEHOLDER_RE, (_, k) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : ''
  );
}

/** manifest.config: the runbook's limits only (design §5.2). */
export const CONFIG_KEYS = ['maxSteps', 'maxIterations'];

const PARAM_KEY_ORDER = ['name', 'label', 'type', 'default', 'placeholder', 'required', 'options', 'accept', 'multiple'];

/** Key order and cleanup matching the repo's manifests. */
export function normalizeManifest(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const out = {};
  out.title = String(m.title ?? '').trim();
  if (m.description) out.description = String(m.description).trim();
  if (m.note) out.note = String(m.note).trim();
  out.params = (Array.isArray(m.params) ? m.params : []).map(p => {
    const q = {};
    for (const k of PARAM_KEY_ORDER) if (p && p[k] !== undefined && p[k] !== '') q[k] = p[k];
    for (const k of Object.keys(p || {})) if (!(k in q) && p[k] !== undefined) q[k] = p[k];
    if (q.required === false) delete q.required;
    if (q.multiple === false) delete q.multiple;
    return q;
  });
  if (m.config && typeof m.config === 'object') {
    const c = {};
    for (const k of CONFIG_KEYS) if (m.config[k] !== undefined && m.config[k] !== '' && m.config[k] !== null) c[k] = Number(m.config[k]);
    if (Object.keys(c).length) out.config = c;
  }
  for (const k of Object.keys(m)) {
    if (!(k in out) && !['title', 'description', 'note', 'params', 'config'].includes(k)) out[k] = m[k];
  }
  return out;
}

export function manifestJson(manifest) {
  return JSON.stringify(normalizeManifest(manifest), null, 2) + '\n';
}

/**
 * Validate a runbook. Errors block saving/importing; warnings are shown.
 * Returns { errors: string[], warnings: string[] }.
 */
export function validateRunbook({ slug, manifest, prompt }, { checkSlug = true } = {}) {
  const errors = [];
  const warnings = [];
  if (checkSlug && !SLUG_RE.test(String(slug || ''))) {
    errors.push(`Slug "${slug || ''}" must be lowercase letters, digits and dashes (max 64), starting with a letter or digit.`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('manifest.json must be a JSON object.');
    return { errors, warnings };
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) errors.push('manifest.title is required.');
  for (const k of ['description', 'note']) {
    if (manifest[k] !== undefined && typeof manifest[k] !== 'string') errors.push(`manifest.${k} must be a string.`);
  }
  if (manifest.config !== undefined) {
    if (!manifest.config || typeof manifest.config !== 'object' || Array.isArray(manifest.config)) errors.push('manifest.config must be an object.');
    else for (const [k, v] of Object.entries(manifest.config)) {
      if (!CONFIG_KEYS.includes(k)) errors.push(`manifest.config.${k} is not supported (only ${CONFIG_KEYS.join(', ')}).`);
      else if (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 200) errors.push(`manifest.config.${k} must be a whole number from 1 to 200.`);
    }
  }
  const params = manifest.params === undefined ? [] : manifest.params;
  if (!Array.isArray(params)) {
    errors.push('manifest.params must be an array.');
  } else {
    const seen = new Set();
    params.forEach((p, i) => {
      const where = `params[${i}]`;
      if (!p || typeof p !== 'object') { errors.push(`${where} must be an object.`); return; }
      if (!PARAM_NAME_RE.test(String(p.name || ''))) errors.push(`${where}.name "${p.name || ''}" must be letters, digits or _.`);
      else if (seen.has(p.name)) errors.push(`${where}.name "${p.name}" is used twice.`);
      else seen.add(p.name);
      const type = p.type || 'text';
      if (!PARAM_TYPES.includes(type)) errors.push(`${where}.type "${type}" must be one of ${PARAM_TYPES.join(', ')}.`);
      if (p.options !== undefined && !Array.isArray(p.options)) errors.push(`${where}.options must be an array.`);
      if (type === 'number' && p.default !== undefined && p.default !== '' && Number.isNaN(Number(p.default))) {
        warnings.push(`${where}.default "${p.default}" is not a number.`);
      }
    });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    errors.push('prompt.md is empty.');
  } else {
    const bytes = new TextEncoder().encode(prompt).length;
    if (bytes > MAX_PROMPT_BYTES) errors.push(`prompt.md is ${Math.round(bytes / 1024)} KB; keep it under ${MAX_PROMPT_BYTES / 1024} KB.`);
    const names = new Set((Array.isArray(params) ? params : []).map(p => p && p.name));
    for (const ph of placeholders(prompt)) {
      if (!names.has(ph)) warnings.push(`{{${ph}}} in the prompt has no matching param.`);
    }
    if (Array.isArray(params)) {
      const used = new Set(placeholders(prompt));
      for (const p of params) {
        if (p && p.name && p.type !== 'file' && !used.has(p.name)) warnings.push(`Param "${p.name}" is not used in the prompt.`);
      }
    }
  }
  return { errors, warnings };
}

/** trace.json: optional; schema version 1 (design §5.4 step D). */
export function validateTrace(trace, manifest) {
  const errors = [];
  if (trace === undefined || trace === null) return { errors };
  if (typeof trace !== 'object' || Array.isArray(trace)) return { errors: ['trace.json must be a JSON object.'] };
  if (trace.version !== 1) errors.push('trace.json version must be 1.');
  if (!Array.isArray(trace.steps)) errors.push('trace.json steps must be an array.');
  else trace.steps.forEach((s, i) => {
    if (!s || typeof s.tool !== 'string' || typeof s.label !== 'string') errors.push(`trace.json steps[${i}] needs tool and label.`);
    if (s && s.actions !== undefined && !Array.isArray(s.actions)) errors.push(`trace.json steps[${i}].actions must be an array.`);
  });
  const names = new Set((manifest?.params || []).map(p => p && p.name));
  const used = [...new Set([...JSON.stringify(trace).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]))];
  for (const u of used) if (!names.has(u)) errors.push(`trace.json uses {{${u}}}, which is not a param.`);
  return { errors };
}
