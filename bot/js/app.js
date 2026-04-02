import { loadSettings, saveSettings, getGitHubSync, saveGitHubSync } from './settings.js';
import { gwConnect, gwDisconnect, gw } from './gateway.js';
import { startCron } from './cron.js';
import { enqueueTask, rehydrate, setDeliveryHandler, setTypingHandler } from './task-manager.js';
import { sendDiscordMessage, triggerTyping } from './discord.js';
import { logMessage } from './ui.js';
import { loadWorkspaceFile, saveWorkspaceFile, getDailyMemories, clearDailyMemories } from './memory-store.js';
import { DEFAULT_SOUL, DEFAULT_AGENTS } from './planner.js';

// -- Settings form -------------------------------------------------------------

const fields = {
  botToken:     document.getElementById('botToken'),
  allowedUsers: document.getElementById('allowedUsers'),
  freeApiKey:   document.getElementById('freeApiCheckbox'),
};

// Populate form fields from persisted settings on load.
(function initForm() {
  const s = loadSettings();
  fields.botToken.value     = s.botToken ?? '';
  fields.allowedUsers.value = (s.allowedUsers ?? []).join('\n');
  fields.freeApiKey.checked = s.freeApiKey ?? false;
})();

function saveSettingsFields() {
  const users = fields.allowedUsers.value
    .split('\n')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean);
  const current = loadSettings();
  saveSettings({
    ...current,
    botToken:     fields.botToken.value.trim(),
    allowedUsers: users,
    freeApiKey:   fields.freeApiKey.checked,
  });
}

fields.botToken.addEventListener('change', saveSettingsFields);
fields.allowedUsers.addEventListener('change', saveSettingsFields);
fields.freeApiKey.addEventListener('change', saveSettingsFields);

document.getElementById('settingsToggle').addEventListener('click', () => {
  const hdr  = document.getElementById('settingsToggle');
  const body = document.getElementById('settingsBody');
  const open = hdr.classList.contains('open');
  hdr.classList.toggle('open', !open);
  body.classList.toggle('hidden', open);
});

// -- Log controls --------------------------------------------------------------

document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('logContainer').innerHTML =
    '<div class="log-empty" id="logEmpty">No activity yet. Configure the settings above, then click Connect.</div>';
});

// -- Connect / Disconnect button -----------------------------------------------

document.getElementById('connectBtn').addEventListener('click', () => {
  if (gw.ws || gw.reconnectTimer) {
    gwDisconnect();
  } else {
    gw.stopped = false;
    gwConnect();
  }
});

// -- Delivery handler (Discord) ------------------------------------------------

// Wire up Discord message delivery for the task manager.
// This keeps all Discord-specific logic out of task-manager.js.
setDeliveryHandler(async (task, message) => {
  const s = loadSettings();
  // Reply to the latest message in the conversation (follow-up or original)
  const replyTo = task.context?.__lastReplyToId || task.replyToId;
  const sent = await sendDiscordMessage(task.channelId, message, s.botToken, replyTo);
  // Update __lastReplyToId to the bot's reply so the chain stays linear
  if (sent?.id) {
    if (!task.context) task.context = {};
    task.context.__lastReplyToId = sent.id;
    const { putTask } = await import('./js/task-store.js');
    await putTask(task);
  }
  logMessage({ channel_id: task.channelId, content: message }, 'outgoing');
  return sent;
});

// Wire up typing indicator
setTypingHandler((task) => {
  const s = loadSettings();
  triggerTyping(task.channelId, s.botToken);
});

// -- Task system initialization ------------------------------------------------

// Start the cron scheduler — it watches for 'waiting' tasks whose nextRunAt
// has arrived and re-queues them.
startCron((task) => {
  console.log('[app] cron fired for task', task.id);
  enqueueTask(task);
});

// Rehydrate any tasks that were in-flight when the page was last closed.
rehydrate().then(() => {
  console.log('[app] task rehydration complete');
}).catch(err => {
  console.error('[app] task rehydration failed:', err);
});

// -- GitHub Sync UI ------------------------------------------------------------

