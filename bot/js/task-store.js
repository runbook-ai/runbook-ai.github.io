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
 *   nextRunAt     - ISO 8601 string for next scheduled run (null if not scheduled)
 *   lastRunAt     - ISO 8601 string of last execution (null if never run)
 *   runCount      - number of times this task has been executed
 *   maxRuns       - null (unlimited) | number
 *   consecutiveErrors - number of consecutive failures
 *   lastError     - last error message (null if none)
 *   channelId     - Discord channel to deliver results
 *   replyToId     - original message ID to thread on
 *   delivery      - "announce" | "silent" | "announce-on-change"
 *   createdAt     - ISO 8601 string
 *   updatedAt     - ISO 8601 string (auto-set by putTask)
 *   createdBy     - Discord username
 *
 */

const DB_NAME    = 'runbookai_tasks';
const DB_VERSION = 5;
const TASK_STORE = 'tasks';
const RUN_STORE  = 'task-runs';
const LLM_LOG_STORE = 'llm-logs';

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
      // v4: migrate epoch ms timestamps → ISO 8601 strings
      if (event.oldVersion < 4) {
        const store = req.transaction.objectStore(TASK_STORE);
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const task = cursor.value;
          let changed = false;
          for (const field of ['createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt']) {
            if (typeof task[field] === 'number') {
              task[field] = new Date(task[field]).toISOString();
              changed = true;
            }
          }
          if (changed) cursor.update(task);
          cursor.continue();
        };
      }
      // v5: add task-runs and llm-logs stores
      if (!db.objectStoreNames.contains(RUN_STORE)) {
        const runStore = db.createObjectStore(RUN_STORE, { keyPath: 'id' });
        runStore.createIndex('taskId', 'taskId', { unique: false });
        runStore.createIndex('completedAt', 'completedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(LLM_LOG_STORE)) {
        const logStore = db.createObjectStore(LLM_LOG_STORE, { keyPath: 'id' });
        logStore.createIndex('taskId', 'taskId', { unique: false });
        logStore.createIndex('timestamp', 'timestamp', { unique: false });
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

// Test-only: close the cached DB connection and clear the singleton so the
// next openDB() call reopens. Lets unit tests delete the database between
// cases without the prior connection blocking the delete request.
export async function _closeForTesting() {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

// ── Task CRUD ──────────────────────────────────────────────────────────────

export function generateId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = '';
  for (const b of bytes) id += chars[b % 36];
  return id;
}

export async function putTask(task, { skipTimestamp = false, skipSync = false } = {}) {
  if (!skipTimestamp) task.updatedAt = new Date().toISOString();
  const store = await tx(TASK_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(task);
    req.onsuccess = () => {
      if (!skipSync) {
        import('./github-sync.js').then(m => {
          if (m.isSyncEnabled()) m.pushTaskDebounced(task);
        }).catch(() => {});
      }
      resolve(task);
    };
    req.onerror = () => reject(req.error);
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

// No sync hook on delete — deleted tasks are kept in GitHub as archive
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
  return waiting.filter(t => t.nextRunAt && new Date(t.nextRunAt).getTime() <= now);
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
  const now = new Date().toISOString();
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

// ── Task Runs (local history) ─────────────────────────────────────────────

export async function putRun(run) {
  const store = await tx(RUN_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(run);
    req.onsuccess = () => resolve(run);
    req.onerror = () => reject(req.error);
  });
}

export async function getRun(id) {
  const store = await tx(RUN_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function makeTimestampRange(since, until) {
  if (since != null && until != null) return IDBKeyRange.bound(since, until);
  if (since != null) return IDBKeyRange.lowerBound(since);
  if (until != null) return IDBKeyRange.upperBound(until);
  return null;
}

function filterByTimestampField(items, field, since, until) {
  if (since == null && until == null) return items;
  return items.filter(item => {
    const t = item[field];
    if (since != null && t < since) return false;
    if (until != null && t > until) return false;
    return true;
  });
}

export async function getRunsByTaskId(taskId, { since, until } = {}) {
  const store = await tx(RUN_STORE, 'readonly');
  if (taskId == null) {
    const index = store.index('completedAt');
    const range = makeTimestampRange(since, until);
    return new Promise((resolve, reject) => {
      const req = range ? index.getAll(range) : store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const index = store.index('taskId');
  const runs = await new Promise((resolve, reject) => {
    const req = index.getAll(taskId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return filterByTimestampField(runs, 'completedAt', since, until);
}

export async function deleteRun(id) {
  const store = await tx(RUN_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRunsOlderThan(isoDate) {
  const store = await tx(RUN_STORE, 'readwrite');
  const index = store.index('completedAt');
  const range = IDBKeyRange.upperBound(isoDate);
  return new Promise((resolve, reject) => {
    let count = 0;
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(count); return; }
      cursor.delete();
      count++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ── LLM Logs (local history) ──────────────────────────────────────────────

export async function putLlmLog(entry) {
  const store = await tx(LLM_LOG_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error);
  });
}

export async function getLlmLog(id) {
  const store = await tx(LLM_LOG_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getLlmLogsByTaskId(taskId, { since, until } = {}) {
  const store = await tx(LLM_LOG_STORE, 'readonly');
  if (taskId == null) {
    const index = store.index('timestamp');
    const range = makeTimestampRange(since, until);
    return new Promise((resolve, reject) => {
      const req = range ? index.getAll(range) : store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const index = store.index('taskId');
  const logs = await new Promise((resolve, reject) => {
    const req = index.getAll(taskId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return filterByTimestampField(logs, 'timestamp', since, until);
}

export async function deleteLlmLog(id) {
  const store = await tx(LLM_LOG_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLlmLogsOlderThan(isoDate) {
  const store = await tx(LLM_LOG_STORE, 'readwrite');
  const index = store.index('timestamp');
  const range = IDBKeyRange.upperBound(isoDate);
  return new Promise((resolve, reject) => {
    let count = 0;
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(count); return; }
      cursor.delete();
      count++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
