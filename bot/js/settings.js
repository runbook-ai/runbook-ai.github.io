const STORAGE_KEY = 'runbookai_discord_agent_v1';

/** Load the persisted settings object from localStorage (never throws). */
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

/** Persist the settings object to localStorage. */
export function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}


export const PROXY_URL = 'https://proxy.runbookai.net';

/**
 * Return the allowlist as a Set of lowercase usernames.
 * An empty Set means allow everyone.
 */
export function getAllowedUsers() {
  const s = loadSettings();
  return new Set((s.allowedUsers ?? []).map(u => u.toLowerCase()));
}