const syncFields = {
  pat:          document.getElementById('githubPat'),
  repo:         document.getElementById('githubRepo'),
  autoSync:     document.getElementById('autoSyncCheckbox'),
  autoBulkSync: document.getElementById('autoBulkSyncCheckbox'),
};

// Populate sync fields from settings on load
(function initSyncForm() {
  const gs = getGitHubSync();
  syncFields.pat.value            = gs.pat ?? '';
  syncFields.repo.value           = gs.repo ?? '';
  syncFields.autoSync.checked     = gs.autoSyncOnWrite ?? true;
  syncFields.autoBulkSync.checked = gs.autoBulkSync ?? true;
})();

// Sync card toggle
document.getElementById('syncToggle').addEventListener('click', () => {
  const hdr  = document.getElementById('syncToggle');
  const body = document.getElementById('syncBody');
  const open = hdr.classList.contains('open');
  hdr.classList.toggle('open', !open);
  body.classList.toggle('hidden', open);
});

function saveSyncFields() {
  saveGitHubSync({
    enabled: !!(syncFields.pat.value.trim() && syncFields.repo.value.trim()),
    pat: syncFields.pat.value.trim(),
    repo: syncFields.repo.value.trim(),
    branch: 'main',
    autoSyncOnWrite: syncFields.autoSync.checked,
    autoBulkSync: syncFields.autoBulkSync.checked,
  });
}

syncFields.pat.addEventListener('change', saveSyncFields);
syncFields.repo.addEventListener('change', saveSyncFields);
syncFields.autoSync.addEventListener('change', saveSyncFields);
syncFields.autoBulkSync.addEventListener('change', () => {
  saveSyncFields();
  import('./github-sync.js').then(m => {
    if (syncFields.autoBulkSync.checked && getGitHubSync().enabled) {
      m.startBulkSyncTimer();
    } else {
      m.stopBulkSyncTimer();
    }
  });
});

// Test Connection
document.getElementById('testConnBtn').addEventListener('click', async () => {
  const ok = document.getElementById('syncOk');
  ok.style.color = '';
  try {
    saveSyncFields();
    const m = await import('./github-sync.js');
    await m.testConnection();
    ok.textContent = 'OK Connected';
    ok.style.display = 'inline';
    setTimeout(() => { ok.style.display = 'none'; }, 3000);
  } catch (err) {
    ok.textContent = err.message;
    ok.style.color = '#dc2626';
    ok.style.display = 'inline';
    setTimeout(() => { ok.style.display = 'none'; ok.style.color = ''; }, 5000);
  }
});

