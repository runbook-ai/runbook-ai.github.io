/**
 * Memory store — persistent long-term memory for the bot.
 *
 * Workspace files (localStorage):
 *   SOUL.md    — persona and tone
 *   AGENTS.md  — behavior and guidelines
 *   MEMORY.md  — facts and accumulated knowledge
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

// ── Context builder (for system prompt injection) ────────────────────────────

/**
 * Build the workspace context to inject into the planner system prompt.
 * Returns { soul, agents, memory } strings. Empty strings if no content.
 */
export async function buildWorkspaceContext() {
  const soul = loadWorkspaceFile('SOUL.md').trim();
  const agents = loadWorkspaceFile('AGENTS.md').trim();
  const md = loadWorkspaceFile('MEMORY.md').trim();
  const memory = md ? `\n\n# Long-term Memory\n\n## MEMORY.md\n${md}` : '';
  return { soul, agents, memory };
}
