// Local runbooks in localStorage. Pure (storage is injectable) so Node tests
// can run it against a fake.
//
// Shape (key runbookai.local.v1):
//   { "<slug>": { manifest, prompt, extraFiles, origin, reviewed, version,
//                 createdAt, updatedAt, versions: [{version, at, manifest, prompt, note}] } }

import { normalizeManifest, validateRunbook, SLUG_RE } from './runbook-format.js';

export const STORE_KEY = 'runbookai.local.v1';
export const MAX_VERSIONS = 10;

export function createStore(storage = safeLocalStorage()) {
  let available = !!storage;

  function readAll() {
    if (!storage) return {};
    try {
      const raw = storage.getItem(STORE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      available = false;
      return {};
    }
  }

  function writeAll(all) {
    if (!storage) return { error: 'storage-unavailable', message: "This browser isn't letting the page save. Export to keep your runbook." };
    try {
      storage.setItem(STORE_KEY, JSON.stringify(all));
      available = true;
      return { ok: true };
    } catch (err) {
      available = false;
      const quota = /quota/i.test(String(err && (err.name || err.message)));
      return quota
        ? { error: 'quota-exceeded', message: 'Browser storage is full. Export and delete some runbooks.' }
        : { error: 'storage-unavailable', message: "This browser isn't letting the page save. Export to keep your runbook." };
    }
  }

  function list() {
    const all = readAll();
    return Object.entries(all)
      .map(([slug, r]) => ({ slug, ...r }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function get(slug) {
    const r = readAll()[slug];
    return r ? { slug, ...r } : null;
  }

  function has(slug) { return !!readAll()[slug]; }

  function uniqueSlug(base) {
    const all = readAll();
    if (!all[base]) return base;
    for (let i = 2; i < 1000; i++) {
      const s = `${base.slice(0, 60)}-${i}`;
      if (!all[s]) return s;
    }
    return `${base.slice(0, 50)}-${Date.now()}`;
  }

  /**
   * Create or update. When updating, the previous content goes into
   * versions[] (capped). `note` describes the change ("designer: ...").
   * Returns { ok, runbook } or { error, message, errors? }.
   */
  function save(slug, { manifest, prompt, extraFiles, origin, reviewed } = {}, note = '') {
    if (!SLUG_RE.test(String(slug || ''))) return { error: 'bad-slug', message: `Invalid slug "${slug}".` };
    const { errors } = validateRunbook({ slug, manifest, prompt });
    if (errors.length) return { error: 'invalid-runbook', message: errors[0], errors };
    const all = readAll();
    const now = new Date().toISOString();
    const prev = all[slug];
    const normalized = normalizeManifest(manifest);
    let rec;
    if (prev) {
      const unchanged = JSON.stringify(prev.manifest) === JSON.stringify(normalized) && prev.prompt === prompt;
      const versions = Array.isArray(prev.versions) ? prev.versions.slice() : [];
      if (!unchanged) {
        versions.push({ version: prev.version || 1, at: prev.updatedAt || now, manifest: prev.manifest, prompt: prev.prompt, note: prev.note || '' });
        while (versions.length > MAX_VERSIONS) versions.shift();
      }
      rec = {
        ...prev,
        manifest: normalized,
        prompt,
        extraFiles: extraFiles !== undefined ? extraFiles : (prev.extraFiles || {}),
        origin: origin || prev.origin,
        reviewed: reviewed !== undefined ? reviewed : prev.reviewed,
        version: unchanged ? (prev.version || 1) : (prev.version || 1) + 1,
        note: unchanged ? prev.note : note,
        updatedAt: unchanged ? prev.updatedAt : now,
        versions,
      };
    } else {
      rec = {
        manifest: normalized,
        prompt,
        extraFiles: extraFiles || {},
        origin: origin || { kind: 'designer' },
        reviewed: reviewed !== undefined ? reviewed : true,
        version: 1,
        note,
        createdAt: now,
        updatedAt: now,
        versions: [],
      };
    }
    all[slug] = rec;
    const w = writeAll(all);
    if (w.error) return w;
    return { ok: true, runbook: { slug, ...rec } };
  }

  function update(slug, fields) {
    const all = readAll();
    if (!all[slug]) return { error: 'not-found', message: `No local runbook "${slug}".` };
    all[slug] = { ...all[slug], ...fields };
    const w = writeAll(all);
    return w.error ? w : { ok: true, runbook: { slug, ...all[slug] } };
  }

  /** Restore an earlier version (as a new version, so it can be undone). */
  function restore(slug, version) {
    const cur = get(slug);
    if (!cur) return { error: 'not-found', message: `No local runbook "${slug}".` };
    const v = (cur.versions || []).find(x => x.version === version);
    if (!v) return { error: 'version-not-found', message: `No version ${version}.` };
    return save(slug, { manifest: v.manifest, prompt: v.prompt }, `restored v${version}`);
  }

  function remove(slug) {
    const all = readAll();
    if (!all[slug]) return { ok: true };
    delete all[slug];
    return writeAll(all);
  }

  return { list, get, has, save, update, restore, remove, uniqueSlug, isAvailable: () => available && !!storage };
}

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const k = '__runbookai_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

/** sessionStorage JSON helpers (designer conversation, last run evidence). */
export const session = {
  get(key, fallback = null) {
    try { const v = globalThis.sessionStorage?.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { globalThis.sessionStorage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { globalThis.sessionStorage?.removeItem(key); } catch { /* ignore */ }
  },
};

/** localStorage preference helpers (remembered tab, free-key checkbox). */
export const prefs = {
  get(key, fallback = null) {
    try { const v = globalThis.localStorage?.getItem('runbookai.pref.' + key); return v === null || v === undefined ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { globalThis.localStorage?.setItem('runbookai.pref.' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