// Sync Now
document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncStatusText');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  dot.className = 'sync-dot syncing';
  txt.textContent = 'Syncing...';
  try {
    saveSyncFields();
    const m = await import('./github-sync.js');
    const result = await m.bulkSync();
    dot.className = 'sync-dot synced';
    txt.textContent = `Synced — ${result.count} tasks, just now`;
  } catch (err) {
    dot.className = 'sync-dot error';
    txt.textContent = `Sync error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Now';
  }
});

// Restore
document.getElementById('restoreBtn').addEventListener('click', async () => {
  if (!confirm('This will merge tasks from GitHub. Local tasks with newer timestamps are kept. Continue?')) return;
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncStatusText');
  dot.className = 'sync-dot syncing';
  txt.textContent = 'Restoring...';
  try {
    saveSyncFields();
    const m = await import('./github-sync.js');
    const result = await m.restore();
    dot.className = 'sync-dot synced';
    txt.textContent = `Restored ${result.restored} tasks, skipped ${result.skipped} (local was newer)`;
  } catch (err) {
    dot.className = 'sync-dot error';
    txt.textContent = `Restore error: ${err.message}`;
  }
});

// Start bulk sync timer on load if enabled (does not fire immediately)
(function initBulkSync() {
  const gs = getGitHubSync();
  if (gs.enabled && gs.autoBulkSync) {
    import('./github-sync.js').then(m => m.startBulkSyncTimer()).catch(console.warn);
  }
})();

// -- Memory card ---------------------------------------------------------------

// Toggle
document.getElementById('memoryToggle').addEventListener('click', () => {
  const hdr  = document.getElementById('memoryToggle');
  const body = document.getElementById('memoryBody');
  const open = hdr.classList.contains('open');
  hdr.classList.toggle('open', !open);
  body.classList.toggle('hidden', open);
  // Refresh learnings list when opening
  if (!open) renderLearnings();
});

// Workspace file editor
const wsFileSelect = document.getElementById('wsFileSelect');
const wsFileEditor = document.getElementById('wsFileEditor');
const wsFileHint = document.getElementById('wsFileHint');

const WS_HINTS = {
  'SOUL.md': 'Persona and tone. Defines who the bot is and how it communicates.',
  'AGENTS.md': 'Behavior and guidelines. Defines what the bot does and how it operates.',
  'MEMORY.md': 'Facts and knowledge. What the bot should always remember.',
};

const WS_PLACEHOLDERS = {
  'SOUL.md': 'Define the bot\'s persona and tone (e.g. "You are a friendly, concise assistant...").\nLeave empty to use the default.',
  'AGENTS.md': 'Define behavior rules and guidelines (e.g. "Always check 3 sources before answering...").\nLeave empty to use the default.',
  'MEMORY.md': 'Key facts the bot should always remember (e.g. user preferences, important URLs, decisions).',
};

const WS_DEFAULTS = {
  'SOUL.md': DEFAULT_SOUL,
  'AGENTS.md': DEFAULT_AGENTS,
  'MEMORY.md': '',
};

function loadWsFile() {
  const name = wsFileSelect.value;
  wsFileEditor.value = loadWorkspaceFile(name);
  wsFileEditor.placeholder = WS_PLACEHOLDERS[name] || '';
  wsFileHint.textContent = WS_HINTS[name] || 'Injected into every task\'s system prompt. Edit freely.';
}

// Load initial file
loadWsFile();

wsFileSelect.addEventListener('change', loadWsFile);

// Save
document.getElementById('saveWsFileBtn').addEventListener('click', () => {
  saveWorkspaceFile(wsFileSelect.value, wsFileEditor.value);
  const ok = document.getElementById('wsFileOk');
  ok.textContent = 'Saved';
  ok.style.display = 'inline';
  setTimeout(() => { ok.style.display = 'none'; }, 2000);
});

// Reset to default
document.getElementById('resetWsFileBtn').addEventListener('click', () => {
  const name = wsFileSelect.value;
  const def = WS_DEFAULTS[name];
  if (def === undefined) return;
  if (name === 'MEMORY.md') {
    if (!confirm('Clear MEMORY.md? This removes all stored facts.')) return;
  }
  wsFileEditor.value = def;
  saveWorkspaceFile(name, def);
  const ok = document.getElementById('wsFileOk');
  ok.textContent = 'Reset';
  ok.style.display = 'inline';
  setTimeout(() => { ok.style.display = 'none'; }, 2000);
});

// Render learnings list
async function renderLearnings() {
  const container = document.getElementById('learningsList');
  const memories = await getDailyMemories(30);
  const withEntries = memories.filter(m => m.entries && m.entries.length > 0);

  if (withEntries.length === 0) {
    container.innerHTML = '<div class="memory-empty">No learnings yet. The bot saves insights after completing tasks.</div>';
    return;
  }

  container.innerHTML = '';
  for (const m of withEntries) {
    const count = m.entries.length;
    const dateEl = document.createElement('div');
    dateEl.className = 'memory-date';
    dateEl.innerHTML = `<svg class="chevron-sm" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg> ${m.date} (${count} ${count === 1 ? 'entry' : 'entries'})`;
    dateEl.addEventListener('click', () => dateEl.classList.toggle('open'));

    const entriesEl = document.createElement('div');
    entriesEl.className = 'memory-entries';
    entriesEl.textContent = m.entries.join('\n---\n');

    container.appendChild(dateEl);
    container.appendChild(entriesEl);
  }
}

// Clear all learnings
document.getElementById('clearLearningsBtn').addEventListener('click', async () => {
  if (!confirm('Clear all learnings? This empties daily memory files. Click Sync Now to push to GitHub.')) return;
  await clearDailyMemories();
  renderLearnings();
});

// -- Auto-connect on load if credentials are already saved ---------------------

(function init() {
  const s = loadSettings();
  if (s.botToken) {
    gwConnect();
  }
})();
