/**
 * File store — persistent file storage for the bot planner.
 *
 * IndexedDB-backed store for text and binary files.
 * Files are synced to GitHub alongside tasks and memory.
 *
 * Record schema:
 *   path      — unique file path (e.g. "reports/daily.md")
 *   content   — file content (string for text, base64 for binary)
 *   encoding  — 'utf8' (default) or 'base64'
 *   mimeType  — MIME type (e.g. "text/plain", "image/png")
 *   size      — content size in bytes
 *   updatedAt — ISO 8601 timestamp
 */

const DB_NAME = 'runbookai_files';
const DB_VERSION = 1;
const STORE_NAME = 'files';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'path' });
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

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Read a file by path. Returns the record or null.
 */
export async function readFile(path) {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(path);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Write a file. Creates or overwrites.
 */
export async function writeFile(path, content, { mimeType = 'text/plain', encoding = 'utf8' } = {}) {
  const size = encoding === 'base64'
    ? Math.round(content.length * 3 / 4)
    : new Blob([content]).size;
  const record = {
    path,
    content,
    encoding,
    mimeType,
    size,
    updatedAt: new Date().toISOString(),
  };
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => {
      // Trigger point-wise sync
      import('./github-sync.js').then(m => {
        if (m.isSyncEnabled()) m.pushFileDebounced(record);
      }).catch(() => {});
      resolve(record);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a file by path. Returns true if existed.
 */
export async function deleteFile(path) {
  const existing = await readFile(path);
  if (!existing) return false;
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(path);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List files, optionally filtered by path prefix.
 * Returns array of { path, mimeType, encoding, size, updatedAt } (no content).
 */
export async function listFiles(prefix = '') {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const results = req.result
        .filter(r => !prefix || r.path.startsWith(prefix))
        .map(r => ({
          path: r.path,
          mimeType: r.mimeType,
          encoding: r.encoding || 'utf8',
          size: r.size,
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get file metadata without loading content.
 * Returns { path, mimeType, encoding, size, updatedAt } or null.
 */
export async function fileInfo(path) {
  const record = await readFile(path);
  if (!record) return null;
  return {
    path: record.path,
    mimeType: record.mimeType,
    encoding: record.encoding || 'utf8',
    size: record.size,
    updatedAt: record.updatedAt,
  };
}

/**
 * Search file contents for a query string or regex.
 * Skips binary files (encoding: 'base64').
 * Returns { matches: [{ path, lines: [{ lineNum, text }] }], totalMatches }
 */
export async function grepFiles(query, { prefix = '', maxResults = 10 } = {}) {
  const store = await tx('readonly');
  const all = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Build regex from query
  let regex;
  if (query.startsWith('/') && query.lastIndexOf('/') > 0) {
    const lastSlash = query.lastIndexOf('/');
    const pattern = query.slice(1, lastSlash);
    const flags = query.slice(lastSlash + 1) || 'i';
    try { regex = new RegExp(pattern, flags); } catch { regex = null; }
  }
  if (!regex) {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const matches = [];
  let totalMatches = 0;

  for (const record of all) {
    if (prefix && !record.path.startsWith(prefix)) continue;
    if (record.encoding === 'base64') continue;
    if (!record.content) continue;

    const lines = record.content.split('\n');
    const matchingLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchingLines.push({ lineNum: i + 1, text: lines[i].slice(0, 200) });
      }
    }
    if (matchingLines.length > 0) {
      totalMatches += matchingLines.length;
      matches.push({ path: record.path, lines: matchingLines.slice(0, 5) });
      if (matches.length >= maxResults) break;
    }
  }

  return { matches, totalMatches };
}

// ── Sync helpers ─────────────────────────────────────────────────────────────

/** Get ALL files (for bulk sync). */
export async function getAllFiles() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Put a file record directly (for restore). */
export async function putFile(record) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
