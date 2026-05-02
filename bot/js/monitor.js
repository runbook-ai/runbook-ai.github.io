/**
 * monitor.js — DOM-diff polling for monitor-type tasks.
 *
 * Each poll calls fetchWebPage, passing the previous condensed-DOM snapshot
 * back to the content script. The content script (extension/dom.js +
 * dom-diff.js) computes a `diff` snippet and returns it alongside the new
 * snapshot. We carry the snapshot per task so polling state survives content-
 * script reloads (page navigation, tab discard) — the diff is hash-based and
 * doesn't care who held the prior tree.
 *
 * Exports:
 *   runMonitorPoll(task)  — one poll cycle; returns SemanticEvent[]
 *   setActionRunner(fn)   — override the chrome.runtime call (for tests + in-
 *                            extension polling that bypasses the external
 *                            message dispatcher)
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

// Per-task continuity. Map from task.id → previous condensed DOM (from the
// last successful poll). The map survives bot-page lifetime; on bot-page
// reload it resets and the next poll re-baselines naturally.
//
// Not persisted: trees are KB-scale and the cost of re-baselining once after
// a reload is exactly one missed-trigger window. The data is also coupled to
// the in-memory poll counter, so persisting one without the other would be
// wrong anyway.
const prevDomByTask = new Map();
// Per-task warm-up counter. Two polls of "no diff returned" are absorbed
// before we report changes upstream — covers async-loaded content and the
// first true diff (which compares against a freshly baselined snapshot).
const pollCountByTask = new Map();

/**
 * Run one monitor poll cycle.
 *
 * Reads:  task.config.tabId           — Chrome tab ID
 *         task.config.responseTemplate — used upstream in task-manager
 *
 * @returns {Promise<Array<{text:string, source:string}>>} one-entry array with
 *   the diff snippet (empty array = no trigger)
 */
export async function runMonitorPoll(task) {
  const tabId = task.config?.tabId ?? 0;
  const prevDom = prevDomByTask.get(task.id) || null;

  let snap;
  try {
    snap = await extensionCall('fetchWebPage', { tabId, prevDom });
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

  // Carry the snapshot forward for the next poll.
  prevDomByTask.set(task.id, snap.dom);

  const polls = (pollCountByTask.get(task.id) ?? 0) + 1;
  pollCountByTask.set(task.id, polls);

  // Warm-up: absorb the first two polls. Poll #1 has no prevDom (no diff
  // possible). Poll #2 compares against a tree that may still be settling
  // (async images, lazy-rendered widgets). Real triggers fire from poll #3.
  if (polls <= 2) return [];

  if (!snap.diff) return [];
  return [{ text: snap.diff, source: snap.url || '' }];
}
