/**
 * Memory store — persistent long-term memory for the bot.
 *
 * Two tiers:
 *   MEMORY.md   — user-editable global context (localStorage)
 *   memory/YYYY-MM-DD — daily auto-appended learnings (IndexedDB)
 */

const MEMORY_MD_KEY = 'runbookai_memory_md';
const MEMORY_MD_TS_KEY = 'runbookai_memory_md_ts';
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

// ── MEMORY.md (localStorage) ─────────────────────────────────────────────────

export function loadMemoryMd() {
  return localStorage.getItem(MEMORY_MD_KEY) || '';
}

export function saveMemoryMd(content) {
  localStorage.setItem(MEMORY_MD_KEY, content);
  localStorage.setItem(MEMORY_MD_TS_KEY, new Date().toISOString());
}

export function getMemoryMdTimestamp() {
  return localStorage.getItem(MEMORY_MD_TS_KEY) || null;
}

// ── Daily memory (IndexedDB) ─────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append learnings to today's (or a specific date's) memory entry.
 * @param {string[]} entries - Array of learning strings
 * @param {string} [date] - YYYY-MM-DD, defaults to today
 */
export async function appendDailyMemory(entries, date) {
  if (!entries || entries.length === 0) return;
  const key = date || todayStr();
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const oldContent = existing?.content || '';
      const newLines = entries.map(e => `- ${e}`).join('\n');
      const content = oldContent ? `${oldContent}\n${newLines}` : newLines;
      const record = {
        date: key,
        content,
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
 * @returns {Promise<Array<{date: string, content: string, updatedAt: string}>>}
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Put a daily memory record directly (for restore). */
export async function putDailyMemory(record) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Clear all daily memories — sets content to empty string, keeps keys. */
export async function clearDailyMemories() {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result;
      let pending = records.length;
      if (pending === 0) { resolve(); return; }
      for (const record of records) {
        record.content = '';
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
 * Build the memory context string to inject into the planner system prompt.
 * Returns empty string if no memory content exists.
 */
export async function buildMemoryContext() {
  const parts = [];
  let chars = 0;

  // MEMORY.md
  const md = loadMemoryMd().trim();
  if (md) {
    const section = `## MEMORY.md\n${md}`;
    parts.push(section);
    chars += section.length;
  }

  // Recent daily learnings
  const memories = await getDailyMemories(7);
  const dailyParts = [];
  for (const m of memories) {
    if (!m.content.trim()) continue;
    const section = `### ${m.date}\n${m.content}`;
    if (chars + section.length + 50 > MAX_MEMORY_CHARS) break;
    dailyParts.push(section);
    chars += section.length;
  }
  if (dailyParts.length > 0) {
    parts.push(`## Recent Learnings\n${dailyParts.join('\n\n')}`);
  }

  if (parts.length === 0) return '';
  return `\n\n# Long-term Memory\n\n${parts.join('\n\n')}`;
}
