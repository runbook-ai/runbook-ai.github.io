// Running a runbook through the extension, rendering the result, and
// gathering run evidence for the designer. Shared by the Run page and the
// Designer's Test run, so both take exactly the same path.

import { ext, openSidePanel } from './extension.js';
import { fillTemplate } from './runbook-format.js';
import { escapeHtml } from './dom.js';

/** File[] -> the extension's taskFiles map, de-duplicating names. */
export async function toTaskFiles(files) {
  const out = {};
  for (const f of files) {
    let name = f.name || 'file';
    if (out[name]) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext_ = dot > 0 ? name.slice(dot) : '';
      let i = 2;
      while (out[`${stem}-${i}${ext_}`]) i++;
      name = `${stem}-${i}${ext_}`;
    }
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ''); const c = s.indexOf(','); res(c === -1 ? '' : s.slice(c + 1)); };
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    });
    out[name] = { name, mimeType: f.type || 'application/octet-stream', base64, size: f.size };
  }
  return out;
}

export function buildPrompt(promptTpl, form) {
  return fillTemplate(promptTpl, form.values());
}

/**
 * Run a prompt as a planner task. Call from a click handler (the side panel
 * can only be opened from a user gesture). `onTick(seconds)` while running.
 * Resolves with the runPlannerTask response; throws on extension errors.
 */
export async function runPrompt({ prompt, files = [], onTick = () => {} }) {
  await openSidePanel();
  const taskFiles = await toTaskFiles(files);
  const t0 = Date.now();
  const tick = setInterval(() => onTick(Math.floor((Date.now() - t0) / 1000)), 1000);
  try {
    // Per-task overrides apply to this run only; the LLM is whatever the
    // extension is set to (its free tier when no API key is set). maxSteps 30: runbook
    // bootstraps make many cheap tool calls. enableLocalHistory: the
    // extension records this run's LLM calls in its own IndexedDB (in this
    // browser, nothing leaves it) so getTaskLlmLogs can give the designer a
    // step trace; the setting is off by default.
    const config = { maxSteps: 30, enableLocalHistory: true };
    const resp = await ext('runPlannerTask', { prompt, config, files: taskFiles });
    clearInterval(tick);
    if (resp?.error) throw Object.assign(new Error(resp.message || resp.error), { code: resp.error });
    resp.elapsed = Math.floor((Date.now() - t0) / 1000);
    await switchBack();
    return resp;
  } finally {
    clearInterval(tick);
  }
}

// The agent likely switched to another tab; switch back to this page.
async function switchBack() {
  try {
    const state = await ext('getTaskState', {});
    const mine = (state?.tabs || []).find(t => t.url === location.href);
    if (mine) await ext('switchToTab', { tabId: mine.tabId });
  } catch (err) {
    console.warn('switch back failed:', err.message);
  }
}

function decodeBase64Utf8(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function htmlFile(resp) {
  const files = resp?.files || {};
  return Object.values(files).find(f => /html/i.test(f.mimeType || '') || /\.html?$/i.test(f.name || ''));
}

/** Render a run result into a sandboxed iframe (no scripts) and auto-size it. */
export function renderResult(frame, resp) {
  const entry = htmlFile(resp);
  const summary = resp?.result || '';
  let body;
  if (entry) {
    body = decodeBase64Utf8(entry.base64 || '');
    if (summary) body = `<div style="margin:0 0 14px;color:#374151;white-space:pre-wrap">${escapeHtml(summary)}</div>` + body;
  } else {
    body = /<\w+[\s>]/.test(summary)
      ? summary
      : `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1a1a2e;margin:0">${escapeHtml(summary || '(no result)')}</pre>`;
  }
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>html,body{margin:0;padding:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;color:#1a1a2e;background:#fff}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f9fafb;font-weight:600}img{max-width:240px;height:auto;border-radius:6px}
a{color:#6366f1;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body>${body}</body></html>`;
  if (frame.__fit) { frame.__fit.disconnect(); frame.__fit = null; }
  const fit = () => {
    const d = frame.contentDocument;
    if (!d) return;
    const hgt = Math.max(d.documentElement.scrollHeight || 0, d.body?.scrollHeight || 0);
    if (hgt) frame.style.height = hgt + 'px';
  };
  frame.onload = () => {
    fit();
    const d = frame.contentDocument;
    if (!d?.body) return;
    const ro = new ResizeObserver(fit);
    ro.observe(d.body);
    frame.__fit = ro;
  };
}

export function resultMeta(resp) {
  const names = Object.keys(resp?.files || {});
  return `Task ${resp?.taskId || '?'} · ${resp?.runCount ?? 0} step${resp?.runCount === 1 ? '' : 's'}${resp?.elapsed != null ? ` · ${resp.elapsed}s` : ''}${names.length ? ' · ' + names.join(', ') : ''}`;
}

const clip = (s, n) => {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + `… [${str.length - n} more chars]` : str;
};

const stripTags = s => String(s || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/**
 * What the designer gets about a run (§6.3): status, result, returned files
 * as text, the step trace (one line per LLM call), errors, and the params
 * used (file params as names only). Never file contents of inputs.
 */
export async function collectEvidence(resp, { values = {}, error = null } = {}) {
  const ev = {
    status: error ? 'error' : resp?.status || 'unknown',
    taskId: resp?.taskId || null,
    steps: resp?.runCount ?? null,
    elapsedSec: resp?.elapsed ?? null,
    params: values,
    result: clip(resp?.result, 4000),
    returnedFiles: {},
    trace: [],
    errors: [],
  };
  if (error) ev.errors.push(clip(error, 1000));
  let budget = 6000;
  for (const f of Object.values(resp?.files || {})) {
    if (budget <= 0) break;
    const isText = /^text\/|json|html|csv|xml/i.test(f.mimeType || '') || /\.(html?|txt|md|csv|json)$/i.test(f.name || '');
    if (!isText) { ev.returnedFiles[f.name] = `(${f.mimeType || 'binary'}, ${f.size || '?'} bytes)`; continue; }
    const text = clip(stripTags(decodeBase64Utf8(f.base64 || '')), Math.min(budget, 3000));
    ev.returnedFiles[f.name] = text;
    budget -= text.length;
  }
  if (resp?.taskId) {
    try {
      const logs = (await ext('getTaskLlmLogs', { taskId: resp.taskId }))?.logs || [];
      const lines = logs.map(l => `[${l.role || '?'}] ${l.summary || l.userPromptHint || ''}`.trim());
      let traceBudget = 8000;
      const kept = [];
      for (const line of lines.slice(-80).reverse()) {
        const c = clip(line, 300);
        if (traceBudget - c.length < 0) break;
        kept.unshift(c);
        traceBudget -= c.length;
      }
      ev.trace = kept;
      ev.errors.push(...lines.filter(l => /error|fail|timeout|captcha|denied|not found/i.test(l)).slice(-5).map(l => clip(l, 400)));
    } catch (err) {
      ev.errors.push(`(could not read the step trace: ${err.message})`);
    }
  }
  return ev;
}
