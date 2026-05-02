/**
 * monitor.js — DOM-diff polling for monitor-type tasks.
 *
 * Exports:
 *   runMonitorPoll(task)  — one poll cycle; returns SemanticEvent[]
 */

import { extensionCall as defaultExtensionCall } from './extension.js';

// Pluggable action runner, same pattern as planner.js. Bot page uses the
// default (chrome.runtime.sendMessage → extension). The extension sidepanel
// registers a direct in-process runner via task-host.js so poll calls don't
// round-trip back through the extension's external-message dispatcher (which
// returns `unknown-action` for `fetchWebPage`).
let runAction = defaultExtensionCall;
export function setActionRunner(fn) { runAction = fn || defaultExtensionCall; }
const extensionCall = (action, args) => runAction(action, args);

// ── Hash (sync djb2, adapted from extension/util.js) ─────────────────────────

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash & hash; // keep 32-bit
  }
  return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
}

// ── Hashes ──────────────────────────────────────────────────────────────────
// Each node carries two hashes:
//   - hash:     folds in tag/title/value + recursive child hashes (the whole
//               subtree's identity).
//   - selfHash: folds in tag/title/value only (the node's own identity, no
//               children). Used to align a node across snapshots when its
//               children have changed but it's "the same node."
//
// Limitations:
// - Styling/bookkeeping attribute changes (class, style, data-*, id) are not
//   in either hash, so they won't surface in the diff. This is intentional —
//   they churn on hover/animation/theme and would create false fires.
// - Two siblings with identical content collapse to one hash, so their order
//   isn't distinguishable to the matcher.

// Attributes folded into selfHash because they carry semantic identity, not
// styling. A change here means the node's "what" changed (link target, image
// source, form-control state) even when its visible text didn't.
const SEMANTIC_ATTRS = [
  'href', 'src', 'alt', 'aria-label', 'role',
  'name', 'type', 'placeholder',
  'checked', 'selected', 'disabled',
];

function calculateHashes(node) {
  if (!node) return;
  if (node.text !== undefined) {
    node.hash = hashString(node.text || '');
    node.selfHash = node.hash;
    return;
  }
  const attrs = node.attributes || {};
  const attrParts = SEMANTIC_ATTRS.map(a => `${a}=${attrs[a] ?? ''}`);
  node.selfHash = hashString([node.tag || '', node.title || '', node.value || '', ...attrParts].join('|'));
  const parts = [node.selfHash];
  for (const child of (node.children ?? [])) {
    calculateHashes(child);
    parts.push(child.hash);
  }
  node.hash = hashString(parts.join('|'));
}

// ── Pretty-print helpers ─────────────────────────────────────────────────────

