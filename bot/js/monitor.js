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

// Per-task continuity is persisted in `task.config.prevDom` (the previous
// condensed-DOM snapshot the next poll diffs against). pollMonitor calls
// putTask after every poll, so any mutation we make here sticks across
// restarts/reboots/sidepanel reloads -- the first post-restart poll diffs
// against the pre-restart baseline and catches whatever changed during
// downtime, instead of silently re-baselining and losing those changes.
// `prevDom` is stripped from the github-sync payload (see taskForSync in
// github-sync.js) since it's large and churns every poll.

function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}

// Fetch a tab's condensed-DOM snapshot. Returns null ONLY when the tab is
// gone (caller can attempt URL-based recovery); throws a descriptive error
// for other failure modes -- including a null/undefined result from the
// fetcher, which shouldn't happen under normal operation.
async function fetchTabSnapshot(tabId, prevDom) {
  let result;
  try {
    result = await extensionCall('fetchWebPage', { tabId, prevDom });
  } catch (err) {
    if (err.code === 'html-page-not-available') return null;
    throw new Error(`Monitor failed to fetch tab ${tabId}: ${err.message}`);
  }
  if (!result) throw new Error(`Monitor: no response from fetchWebPage for tab ${tabId}`);
  return result;
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
  const prevDom = task.config?.prevDom || null;

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
  // Trigger URL-based recovery on tab-gone or wrong-site; a present-but-empty
  // DOM is a transient extraction failure, not a wrong tab -- let it throw.
  if ((!snap || wrongSite) && tabUrl) {
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

  // Carry the snapshot forward for the next poll. Mutating task.config sticks
  // because pollMonitor putTask()s the task after every poll, so prevDom
  // survives across restarts/reboots/sidepanel reloads.
  if (!task.config) task.config = {};
  task.config.prevDom = snap.dom;

  // Warm-up is presence-based, not pollCount-based: skip only when we have no
  // persisted baseline yet (the very first poll of a brand-new monitor -- no
  // diff is possible without a prior snapshot). Every subsequent poll, even
  // the first one after a restart, has a real prevDom and can fire on a diff.
  // This is what avoids silently absorbing replies that arrived while the
  // monitor was down or right after it was created.
  if (!prevDom) return [];

  if (!snap.diff) return [];
  return [{
    text: snap.diff,
    source: snap.url || '',
    diffDom: snap.diffDom || undefined,
  }];
}
