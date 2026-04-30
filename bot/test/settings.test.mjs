/**
 * Tests for settings.js — localStorage-backed settings persistence.
 *
 * settings.js touches localStorage on every call (load and save). We install
 * an in-memory localStorage stub before importing, so each test sees a clean
 * store via the helper resetStore().
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage stub.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};
const resetStore = () => store.clear();

const { loadSettings, saveSettings, getGitHubSync, saveGitHubSync, getAllowedUsers } =
  await import('../js/settings.js');

const STORAGE_KEY = 'runbookai_discord_agent_v1';

// ── loadSettings / saveSettings ─────────────────────────────────────────────

test('loadSettings returns {} when storage is empty', () => {
  resetStore();
  assert.deepEqual(loadSettings(), {});
});

test('loadSettings returns {} on malformed JSON instead of throwing', () => {
  resetStore();
  store.set(STORAGE_KEY, '{not valid json');
  assert.deepEqual(loadSettings(), {});
});

test('saveSettings then loadSettings round-trips an object', () => {
  resetStore();
  saveSettings({ botToken: 'abc', allowedUsers: ['Alice', 'BOB'], freeApiKey: true });
  assert.deepEqual(loadSettings(), { botToken: 'abc', allowedUsers: ['Alice', 'BOB'], freeApiKey: true });
});

test('saveSettings overwrites the prior object (no merge)', () => {
  resetStore();
  saveSettings({ botToken: 'one', allowedUsers: ['x'] });
  saveSettings({ botToken: 'two' });
  assert.deepEqual(loadSettings(), { botToken: 'two' });
});

// ── getGitHubSync ───────────────────────────────────────────────────────────

test('getGitHubSync returns defaults when unset', () => {
  resetStore();
  assert.deepEqual(getGitHubSync(), {
    enabled: false,
    pat: '',
    repo: '',
    branch: 'main',
    autoSyncOnWrite: true,
    autoBulkSync: true,
  });
});

test('getGitHubSync returns the persisted object when present', () => {
  resetStore();
  saveSettings({ githubSync: { enabled: true, pat: 'tok', repo: 'a/b', branch: 'main', autoSyncOnWrite: false, autoBulkSync: true } });
  assert.deepEqual(getGitHubSync(), { enabled: true, pat: 'tok', repo: 'a/b', branch: 'main', autoSyncOnWrite: false, autoBulkSync: true });
});

// ── saveGitHubSync ──────────────────────────────────────────────────────────

test('saveGitHubSync merges into existing settings without dropping siblings', () => {
  resetStore();
  saveSettings({ botToken: 'KEEP_ME', allowedUsers: ['x'] });
  saveGitHubSync({ enabled: true, pat: 'p', repo: 'a/b' });
  const after = loadSettings();
  assert.equal(after.botToken, 'KEEP_ME');
  assert.deepEqual(after.allowedUsers, ['x']);
  assert.equal(after.githubSync.enabled, true);
  assert.equal(after.githubSync.pat, 'p');
  // Defaults filled in for unspecified fields
  assert.equal(after.githubSync.branch, 'main');
  assert.equal(after.githubSync.autoSyncOnWrite, true);
});

test('saveGitHubSync partial update preserves prior github fields', () => {
  resetStore();
  saveGitHubSync({ enabled: true, pat: 'p1', repo: 'a/b' });
  saveGitHubSync({ pat: 'p2' });
  const gs = getGitHubSync();
  assert.equal(gs.pat, 'p2');
  assert.equal(gs.repo, 'a/b'); // preserved
  assert.equal(gs.enabled, true); // preserved
});

// ── getAllowedUsers ─────────────────────────────────────────────────────────

test('getAllowedUsers returns empty Set when unset', () => {
  resetStore();
  const s = getAllowedUsers();
  assert.ok(s instanceof Set);
  assert.equal(s.size, 0);
});

test('getAllowedUsers lowercases entries', () => {
  resetStore();
  saveSettings({ allowedUsers: ['Alice', 'BOB', 'cHaRlIe'] });
  const s = getAllowedUsers();
  assert.deepEqual([...s].sort(), ['alice', 'bob', 'charlie']);
});

test('getAllowedUsers returns a Set (deduplicates)', () => {
  resetStore();
  saveSettings({ allowedUsers: ['alice', 'Alice', 'ALICE'] });
  const s = getAllowedUsers();
  assert.equal(s.size, 1);
  assert.ok(s.has('alice'));
});
