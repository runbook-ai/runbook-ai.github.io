/**
 * GitHub Sync — push/pull tasks to a GitHub repo as plain JSON files.
 *
 * Repo layout:
 *   tasks/<createdAt>-<id>.json   one file per task
 *
 * Uses the GitHub Contents API for point-wise writes and the
 * Git Trees API for bulk sync (single commit regardless of task count).
 */

import { getGitHubSync } from './settings.js';
import { getAllTasks, putTask } from './task-store.js';
import {
  loadWorkspaceFile, saveWorkspaceFile, getWorkspaceFileTimestamp,
  getWorkspaceFileNames,
  getAllDailyMemories, putDailyMemory,
} from './memory-store.js';
import { getAllFiles, putFile } from './file-store.js';

// ── State ────────────────────────────────────────────────────────────────────

const shaCache = new Map();       // taskId → { sha, filename }
const fileShaCache = new Map();   // filePath → { sha, filename }
const pendingSync = new Map();    // taskId → debounce timer
const pendingFileSync = new Map(); // filePath → debounce timer
let bulkSyncTimer = null;

const BULK_SYNC_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const DEBOUNCE_MS = 300;
const API = 'https://api.github.com';

// ── Config helpers ───────────────────────────────────────────────────────────

function cfg() {
  const gs = getGitHubSync();
  // Parse "owner/repo" format
  const [owner, repo] = (gs.repo || '').split('/');
  return { ...gs, owner, repo: repo || '' };
}

export function isSyncEnabled() {
  const gs = getGitHubSync();
  return gs.enabled && gs.autoSyncOnWrite && !!gs.pat && !!gs.repo;
}

// ── Filename helpers ─────────────────────────────────────────────────────────

function taskFilename(task) {
  const ts = (task.createdAt || new Date().toISOString()).replace(/:/g, '-');
  return `tasks/${ts}-${task.id}.json`;
}

