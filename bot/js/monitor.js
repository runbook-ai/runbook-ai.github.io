/**
 * monitor.js — DOM-diff polling for monitor-type tasks.
 *
 * Exports:
 *   runMonitorPoll(task)  — one poll cycle; returns SemanticEvent[]
 */

import { extensionCall } from './extension.js';

// ── Hash (sync djb2, adapted from extension/util.js) ─────────────────────────

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash & hash; // keep 32-bit
  }
  return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
}

// ── DOM diff ─────────────────────────────────────────────────────────────────
// Purely content-addressed, with two hashes per node:
//   - fullHash: folds in tag/title/value + recursive child hashes (identifies
//     the entire subtree).
//   - selfHash: folds in tag/title/value only (identifies the node's own
//     identity, independent of children).
//
// A node is emitted in the "new" side if its fullHash is not present anywhere
// in the prior snapshot. If no children survive but its selfHash is also not
// in prior — e.g., a <tr>'s aria-label flipped from "unread, …" to "me, …"
// with children unchanged — emit the node as a shell (no children) so
// title/value-only changes still surface.
//
// Symmetric use: call diff(current, previous) for additions, or
// diff(previous, current) for removals. The monitor uses both to produce a
// git-diff-style view.
//
// Limitations:
// - Attribute-only changes (class, aria-*, data-* other than title/value) are
//   not in either hash, so they won't surface in the diff.
// - Duplicate content collapses to one hash — if a page has two identical
//   elements and a third appears, we won't detect the addition. Acceptable for
//   change-detection; not acceptable for precise structural diffing.

function diff(currentDom, previousDom) {
  if (!previousDom) return currentDom;
  if (!currentDom)  return null;

  function calculateHashes(node) {
    if (!node) return;
    if (node.text !== undefined) {
      node.hash = hashString(node.text || '');
      node.selfHash = node.hash;
      return;
    }
    node.selfHash = hashString([node.tag || '', node.title || '', node.value || ''].join('|'));
    const parts = [node.selfHash];
    for (const child of (node.children ?? [])) {
      calculateHashes(child);
      parts.push(child.hash);
    }
    node.hash = hashString(parts.join('|'));
  }

  calculateHashes(currentDom);
  calculateHashes(previousDom);

  const prevFull = new Set();
  const prevSelf = new Set();
  (function walk(node) {
    if (!node) return;
    if (node.hash !== undefined) prevFull.add(node.hash);
    if (node.selfHash !== undefined) prevSelf.add(node.selfHash);
    for (const child of (node.children ?? [])) walk(child);
  })(previousDom);

  function cloneNode(node) {
    if (!node) return null;
    if (node.text !== undefined) return { text: node.text };
    const c = { ...node };
    c.children = (node.children ?? []).map(cloneNode).filter(Boolean);
    return c;
  }

  function buildAddedTree(node) {
    if (!node) return null;
    if (node.hash !== undefined && prevFull.has(node.hash)) return null;
    if (node.text !== undefined) return cloneNode(node);
    const addedChildren = (node.children ?? []).map(buildAddedTree).filter(Boolean);
    if (addedChildren.length > 0) return { ...node, children: addedChildren };
    // No child changed, but this node's own identity (tag/title/value) is new
    // vs anywhere in prev — emit a shell so title/value-only changes surface.
    if (!prevSelf.has(node.selfHash)) return { ...node, children: [] };
    return null;
  }

  return buildAddedTree(currentDom);
}

// ── Pretty-print: one tag/text per line, indented ────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openTag(node) {
  const tag = node.tag || 'div';
  let open = `<${tag}`;
  if (node.title) open += ` title="${escapeHtml(node.title)}"`;
  if (node.value && tag !== 'textarea') open += ` value="${escapeHtml(node.value)}"`;
  for (const attr in (node.attributes || {})) {
    if (attr === 'id') continue; // native ids are noise (random, change across renders)
    const v = node.attributes[attr];
    if (v && v !== 'false' && String(v).trim()) {
      open += ` ${attr}="${escapeHtml(v)}"`;
    }
  }
  return open;
}

