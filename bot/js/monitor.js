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
// Purely content-addressed: a node's hash folds in its tag/title/value and the
// recursive hashes of its children. Two nodes anywhere in the tree with the
// same content have the same hash. We track the set of hashes present in the
// previous snapshot; any current node whose hash is in that set is considered
// already-seen and dropped from the diff — regardless of where it sits now.
//
// This makes the diff robust to reorderings, virtualized-list re-renders, and
// DOM-index reshuffling (e.g., Gmail rebuilding its inbox rows when a new
// email arrives no longer looks like "every row is new").
//
// Limitations:
// - Attribute-only changes (class, aria-*, data-*) aren't in the hash, so they
//   won't surface in the diff. Same behavior as before.
// - Duplicate content collapses to one hash — if a page has two identical
//   elements and a third appears, we won't detect the addition. Acceptable for
//   change-detection; not acceptable for precise structural diffing.

function diff(currentDom, previousDom) {
  if (!previousDom) return currentDom;
  if (!currentDom)  return null;

  function calculateHash(node) {
    if (!node) return '';
    if (node.text !== undefined) {
      node.hash = hashString(node.text || '');
      return node.hash;
    }
    const parts = [(node.tag || ''), (node.title || ''), (node.value || '')];
    if (node.children) {
      for (const child of node.children) parts.push(calculateHash(child));
    }
    node.hash = hashString(parts.join('|'));
    return node.hash;
  }

  calculateHash(currentDom);
  calculateHash(previousDom);

  const previousHashes = new Set();
  (function walk(node) {
    if (!node) return;
    if (node.hash !== undefined) previousHashes.add(node.hash);
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
    // Content we've already seen anywhere in prev — not new.
    if (node.hash !== undefined && previousHashes.has(node.hash)) return null;
    // Leaf text with a new hash — emit it.
    if (node.text !== undefined) return cloneNode(node);
    // Element with at least some new content inside — keep walking.
    // (A parent's hash changing doesn't mean every child is new; most children
    // may still match content-wise.)
    const addedChildren = (node.children ?? [])
      .map(buildAddedTree)
      .filter(Boolean);
    if (addedChildren.length === 0) return null;
    return { ...node, children: addedChildren };
  }

  return buildAddedTree(currentDom);
}

// ── Semantic event extraction ─────────────────────────────────────────────────

// Patterns that indicate UI noise rather than real user content
const NOISE_RE = /^(\d{1,2}:\d{2}(:\d{2})?(\s?(am|pm))?$|today|yesterday|just now|edited|\.\.\.|typing\.*)$/i;
const MIN_TEXT_LEN = 20;

/**
 * Walk a diff-subtree and collect meaningful new text as SemanticEvents.
 * @returns {{ text: string, source: string }[]}
 */
function extractSemanticEvents(diffDom, ctx = {}) {
  if (!diffDom) return [];
  const events = [];

  function walk(node) {
    if (!node) return;
    if (node.text !== undefined) {
      const t = (node.text || '').trim();
      if (t.length >= MIN_TEXT_LEN && !NOISE_RE.test(t)) {
        events.push({ text: t, source: ctx.url || '' });
      }
      return;
    }
    for (const child of (node.children ?? [])) walk(child);
  }

  walk(diffDom);
  return events;
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
 * @returns {Promise<Array<{text:string, source:string}>>} semantic events (empty = no trigger)
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

  // Structural diff
  const changed = diff(snap.dom, prev.dom);

  // Always update baseline to the most recent snapshot.
  prevDomStore.set(task.id, { dom: snap.dom, polls });

  if (!changed) return [];

  // Warm-up: the first couple of polls absorb async-loaded content and other
  // settling noise. Real changes fire from poll 3 onward.
  if (polls <= 2) return [];

  // Semantic extraction
  return extractSemanticEvents(changed, { url: snap.url });
}
