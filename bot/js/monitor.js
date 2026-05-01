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
    .replace(/"/g, '&quot;');
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
// Walks `cur` and `prev` in parallel and emits prefixed lines (' ', '+', '-'):
//
// - cur === null, prev exists       → entire prev subtree removed (-).
// - prev === null, cur exists       → entire cur subtree added (+).
// - both texts equal                → ' ' (one line).
// - both texts differ               → '-' old / '+' new.
// - both elements, fullHash equal   → ' ' for the whole collapsed subtree.
// - both elements, selfHash equal   → opening/closing as ' ' (the tag itself
//                                     is unchanged), recurse into children
//                                     pairwise so only changed kids get +/-.
// - both elements, selfHash differs → tag identity itself changed; emit prev
//                                     subtree as '-' and cur subtree as '+'.
//
// Children alignment: for each cur child, prefer a not-yet-paired prev child
// with the same fullHash (perfect match), else one with the same selfHash
// (structural match). Unpaired cur children → added; unpaired prev children →
// removed.

function emitAll(node, prefix, indent, out) {
  for (const line of prettyPrint(node, indent)) out.push(prefix + line);
}

// Returns true if it pushed any output (so callers can drop empty wrappers).
function emitUnified(cur, prev, indent, out) {
  if (!cur && !prev) return false;
  if (!prev) { emitAll(cur, '+', indent, out); return true; }
  if (!cur)  { emitAll(prev, '-', indent, out); return true; }

  // Text leaves
  if (cur.text !== undefined && prev.text !== undefined) {
    if (cur.text === prev.text) return false; // skip unchanged text — no context
    out.push('-' + indent + escapeHtml(prev.text));
    out.push('+' + indent + escapeHtml(cur.text));
    return true;
  }
  // Mismatched leaf vs element
  if (cur.text !== undefined || prev.text !== undefined) {
    emitAll(prev, '-', indent, out);
    emitAll(cur, '+', indent, out);
    return true;
  }

  // Identical subtree — skip entirely (no context spam).
  if (cur.hash === prev.hash) return false;

  // Same tag identity, children differ — emit open/close as context only if a
  // descendant actually changes. Tentatively push the open tag and roll back
  // if children emit nothing.
  if (cur.selfHash === prev.selfHash) {
    const tag = cur.tag || 'div';
    const start = out.length;
    out.push(' ' + indent + openTag(cur) + '>');
    if (cur.value && tag === 'textarea') out.push(' ' + indent + '  ' + escapeHtml(cur.value));
    const headerLen = out.length - start;
    diffChildren(cur.children ?? [], prev.children ?? [], indent + '  ', out);
    if (out.length === start + headerLen) {
      out.length = start; // no real changes inside — roll back
      return false;
    }
    out.push(' ' + indent + `</${tag}>`);
    return true;
  }

  // Tag identity itself differs — treat the whole pair as remove + add.
  emitAll(prev, '-', indent, out);
  emitAll(cur, '+', indent, out);
  return true;
}

function diffChildren(curKids, prevKids, indent, out) {
  // Index prev by fullHash and selfHash for O(1) lookup; track which slots
  // have been paired so each prev child is matched at most once.
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

  // Two-phase selfHash matching to handle reordered items correctly.
  // Phase 1: match items that have child-hash overlap (confident matches).
  // Phase 2: match remaining items by first-available (no preference).
  // This prevents a new item (no overlap with any prev) from stealing
  // a slot that a reordered existing item would have matched better.
  function scoreSelfHashMatch(curChild, prevIdx) {
    const curChildHashes = new Set(
      (curChild.children ?? []).map(c => c.hash).filter(Boolean));
    let score = 0;
    for (const pc of (prevKids[prevIdx].children ?? [])) {
      if (pc.hash && curChildHashes.has(pc.hash)) score++;
    }
    return score;
  }

  // Phase 1: fullHash exact matches
  const paired = new Array(curKids.length).fill(-1);
  for (let ci = 0; ci < curKids.length; ci++) {
    const c = curKids[ci];
    if (c.hash !== undefined) {
      const i = take(prevByFull, c.hash);
      if (i >= 0) paired[ci] = i;
    }
  }

  // Phase 2: selfHash matches — confident first (score > 0), then leftovers
  const needsSelfMatch = [];
  for (let ci = 0; ci < curKids.length; ci++) {
    if (paired[ci] >= 0) continue;
    const c = curKids[ci];
    if (c.selfHash === undefined) continue;
    const list = prevBySelf.get(c.selfHash);
    if (!list) continue;
    const candidates = list.filter(i => !used.has(i));
    if (candidates.length === 0) continue;
    // Find best scoring candidate
    let bestIdx = -1, bestScore = -1;
    for (const i of candidates) {
      const score = scoreSelfHashMatch(c, i);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    needsSelfMatch.push({ ci, bestIdx, bestScore });
  }
  // Sort by score descending — confident matches first
  needsSelfMatch.sort((a, b) => b.bestScore - a.bestScore);
  for (const { ci, bestIdx, bestScore } of needsSelfMatch) {
    if (used.has(bestIdx)) {
      // Best candidate was taken — find next available
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

  // Emit results
  for (let ci = 0; ci < curKids.length; ci++) {
    if (paired[ci] >= 0) emitUnified(curKids[ci], prevKids[paired[ci]], indent, out);
    else                 emitAll(curKids[ci], '+', indent, out);
  }
  for (let i = 0; i < prevKids.length; i++) {
    if (!used.has(i)) emitAll(prevKids[i], '-', indent, out);
  }
}

export function unifiedDiff(cur, prev) {
  if (!prev) return cur ? prettyPrint(cur).map(l => '+' + l).join('\n') : '';
  if (!cur)  return prettyPrint(prev).map(l => '-' + l).join('\n');
  calculateHashes(cur);
  calculateHashes(prev);
  if (cur.hash === prev.hash) return '';
  const out = [];
  emitUnified(cur, prev, '', out);
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