// Render a node into a list of indented lines. One tag or text per line so the
// output can be fed to a line-level LCS diff. Empty elements collapse to a
// single line (`<tag></tag>`).
function prettyPrint(node, indent = '', out = []) {
  if (!node) return out;
  if (node.text !== undefined) {
    out.push(indent + escapeHtml(node.text));
    return out;
  }
  const tag = node.tag || 'div';
  const open = openTag(node);
  const kids = node.children ?? [];
  const hasTextareaValue = node.value && tag === 'textarea';
  if (kids.length === 0 && !hasTextareaValue) {
    out.push(`${indent}${open}></${tag}>`);
    return out;
  }
  out.push(`${indent}${open}>`);
  if (hasTextareaValue) out.push(indent + '  ' + escapeHtml(node.value));
  for (const c of kids) prettyPrint(c, indent + '  ', out);
  out.push(`${indent}</${tag}>`);
  return out;
}

// Standard LCS-based unified line diff. Inputs are line arrays; output is a
// newline-joined string with leading ' ', '-', or '+' on each line.
function lineDiff(a, b) {
  const m = a.length, n = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : (dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i++]); }
    else { out.push('+' + b[j++]); }
  }
  while (i < m) out.push('-' + a[i++]);
  while (j < n) out.push('+' + b[j++]);
  return out.join('\n');
}

// ── In-memory DOM baseline store ─────────────────────────────────────────────
// prevDom is NOT persisted — too large. First poll after reload re-baselines silently.

const prevDomStore = new Map(); // taskId → { dom }

// ── Main poll function ────────────────────────────────────────────────────────

/**
 * Run one monitor poll cycle.
 *
 * Reads:  task.config.tabId           — Chrome tab ID
 *         task.config.responseTemplate — used upstream in task-manager
 *
 * @returns {Promise<Array<{text:string, source:string}>>} one-entry array with
 *   HTML-rendered diff subtree (empty = no trigger)
 */
export async function runMonitorPoll(task) {
  const tabId = task.config?.tabId ?? 0;

  let snap;
  try {
    snap = await extensionCall('fetchWebPage', { tabId });
  } catch (err) {
    if (err.code === 'html-page-not-available') {
      throw new Error(`Monitor tab ${tabId} is no longer available (closed or navigated away)`);
    }
    throw new Error(`Monitor failed to fetch tab ${tabId}: ${err.message}`);
  }

  if (!snap) {
    throw new Error(`Monitor: no response from fetchWebPage for tab ${tabId}`);
  }

  if (!snap.dom) {
    throw new Error(`Monitor: no DOM returned for tab ${tabId}`);
  }

  const prev = prevDomStore.get(task.id);

  if (!prev) {
    // First poll — establish baseline, no trigger
    prevDomStore.set(task.id, { dom: snap.dom, polls: 1 });
    return [];
  }

  const polls = (prev.polls ?? 1) + 1;

  // Symmetric structural diff: pruned subtrees of what's removed and what's
  // added. LCS-line-diff over their pretty-prints yields a unified, git-style
  // view that aligns shared ancestors and tags only the truly-changed lines.
  const added   = diff(snap.dom, prev.dom);
  const removed = diff(prev.dom, snap.dom);

  // Always update baseline to the most recent snapshot.
  prevDomStore.set(task.id, { dom: snap.dom, polls });

  if (!added && !removed) return [];

  // Warm-up: the first couple of polls absorb async-loaded content and other
  // settling noise. Real changes fire from poll 3 onward.
  if (polls <= 2) return [];

  const removedLines = removed ? prettyPrint(removed) : [];
  const addedLines   = added   ? prettyPrint(added)   : [];
  if (removedLines.length === 0 && addedLines.length === 0) return [];

  const unified = lineDiff(removedLines, addedLines);
  return [{ text: unified, source: snap.url || '' }];
}