function parseTaskFilename(filename) {
  // tasks/2024-03-25T00-00-00.000Z-a1b2c3.json       (new 6-char base36)
  // tasks/2024-03-25T00-00-00.000Z-task_762119fa-557.json (old task_uuid format)
  const m = filename.match(/^tasks\/\d{4}-\d{2}-\d{2}T[\d-]+\.[\d]+Z-(.+)\.json$/);
  if (!m) return null;
  return { id: m[1] };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function headers() {
  const { pat } = cfg();
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function githubGet(path) {
  const { owner, repo } = cfg();
  const res = await fetch(`${API}/repos/${owner}/${repo}/${path}`, { headers: headers() });
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function githubPut(path, body) {
  const { owner, repo } = cfg();
  const res = await fetch(`${API}/repos/${owner}/${repo}/${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function githubPost(path, body) {
  const { owner, repo } = cfg();
  const res = await fetch(`${API}/repos/${owner}/${repo}/${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub POST ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function githubPatch(path, body) {
  const { owner, repo } = cfg();
  const res = await fetch(`${API}/repos/${owner}/${repo}/${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PATCH ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ── Point-wise sync ──────────────────────────────────────────────────────────

export async function pushTask(task) {
  const filename = taskFilename(task);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(task, null, 2))));
  const { branch } = cfg();

  // Get SHA from cache or fetch it
  let sha = null;
  const cached = shaCache.get(task.id);
  if (cached) {
    sha = cached.sha;
  } else {
    const existing = await githubGet(`contents/${filename}?ref=${branch}`);
    if (existing) sha = existing.sha;
  }

  try {
    const result = await githubPut(`contents/${filename}`, {
      message: `sync task ${task.id}`,
      content,
      sha: sha || undefined,
      branch,
    });
    // Update cache with new SHA
    shaCache.set(task.id, { sha: result.content.sha, filename });
    return result;
  } catch (err) {
    // On 409 conflict, invalidate cache and retry once
    if (err.message.includes('409')) {
      shaCache.delete(task.id);
      const existing = await githubGet(`contents/${filename}?ref=${branch}`);
      const retrySha = existing?.sha;
      const result = await githubPut(`contents/${filename}`, {
        message: `sync task ${task.id}`,
        content,
        sha: retrySha || undefined,
        branch,
      });
      shaCache.set(task.id, { sha: result.content.sha, filename });
      return result;
    }
    throw err;
  }
}

export function pushTaskDebounced(task) {
  if (pendingSync.has(task.id)) clearTimeout(pendingSync.get(task.id));
  pendingSync.set(task.id, setTimeout(() => {
    pendingSync.delete(task.id);
    pushTask(task).catch(err => console.warn('[github-sync] push failed:', err.message));
  }, DEBOUNCE_MS));
}

// ── File sync ─────────────────────────────────────────────────────────────────

function fileGithubPath(record) {
  // Use path segments directly — both Contents API and Trees API treat / as directories
  // Only encode individual segments to handle spaces and special chars
  const segments = record.path.split('/').map(s => encodeURIComponent(s));
  return `files/${segments.join('/')}.json`;
}

async function pushFile(record) {
  const filename = fileGithubPath(record);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(record))));
  const { branch } = cfg();
  let sha = fileShaCache.get(record.path)?.sha || null;
  if (!sha) {
    const existing = await githubGet(`contents/${filename}?ref=${branch}`);
    if (existing) sha = existing.sha;
  }
  try {
    const result = await githubPut(`contents/${filename}`, {
      message: `sync file ${record.path}`,
      content, sha: sha || undefined, branch,
    });
    fileShaCache.set(record.path, { sha: result.content.sha, filename });
    return result;
  } catch (err) {
    if (err.message.includes('409')) {
      fileShaCache.delete(record.path);
      const existing = await githubGet(`contents/${filename}?ref=${branch}`);
      const result = await githubPut(`contents/${filename}`, {
        message: `sync file ${record.path}`,
        content, sha: existing?.sha || undefined, branch,
      });
      fileShaCache.set(record.path, { sha: result.content.sha, filename });
      return result;
    }
    throw err;
  }
}

export function pushFileDebounced(record) {
  if (pendingFileSync.has(record.path)) clearTimeout(pendingFileSync.get(record.path));
  pendingFileSync.set(record.path, setTimeout(() => {
    pendingFileSync.delete(record.path);
    pushFile(record).catch(err => console.warn('[github-sync] file push failed:', err.message));
  }, DEBOUNCE_MS));
}

// ── Bulk sync (Git Trees API) ────────────────────────────────────────────────

export async function bulkSync() {
  const { branch } = cfg();
  const tasks = await getAllTasks();

  // Build tree entries — create blobs first to avoid the ~40 KB inline content limit
  const tree = [];
  for (const task of tasks) {
    const content = JSON.stringify(task, null, 2);
    const blob = await githubPost('git/blobs', {
      content: btoa(unescape(encodeURIComponent(content))),
      encoding: 'base64',
    });
    tree.push({
      path: taskFilename(task),
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }

  // Add workspace files (SOUL.md, AGENTS.md, MEMORY.md) — only if locally saved
  for (const name of getWorkspaceFileNames()) {
    const ts = getWorkspaceFileTimestamp(name);
    if (!ts) continue; // never saved locally — don't push empty files
    const content = loadWorkspaceFile(name);
    const json = JSON.stringify({ content, updatedAt: ts });
    const blob = await githubPost('git/blobs', {
      content: btoa(unescape(encodeURIComponent(json))),
      encoding: 'base64',
    });
    tree.push({ path: `workspace/${name}.json`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Add daily memory files
  const dailyMemories = await getAllDailyMemories();
  for (const mem of dailyMemories) {
    const blob = await githubPost('git/blobs', {
      content: btoa(unescape(encodeURIComponent(JSON.stringify(mem)))),
      encoding: 'base64',
    });
    tree.push({ path: `memory/${mem.date}.json`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Add persistent files
  const allFiles = await getAllFiles();
  for (const file of allFiles) {
    const blob = await githubPost('git/blobs', {
      content: btoa(unescape(encodeURIComponent(JSON.stringify(file)))),
      encoding: 'base64',
    });
    tree.push({ path: fileGithubPath(file), mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Check if repo has any commits
  const ref = await githubGet(`git/ref/heads/${branch}`);

  let newTree, newCommit;

  if (!ref) {
    // Empty repo — bootstrap with Contents API (creates first commit implicitly)
    for (const task of tasks) {
      const filename = taskFilename(task);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(task, null, 2))));
      const result = await githubPut(`contents/${filename}`, {
        message: `sync task ${task.id}`,
        content,
        branch,
      });
      shaCache.set(task.id, { sha: result.content.sha, filename });
    }
    // Also bootstrap workspace + memory + file store files
    for (const entry of tree.filter(e => e.path.startsWith('workspace/') || e.path.startsWith('memory/') || e.path.startsWith('files/'))) {
      const blobData = await githubGet(`git/blobs/${entry.sha}`);
      await githubPut(`contents/${entry.path}`, {
        message: `sync ${entry.path}`,
        content: blobData.content,
        branch,
      });
    }
    return { count: tasks.length };
  } else {
    // Existing repo — build on top of current tree
    const commitSha = ref.object.sha;
    const commit = await githubGet(`git/commits/${commitSha}`);
    const baseTreeSha = commit.tree.sha;

    newTree = await githubPost('git/trees', { base_tree: baseTreeSha, tree });

    // Skip commit if tree is unchanged (no actual changes)
    if (newTree.sha === baseTreeSha) {
      return { count: tasks.length, skipped: true };
    }

    // Re-fetch latest commit as parent (point-wise syncs may have advanced the branch)
    const latestRef = await githubGet(`git/ref/heads/${branch}`);
    const parentSha = latestRef?.object?.sha || commitSha;

    newCommit = await githubPost('git/commits', {
      message: `bulk sync ${tasks.length} tasks + memory`,
      tree: newTree.sha,
      parents: [parentSha],
    });
    await githubPatch(`git/refs/heads/${branch}`, { sha: newCommit.sha, force: true });
  }

  // 6. Populate SHA cache from tree
  for (const entry of newTree.tree) {
    const parsed = parseTaskFilename(entry.path);
    if (parsed) {
      shaCache.set(parsed.id, { sha: entry.sha, filename: entry.path });
    }
  }

  return { count: tasks.length };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restore() {
  const { branch } = cfg();

  // 1. Get full tree
  const ref = await githubGet(`git/ref/heads/${branch}`);
  if (!ref) throw new Error(`Branch "${branch}" not found`);
  const tree = await githubGet(`git/trees/${ref.object.sha}?recursive=1`);

  const taskBlobs = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith('tasks/'));
  const wsBlobs = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith('workspace/'));
  const memoryBlobs = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith('memory/'));
  const fileBlobs = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith('files/'));

  const TASK_MAX_AGE_MS = 14 * 24 * 3_600_000; // 14 days — same as cron cleanup
  const now = Date.now();
  let restored = 0;
  let skipped = 0;

  // Restore tasks
  for (const blob of taskBlobs) {
    const parsed = parseTaskFilename(blob.path);
    if (!parsed) continue;

    // Fetch blob content
    const blobData = await githubGet(`git/blobs/${blob.sha}`);
    const json = decodeURIComponent(escape(atob(blobData.content)));
    const remoteTask = JSON.parse(json);

    // Skip tasks older than TTL
    const taskTime = new Date(remoteTask.lastRunAt || remoteTask.updatedAt || remoteTask.createdAt || 0).getTime();
    if (now - taskTime > TASK_MAX_AGE_MS) {
      skipped++;
      continue;
    }

    // Check local task
    const { getTask } = await import('./task-store.js');
    const localTask = await getTask(remoteTask.id);

    if (localTask && localTask.updatedAt >= remoteTask.updatedAt) {
      skipped++;
    } else {
      await putTask(remoteTask, { skipTimestamp: true, skipSync: true });
      restored++;
    }

    // Cache SHA
    shaCache.set(remoteTask.id, { sha: blob.sha, filename: blob.path });
  }

  // Restore workspace files (SOUL.md, AGENTS.md, MEMORY.md)
  for (const blob of wsBlobs) {
    const blobData = await githubGet(`git/blobs/${blob.sha}`);
    const json = decodeURIComponent(escape(atob(blobData.content)));
    const remote = JSON.parse(json);
    // Extract filename: workspace/SOUL.md.json → SOUL.md
    const name = blob.path.replace('workspace/', '').replace('.json', '');
    const localTs = getWorkspaceFileTimestamp(name);
    if (!localTs || (remote.updatedAt && remote.updatedAt > localTs)) {
      saveWorkspaceFile(name, remote.content || '');
      restored++;
    } else {
      skipped++;
    }
  }

  // Restore daily memory files
  for (const blob of memoryBlobs) {
    if (!blob.path.match(/^memory\/\d{4}-\d{2}-\d{2}\.json$/)) continue;
    const blobData = await githubGet(`git/blobs/${blob.sha}`);
    const json = decodeURIComponent(escape(atob(blobData.content)));
    const remote = JSON.parse(json);
    const memDate = new Date(remote.date + 'T00:00:00Z').getTime();
    if (now - memDate > TASK_MAX_AGE_MS) {
      skipped++;
      continue;
    }
    await putDailyMemory(remote);
    restored++;
  }

  // Restore persistent files (no TTL — files persist until deleted)
  for (const blob of fileBlobs) {
    const blobData = await githubGet(`git/blobs/${blob.sha}`);
    const json = decodeURIComponent(escape(atob(blobData.content)));
    const remote = JSON.parse(json);
    const { readFile: readLocalFile } = await import('./file-store.js');
    const local = await readLocalFile(remote.path);
    if (local && local.updatedAt >= remote.updatedAt) {
      skipped++;
    } else {
      await putFile(remote);
      restored++;
    }
  }

  return { restored, skipped };
}

// ── Test connection ──────────────────────────────────────────────────────────

export async function testConnection() {
  const { owner, repo, pat } = cfg();
  if (!pat) throw new Error('No PAT configured');
  if (!owner || !repo) throw new Error('No repository configured');
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers() });
  if (res.status === 401) throw new Error('Invalid PAT');
  if (res.status === 404) throw new Error('Repository not found');
  if (!res.ok) throw new Error(`GitHub error: ${res.status}`);
  return true;
}

// ── Bulk sync timer ──────────────────────────────────────────────────────────

export function startBulkSyncTimer() {
  if (bulkSyncTimer) return;
  // Do NOT fire immediately — first bulk sync happens after the interval
  bulkSyncTimer = setInterval(() => {
    bulkSync().catch(err => console.warn('[github-sync] bulk sync failed:', err.message));
  }, BULK_SYNC_INTERVAL);
  console.log('[github-sync] bulk sync timer started (every 2h)');
}

export function stopBulkSyncTimer() {
  if (bulkSyncTimer) {
    clearInterval(bulkSyncTimer);
    bulkSyncTimer = null;
    console.log('[github-sync] bulk sync timer stopped');
  }
}
