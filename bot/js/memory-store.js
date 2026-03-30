/**
 * Memory store — persistent long-term memory for the bot.
 *
 * Workspace files (localStorage):
 *   SOUL.md    — persona and tone
 *   AGENTS.md  — behavior and guidelines
 *   MEMORY.md  — facts and accumulated knowledge
 *
 * Daily learnings (IndexedDB):
 *   memory/YYYY-MM-DD — auto-appended learnings from task completions
 */

// ── Workspace files (localStorage) ───────────────────────────────────────────

const WORKSPACE_FILES = ['SOUL.md', 'AGENTS.md', 'MEMORY.md'];
const WS_PREFIX = 'runbookai_ws_';
const WS_TS_PREFIX = 'runbookai_ws_ts_';

// Legacy keys for backward compatibility
const LEGACY_MEMORY_MD_KEY = 'runbookai_memory_md';
const LEGACY_MEMORY_MD_TS_KEY = 'runbookai_memory_md_ts';

function wsKey(filename) { return WS_PREFIX + filename; }
function wsTsKey(filename) { return WS_TS_PREFIX + filename; }

/** Load a workspace file. */
export function loadWorkspaceFile(filename) {
  // Migrate legacy MEMORY.md key on first read
  if (filename === 'MEMORY.md') {
    const legacy = localStorage.getItem(LEGACY_MEMORY_MD_KEY);
    if (legacy !== null && localStorage.getItem(wsKey(filename)) === null) {
      localStorage.setItem(wsKey(filename), legacy);
      localStorage.setItem(wsTsKey(filename), localStorage.getItem(LEGACY_MEMORY_MD_TS_KEY) || new Date().toISOString());
      localStorage.removeItem(LEGACY_MEMORY_MD_KEY);
      localStorage.removeItem(LEGACY_MEMORY_MD_TS_KEY);
    }
  }
  return localStorage.getItem(wsKey(filename)) || '';
}

/** Save a workspace file. */
export function saveWorkspaceFile(filename, content) {
  localStorage.setItem(wsKey(filename), content);
  localStorage.setItem(wsTsKey(filename), new Date().toISOString());
}

/** Get timestamp of a workspace file. */
export function getWorkspaceFileTimestamp(filename) {
  // Check legacy key for MEMORY.md migration
  if (filename === 'MEMORY.md' && localStorage.getItem(wsTsKey(filename)) === null) {
    return localStorage.getItem(LEGACY_MEMORY_MD_TS_KEY) || null;
  }
  return localStorage.getItem(wsTsKey(filename)) || null;
}

/** List all workspace file names. */
export function getWorkspaceFileNames() {
  return WORKSPACE_FILES;
}


const DB_NAME = 'runbookai_memory';
const DB_VERSION = 1;
const STORE_NAME = 'daily';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDB().then(db => db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
}

// ── Daily memory (IndexedDB) ─────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Migrate a legacy record (content string) to entries array format.
 * Returns the entries array.
 */
function migrateRecord(record) {
  if (record.entries && Array.isArray(record.entries)) return record.entries;
  if (!record.content) return [];
  // Legacy format: "- item1\n- item2" → ["item1", "item2"]
  return record.content.split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean);
}

/**
 * Append learnings to today's (or a specific date's) memory entry.
 * @param {string[]} newEntries - Array of learning strings
 * @param {string} [date] - YYYY-MM-DD, defaults to today
 */
export async function appendDailyMemory(newEntries, date) {
  if (!newEntries || newEntries.length === 0) return;
  const key = date || todayStr();
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const oldEntries = existing ? migrateRecord(existing) : [];
      const record = {
        date: key,
        entries: [...oldEntries, ...newEntries],
        updatedAt: new Date().toISOString(),
      };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get daily memory entries, newest first.
 * @param {number} [days=7] - How many days back to look
 * @returns {Promise<Array<{date: string, entries: string[], updatedAt: string}>>}
 */
export async function getDailyMemories(days = 7) {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const results = req.result
        .filter(r => r.date >= cutoffStr)
        .map(r => ({ date: r.date, entries: migrateRecord(r), updatedAt: r.updatedAt }))
        .sort((a, b) => b.date.localeCompare(a.date));
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Get ALL daily memory entries (for sync). */
export async function getAllDailyMemories() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      // Normalize all records to entries format
      resolve(req.result.map(r => ({
        date: r.date,
        entries: migrateRecord(r),
        updatedAt: r.updatedAt,
      })));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Put a daily memory record directly (for restore). */
export async function putDailyMemory(record) {
  // Normalize on write
  if (!record.entries && record.content) {
    record.entries = migrateRecord(record);
    delete record.content;
  }
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Clear all daily memories — sets entries to empty array, keeps keys. */
export async function clearDailyMemories() {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result;
      let pending = records.length;
      if (pending === 0) { resolve(); return; }
      for (const record of records) {
        record.entries = [];
        delete record.content;
        record.updatedAt = new Date().toISOString();
        const putReq = store.put(record);
        putReq.onsuccess = () => { if (--pending === 0) resolve(); };
        putReq.onerror = () => reject(putReq.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Context builder (for system prompt injection) ────────────────────────────

const MAX_MEMORY_CHARS = 4000;

/**
 * Build the workspace context to inject into the planner system prompt.
 * Returns { soul, agents, memory } strings. Empty strings if no content.
 */
export async function buildWorkspaceContext() {
  const soul = loadWorkspaceFile('SOUL.md').trim();
  const agents = loadWorkspaceFile('AGENTS.md').trim();

  // Build memory section: MEMORY.md + recent learnings
  const memParts = [];
  let chars = 0;

  const md = loadWorkspaceFile('MEMORY.md').trim();
  if (md) {
    const section = `## MEMORY.md\n${md}`;
    memParts.push(section);
    chars += section.length;
  }

  const memories = await getDailyMemories(7);
  const dailyParts = [];
  for (const m of memories) {
    if (!m.entries || m.entries.length === 0) continue;
    const rendered = m.entries.join('\n---\n');
    const section = `### ${m.date}\n${rendered}`;
    if (chars + section.length + 50 > MAX_MEMORY_CHARS) break;
    dailyParts.push(section);
    chars += section.length;
  }
  if (dailyParts.length > 0) {
    memParts.push(`## Recent Learnings\n${dailyParts.join('\n\n')}`);
  }

  const memory = memParts.length > 0
    ? `\n\n# Long-term Memory\n\n${memParts.join('\n\n')}`
    : '';

  return { soul, agents, memory };
}