function frameIndexToPrefix(frameIndex) {
  if (frameIndex < 0) return '';
  let prefix = '';
  let index = frameIndex;
  do {
    prefix = String.fromCharCode(97 + (index % 26)) + prefix;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return prefix;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function openTag(node) {
  const tag = node.tag || 'div';
  let open = `<${tag}`;
  if (node.index !== undefined) {
    const prefix = frameIndexToPrefix(node.frameIndex ?? 0);
    open += ` id="${prefix}${node.index}"`;
  }
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

// Render an entire subtree into indented lines (no diff prefixes). One tag or
// text per line; empty elements collapse to `<tag></tag>` on a single line.
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

// ── Tree-aware unified diff ──────────────────────────────────────────────────
// Two phases:
//   1. buildDiff(cur, prev) → DiffNode tree (or null if nothing changed).
//   2. renderDiff(node) → prefixed lines (' ', '+', '-').
//
// Splitting the phases lets us add context-line expansion later without
// touching the matching logic.
//
// DiffNode kinds:
//   { kind: 'added',    node }            — cur subtree (entire '+').
//   { kind: 'removed',  node }            — prev subtree (entire '-').
//   { kind: 'replace',  prev, cur }       — selfHash mismatch or leaf-vs-element;
//                                           render whole prev '-' then whole cur '+'.
//   { kind: 'wrapper',  node, children }  — same selfHash, descendants changed;
//                                           render open/close as ' ' context with
//                                           children diffs in between. `node` is
//                                           cur (carries open tag + textarea value).
//
// Identical subtrees and identical text leaves return null (no DiffNode), and
// a wrapper whose children all return null also collapses to null — same as
// the old "tentative push + rollback" behavior.
//
// Children alignment inside a wrapper (two-phase, order-proof):
//   Phase 1: pair every cur child with a prev child sharing fullHash (perfect
//            match — identical subtree).
//   Phase 2: for each unpaired cur child with a selfHash bucket in prev, score
//            each available candidate by descendant-hash overlap (depth 20,
//            memoized). Commit the highest-scoring pair first; if its best
//            candidate was taken by an earlier commit, fall back to the next
//            available index in prev order.
//
// Why two-phase: when several prev siblings share a selfHash (e.g. a list of
// items with the same tag), a naive first-available matcher mis-pairs across
// reorders. Confident-first prevents a brand-new item (no descendant overlap
// with anything) from stealing a slot that a reordered existing item would
// have matched on shared sub-elements (avatars, names, channel labels).
//
// Unpaired cur → 'added' in cur order. Unpaired prev → 'removed' appended at
// the end of the children list in prev order, matching the old emission order.

function emitAll(node, prefix, indent, out) {
  for (const line of prettyPrint(node, indent)) out.push(prefix + line);
}

function buildDiff(cur, prev) {
  if (!cur && !prev) return null;
  if (!prev) return { kind: 'added', node: cur };
  if (!cur)  return { kind: 'removed', node: prev };

  // Identical text leaves collapse silently. Anything else where at least one
  // side is a text leaf — including two text leaves with different content —
  // falls through to 'replace', which renders them as whole '-' / '+' lines.
  if (cur.text !== undefined && prev.text !== undefined && cur.text === prev.text) return null;
  if (cur.text !== undefined || prev.text !== undefined) {
    return { kind: 'replace', prev, cur };
  }

  if (cur.hash === prev.hash) return null;

  if (cur.selfHash === prev.selfHash) {
    const children = buildDiffChildren(cur.children ?? [], prev.children ?? []);
    if (children.length === 0) return null; // no real changes inside — drop wrapper
    return { kind: 'wrapper', node: cur, children };
  }

  return { kind: 'replace', prev, cur };
}

function buildDiffChildren(curKids, prevKids) {
  // Index prev by fullHash and selfHash for O(1) lookup.
  const prevByFull = new Map();
  const prevBySelf = new Map();
  for (let i = 0; i < prevKids.length; i++) {
    const k = prevKids[i];
    if (k.hash !== undefined) {
      if (!prevByFull.has(k.hash)) prevByFull.set(k.hash, []);
      prevByFull.get(k.hash).push(i);
    }
    if (k.selfHash !== undefined) {
      if (!prevBySelf.has(k.selfHash)) prevBySelf.set(k.selfHash, []);
      prevBySelf.get(k.selfHash).push(i);
    }
  }
  const used = new Set();
  function take(map, key) {
    const list = map.get(key);
    if (!list) return -1;
    for (const i of list) if (!used.has(i)) { used.add(i); return i; }
    return -1;
  }

  // Memoized descendant-hash collection for overlap scoring. Deeper than direct
  // children so list items whose wrapper-divs all hash uniquely still find
  // overlap on sub-elements (avatar, name, channel). Depth 20 is empirically
  // sufficient for Slack/Gmail-style nested rows.
  const _hashCache = new Map();
  function collectDescendantHashes(node, depth) {
    if (!node) return new Set();
    const cached = _hashCache.get(node);
    if (cached) return cached;
    const results = new Set();
    if (node.hash) results.add(node.hash);
    if (depth > 0) {
      for (const c of (node.children || [])) {
        for (const h of collectDescendantHashes(c, depth - 1)) {
          results.add(h);
        }
      }
    }
    _hashCache.set(node, results);
    return results;
  }

  function scoreSelfHashMatch(curChild, prevIdx) {
    const curHashes = collectDescendantHashes(curChild, 20);
    let score = 0;
    const prevHashes = collectDescendantHashes(prevKids[prevIdx], 20);
    for (const h of prevHashes) {
      if (curHashes.has(h)) score++;
    }
    return score;
  }

  // Phase 1: fullHash exact matches.
  const paired = new Array(curKids.length).fill(-1);
  for (let ci = 0; ci < curKids.length; ci++) {
    const c = curKids[ci];
    if (c.hash !== undefined) {
      const i = take(prevByFull, c.hash);
      if (i >= 0) paired[ci] = i;
    }
  }

  // Phase 2: selfHash matches — score-best first, then fall back to next
  // available if the best candidate was already taken by an earlier commit.
  const needsSelfMatch = [];
  for (let ci = 0; ci < curKids.length; ci++) {
    if (paired[ci] >= 0) continue;
    const c = curKids[ci];
    if (c.selfHash === undefined) continue;
    const list = prevBySelf.get(c.selfHash);
    if (!list) continue;
    const candidates = list.filter(i => !used.has(i));
    if (candidates.length === 0) continue;
    let bestIdx = -1, bestScore = -1;
    for (const i of candidates) {
      const score = scoreSelfHashMatch(c, i);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    needsSelfMatch.push({ ci, bestIdx, bestScore });
  }
  needsSelfMatch.sort((a, b) => b.bestScore - a.bestScore);
  for (const { ci, bestIdx } of needsSelfMatch) {
    if (used.has(bestIdx)) {
      const c = curKids[ci];
      const list = prevBySelf.get(c.selfHash);
      if (list) {
        for (const i of list) {
          if (!used.has(i)) { used.add(i); paired[ci] = i; break; }
        }
      }
    } else {
      used.add(bestIdx);
      paired[ci] = bestIdx;
    }
  }

  // Build DiffNodes: paired cur children in cur order, then unpaired prev
  // tail in prev order. Skips paired children that recurse to null (identical).
  const out = [];
  for (let ci = 0; ci < curKids.length; ci++) {
    if (paired[ci] >= 0) {
      const dn = buildDiff(curKids[ci], prevKids[paired[ci]]);
      if (dn) out.push(dn);
    } else {
      out.push({ kind: 'added', node: curKids[ci] });
    }
  }
  for (let i = 0; i < prevKids.length; i++) {
    if (!used.has(i)) out.push({ kind: 'removed', node: prevKids[i] });
  }
  return out;
}

function renderDiff(dn, indent, out) {
  switch (dn.kind) {
    case 'added':
      emitAll(dn.node, '+', indent, out);
      return;
    case 'removed':
      emitAll(dn.node, '-', indent, out);
      return;
    case 'replace':
      emitAll(dn.prev, '-', indent, out);
      emitAll(dn.cur, '+', indent, out);
      return;
    case 'wrapper': {
      const node = dn.node;
      const tag = node.tag || 'div';
      out.push(' ' + indent + openTag(node) + '>');
      if (node.value && tag === 'textarea') {
        out.push(' ' + indent + '  ' + escapeHtml(node.value));
      }
      for (const c of dn.children) renderDiff(c, indent + '  ', out);
      out.push(' ' + indent + `</${tag}>`);
      return;
    }
  }
}

export function unifiedDiff(cur, prev) {
  if (!prev) return cur ? prettyPrint(cur).map(l => '+' + l).join('\n') : '';
  if (!cur)  return prettyPrint(prev).map(l => '-' + l).join('\n');
  calculateHashes(cur);
  calculateHashes(prev);
  if (cur.hash === prev.hash) return '';
  const dn = buildDiff(cur, prev);
  if (!dn) return '';
  const out = [];
  renderDiff(dn, '', out);
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
 *   the unified-diff payload (empty = no trigger)
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
    // First poll — establish baseline, no trigger.
    prevDomStore.set(task.id, { dom: snap.dom, polls: 1 });
    return [];
  }

  const polls = (prev.polls ?? 1) + 1;
  const unified = unifiedDiff(snap.dom, prev.dom);

  // Always update baseline to the most recent snapshot.
  prevDomStore.set(task.id, { dom: snap.dom, polls });

  if (!unified) return [];

  // Warm-up: the first couple of polls absorb async-loaded content and other
  // settling noise. Real changes fire from poll 3 onward.
  if (polls <= 2) return [];

  return [{ text: unified, source: snap.url || '' }];
}
