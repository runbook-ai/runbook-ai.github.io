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

// ── DOM diff (sync, adapted from extension/dom.js) ───────────────────────────
// calculateHash is made synchronous — no crypto API, pure djb2.

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

  function getNodeKey(node, ancestorKey) {
    if (!node) return null;
    if (node.index !== undefined && node.frameIndex !== undefined) {
      return `${node.index}:${node.frameIndex}`;
    }
    if (node.hash !== undefined) return `${ancestorKey}_${node.hash}`;
    return null;
  }

  calculateHash(currentDom);
  calculateHash(previousDom);

  function buildKeyMap(node, map = new Map(), ancestorKey = 'root') {
    if (!node) return map;
    const key = getNodeKey(node, ancestorKey);
    if (key) map.set(key, node);
    const childAncestorKey = (node.index !== undefined && node.frameIndex !== undefined)
      ? `${node.index}:${node.frameIndex}` : ancestorKey;
    for (const child of (node.children ?? [])) buildKeyMap(child, map, childAncestorKey);
    return map;
  }

  const previousMap = buildKeyMap(previousDom);

  function cloneNode(node) {
    if (!node) return null;
    if (node.text !== undefined) return { text: node.text };
    const c = { ...node };
    c.children = (node.children ?? []).map(cloneNode).filter(Boolean);
    return c;
  }

  function buildAddedTree(node, ancestorKey = 'root') {
    if (!node) return null;
    const key = getNodeKey(node, ancestorKey);
    if (!key) return null;
    const prev = previousMap.get(key);
    if (!prev) return cloneNode(node);           // entirely new subtree
    if (prev.hash === node.hash) return null;    // unchanged
    // Changed node — recurse into children to find what's new
    const childAncestorKey = (node.index !== undefined && node.frameIndex !== undefined)
      ? `${node.index}:${node.frameIndex}` : ancestorKey;
    const addedChildren = (node.children ?? [])
      .map(child => buildAddedTree(child, childAncestorKey))
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
    prevDomStore.set(task.id, { dom: snap.dom });
    return [];
  }

  // Structural diff
  const changed = diff(snap.dom, prev.dom);

  // Update baseline
  prevDomStore.set(task.id, { dom: snap.dom });

  if (!changed) return [];

  // Semantic extraction
  return extractSemanticEvents(changed, { url: snap.url });
}
