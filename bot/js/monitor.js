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

function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}

// Fetch a tab's condensed-DOM snapshot. Returns null when the tab is gone so
// the caller can attempt URL-based recovery; rethrows unexpected fetch errors.
async function fetchTabSnapshot(tabId, prevDom) {
  try {
    return await extensionCall('fetchWebPage', { tabId, prevDom });
  } catch (err) {
    if (err.code === 'html-page-not-available') return null;
    throw new Error(`Monitor failed to fetch tab ${tabId}: ${err.message}`);
  }
}

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
  let tabId = task.config?.tabId ?? 0;
  const tabUrl = task.config?.tabUrl;
  const wantOrigin = originOf(tabUrl);
  const prevDom = prevDomByTask.get(task.id) || null;

  // Try the bound tab id FIRST. Reusing it keeps the monitor pinned to one
  // specific tab across polls -- important when several tabs share the URL --
  // and avoids a tab lookup on the happy path.
  let snap = await fetchTabSnapshot(tabId, prevDom);

  // Recover by URL only when the bound tab is gone, or when tab-id reuse has
  // landed us on a different site. Chrome tab ids are not stable: they are
  // reused across browser restarts and reassigned on tab close/reopen, so a
  // stale config.tabId can point at nothing (poll fails, monitor dies) or at an
  // unrelated page. Re-resolve from the stored tabUrl, persist the new id
  // (pollMonitor saves the task after every poll), and re-fetch the right tab.
  const wrongSite = snap && snap.url && wantOrigin && originOf(snap.url) !== wantOrigin;
  if ((!snap || !snap.dom || wrongSite) && tabUrl) {
    let found = null;
    try { found = await extensionCall('findTabByUrl', { url: tabUrl }); } catch {}
    if (found && found.tabId && found.tabId !== tabId) {
      tabId = found.tabId;
      if (task.config) task.config.tabId = tabId;
      snap = await fetchTabSnapshot(tabId, prevDom);
    }
  }

  if (!snap) {
    throw new Error(`Monitor tab ${tabId} is no longer available (closed or navigated away)`);
  }
  if (!snap.dom) {
    throw new Error(`Monitor: no DOM returned for tab ${tabId}`);
  }

  // Carry the snapshot forward for the next poll.
  prevDomByTask.set(task.id, snap.dom);

  const polls = (pollCountByTask.get(task.id) ?? 0) + 1;
  pollCountByTask.set(task.id, polls);

  // Warm-up: absorb only the first poll, which has no prevDom (no diff is
  // possible). Real triggers fire from poll #2 onward. We deliberately do NOT
  // also skip poll #2: a 2-poll warm-up means anything that appears between
  // poll #1 (baseline) and poll #2 gets folded into the baseline and is never
  // reported -- e.g. an email reply arriving right after the monitor starts is
  // silently missed. The settling risk (lazy images between poll #1 and #2) is
  // minor for the content monitors watch (inboxes, notifications, dashboards).
  if (polls <= 1) return [];

  if (!snap.diff) return [];
  return [{
    text: snap.diff,
    source: snap.url || '',
    diffDom: snap.diffDom || undefined,
  }];
}
