/**
 * IndexedDB-backed persistent task store.
 *
 * Schema (tasks store):
 *   id            - unique task ID (6-char base36)
 *   parentId      - parent task ID if spawned by another task (null for root)
 *   status        - queued | running | waiting | completed | failed | paused
 *   prompt        - the prompt to send to the extension
 *   context       - accumulated memory from prior runs (object)
 *   result        - latest result text from the extension
 *   config        - extension config overrides (object)
 *   schedule      - null (one-shot) | { type: "every", intervalMs } | { type: "cron", expr } | { type: "at", time }
 *   nextRunAt     - epoch ms for next scheduled run (null if not scheduled)
 *   lastRunAt     - epoch ms of last execution (null if never run)
 *   runCount      - number of times this task has been executed
 *   maxRuns       - null (unlimited) | number
 *   consecutiveErrors - number of consecutive failures
 *   lastError     - last error message (null if none)
 *   channelId     - Discord channel to deliver results
 *   replyToId     - original message ID to thread on
 *   delivery      - "announce" | "silent" | "announce-on-change"
 *   createdAt     - epoch ms
 *   updatedAt     - epoch ms
 *   createdBy     - Discord username
 *
 */

const DB_NAME    = 'runbookai_tasks';
const DB_VERSION = 3;
const TASK_STORE = 'tasks';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TASK_STORE)) {
        const store = db.createObjectStore(TASK_STORE, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('nextRunAt', 'nextRunAt', { unique: false });
        store.createIndex('parentId', 'parentId', { unique: false });
      }
      // v3: remove unused messageMap store
      if (db.objectStoreNames.contains('messageMap')) {
        db.deleteObjectStore('messageMap');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then(db => {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  });
}

// ── Task CRUD ──────────────────────────────────────────────────────────────

export function generateId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = '';
  for (const b of bytes) id += chars[b % 36];
  return id;
}

export async function putTask(task) {
  task.updatedAt = Date.now();
  const store = await tx(TASK_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(task);
    req.onsuccess = () => resolve(task);
    req.onerror   = () => reject(req.error);
  });
}

export async function getTask(id) {
  const store = await tx(TASK_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteTask(id) {
  const store = await tx(TASK_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function getAllTasks() {
  const store = await tx(TASK_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Get tasks by status. */
export async function getTasksByStatus(status) {
  const store = await tx(TASK_STORE, 'readonly');
  const index = store.index('status');
  return new Promise((resolve, reject) => {
    const req = index.getAll(status);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Get tasks whose nextRunAt <= now and are in 'waiting' status. */
export async function getDueTasks() {
  const now = Date.now();
  const waiting = await getTasksByStatus('waiting');
  return waiting.filter(t => t.nextRunAt && t.nextRunAt <= now);
}

/** Get child tasks of a given parent. */
export async function getChildTasks(parentId) {
  const store = await tx(TASK_STORE, 'readonly');
  const index = store.index('parentId');
  return new Promise((resolve, reject) => {
    const req = index.getAll(parentId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Create a new task with defaults. */
export function createTaskRecord(overrides = {}) {
  const now = Date.now();
  return {
    id:                generateId(),
    parentId:          null,
    status:            'queued',
    prompt:            '',
    context:           {},
    result:            null,
    files:             {},
    config:            {},
    schedule:          null,
    nextRunAt:         null,
    lastRunAt:         null,
    runCount:          0,
    maxRuns:           null,
    consecutiveErrors: 0,
    lastError:         null,
    channelId:         null,
    replyToId:         null,
    delivery:          'announce',
    createdAt:         now,
    updatedAt:         now,
    createdBy:         null,
    ...overrides,
  };
}


