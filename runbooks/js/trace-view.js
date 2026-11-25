// "How it ran": renders a runbook's trace.json (the redacted successful run
// saved by the Runbook AI extension) for runbooks shared without a demo.gif.
// Format: auto-chrome docs/runbooks-page-overhaul-design.md §5.4 / §7.3.

import { h } from './dom.js';

function pills(text, params) {
  const label = Object.fromEntries((params || []).map(p => [p.name, p.label || p.name]));
  const out = [];
  const s = String(text || '');
  let last = 0;
  for (const m of s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(h('span.trace-pill', label[m[1]] || m[1]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function duration(sec) {
  if (!sec) return '';
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function traceSites(trace) {
  const seen = [];
  for (const s of trace?.steps || []) for (const site of s.sites || []) if (!seen.includes(site)) seen.push(site);
  return seen;
}

export function traceHeadline(trace) {
  const steps = trace?.steps?.length || 0;
  const sites = traceSites(trace).length;
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  if (sites) parts.push(`${sites} site${sites === 1 ? '' : 's'}`);
  const d = duration(trace?.stats?.elapsedSec);
  if (d) parts.push(d);
  if (trace?.recordedAt) {
    const date = new Date(trace.recordedAt);
    if (!Number.isNaN(date.getTime())) parts.push(`recorded ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`);
  }
  return parts.join(' · ');
}

/** The full trace, for the Run view's left column. */
export function traceView(trace, params) {
  const list = h('ol.trace-steps');
  const steps = trace?.steps || [];
  // Consecutive steps with the same tool and label collapse to "×N".
  for (let i = 0; i < steps.length;) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].tool === steps[i].tool && steps[j + 1].label === steps[i].label) j++;
    const s = steps[i];
    const li = h('li.trace-step' + (s.ok === false ? '.failed' : ''),
      h('div.trace-line',
        h('span.trace-mark', { title: s.ok === false ? (s.error || 'failed') : 'ok' }, s.ok === false ? '↻' : '✓'),
        h('span.trace-label', ...pills(s.label, params), j > i ? h('span.trace-times', ` ×${j - i + 1}`) : null)));
    if (s.sites?.length) li.append(h('div.trace-sites', s.sites.join(' · ')));
    if (s.actions?.length) {
      const retried = s.actions.filter(a => a.ok === false).length;
      li.append(h('details.trace-actions',
        h('summary', `${s.actions.length} action${s.actions.length === 1 ? '' : 's'}${retried ? ` (${retried} retried)` : ''}`),
        h('ul', s.actions.map(a => h('li' + (a.ok === false ? '.failed' : ''),
          a.ok === false ? '↻ ' : '', ...pills(a.text, params),
          a.typed ? h('span', ' — ', ...pills(a.typed, params)) : null,
          a.url ? h('div.trace-url', ...pills(a.url, params)) : null)))));
    }
    list.append(li);
    i = j + 1;
  }
  return h('div.trace-card',
    h('div.trace-head', h('span.trace-title', 'How it ran'), h('span.trace-meta', traceHeadline(trace))),
    list,
    h('p.trace-fine', 'Recorded by the Runbook AI extension: the sites visited and what the agent did. No page contents or screenshots.'));
}

/** Gallery thumbnail for a runbook with a trace and no GIF. */
export function traceThumb(trace) {
  const sites = traceSites(trace);
  return h('div.trace-thumb',
    h('div.trace-thumb-sites', sites.length ? sites.slice(0, 4).join(' → ') : 'Runbook'),
    h('div.trace-thumb-steps', `${trace?.steps?.length || 0} steps`));
}
