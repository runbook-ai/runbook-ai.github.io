import { loadSettings, saveSettings, getGitHubSync, saveGitHubSync } from './settings.js';
import { gwConnect, gwDisconnect, gw } from './gateway.js';
import { startCron, setCronConfig } from './cron.js';
import { enqueueTask, rehydrate, setDeliveryHandler, setTypingHandler, setProcessingHandlers, startMonitorTick, startEventTick } from './task-manager.js';
import { gcEvents } from './event-store.js';
import { sendDiscordMessage, triggerTyping } from './discord.js';
import { logMessage, showProcessing, hideProcessing } from './ui.js';
import { loadWorkspaceFile, saveWorkspaceFile } from './memory-store.js';
import { DEFAULT_SOUL, DEFAULT_AGENTS } from './planner.js';
import { LOCAL_CHANNEL_ID, deliverToLocalUI, showLocalTyping } from './local-ui.js';
import { startMonitorUI } from './monitor-ui.js';

// -- Settings form -------------------------------------------------------------

const fields = {
  botToken:     document.getElementById('botToken'),
  allowedUsers: document.getElementById('allowedUsers'),
  freeApiKey:      document.getElementById('freeApiCheckbox'),
  forceGroupMode:  document.getElementById('forceGroupModeCheckbox'),
};

// Populate form fields from persisted settings on load.
(function initForm() {
  const s = loadSettings();
  fields.botToken.value        = s.botToken ?? '';
  fields.allowedUsers.value    = (s.allowedUsers ?? []).join('\n');
  fields.freeApiKey.checked    = s.freeApiKey ?? false;
  fields.forceGroupMode.checked = s.forceGroupMode ?? false;
})();

function saveSettingsFields() {
  const users = fields.allowedUsers.value
    .split('\n')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean);
  const current = loadSettings();
  saveSettings({
    ...current,
    botToken:       fields.botToken.value.trim(),
    allowedUsers:   users,
    freeApiKey:     fields.freeApiKey.checked,
    forceGroupMode: fields.forceGroupMode.checked,
  });
}

fields.botToken.addEventListener('change', saveSettingsFields);
fields.allowedUsers.addEventListener('change', saveSettingsFields);
fields.freeApiKey.addEventListener('change', saveSettingsFields);
fields.forceGroupMode.addEventListener('change', saveSettingsFields);

document.getElementById('settingsToggle').addEventListener('click', () => {
  const hdr  = document.getElementById('settingsToggle');
  const body = document.getElementById('settingsBody');
  const open = hdr.classList.contains('open');
  hdr.classList.toggle('open', !open);
  body.classList.toggle('hidden', open);
});

// -- Log controls --------------------------------------------------------------

document.getElementById('clearBtn').addEventListener('click', () => {
  const feed = document.getElementById('chatFeed');
  if (feed) feed.innerHTML = '<div class="log-empty" id="chatEmpty">No activity yet.</div>';
});

// -- Settings panel toggle -----------------------------------------------------

// 3-way panel switcher: chat ↔ monitor ↔ settings
function showPanel(name) {
  document.getElementById('chatPanel').classList.toggle('hidden',     name !== 'chat');
  document.getElementById('monitorPanel').classList.toggle('hidden',  name !== 'monitor');
  document.getElementById('settingsPanel').classList.toggle('hidden', name !== 'settings');
  document.getElementById('settingsPanelBtn').classList.toggle('active', name === 'settings');
  document.getElementById('monitorPanelBtn')?.classList.toggle('active',  name === 'monitor');
}

document.getElementById('settingsPanelBtn')?.addEventListener('click', () => {
  const isOpen = !document.getElementById('settingsPanel').classList.contains('hidden');
  showPanel(isOpen ? 'chat' : 'settings');
});

document.getElementById('monitorPanelBtn')?.addEventListener('click', () => {
  const isOpen = !document.getElementById('monitorPanel').classList.contains('hidden');
  showPanel(isOpen ? 'chat' : 'monitor');
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

// -- Delivery handler (Discord or Local UI) ------------------------------------

// Routes outgoing messages to Discord or the local chat UI based on channelId.
setDeliveryHandler(async (task, message) => {
  // Local UI channel — render in the browser, no Discord call needed
  if (task.channelId === LOCAL_CHANNEL_ID) {
    deliverToLocalUI(task, message);
    return null;
  }

  // Discord channel
  const s = loadSettings();
  const isGroup = task.channelMode === 'group';
  const replyTo = isGroup ? null : (task.context?.__lastReplyToId || task.replyToId);
  const output = (isGroup && task.label) ? `**[${task.label}]** ${message}` : message;
  const sent = await sendDiscordMessage(task.channelId, output, s.botToken, replyTo);
  if (!isGroup && sent?.id) {
    if (!task.context) task.context = {};
    task.context.__lastReplyToId = sent.id;
    const { putTask } = await import('./task-store.js');
    await putTask(task);
  }
  logMessage({ channel_id: task.channelId, content: message }, 'outgoing');
  return sent;
});

// Wire up typing indicator
setTypingHandler((task) => {
  if (task.channelId === LOCAL_CHANNEL_ID) {
    showLocalTyping(true);
    return;
  }
  const s = loadSettings();
  triggerTyping(task.channelId, s.botToken);
});

// Wire up bot-page's "Bot thinking" row to task lifecycle
setProcessingHandlers({
  onStart: (task) => showProcessing(task.channelId),
  onStop:  ()     => hideProcessing(),
});

// -- Task system initialization ------------------------------------------------

// Start the cron scheduler — it watches for 'waiting' tasks whose nextRunAt
// has arrived and re-queues them.
setCronConfig(async () => ({}));
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

// Start monitor scheduler (runs parallel to serial agent queue)
startMonitorTick();

// Start event scheduler (drives spawn_task({trigger:{topic}}) subscriptions)
startEventTick();

// GC old event lines on startup + once a day. 30-day TTL per the design.
gcEvents().then(r => r.dropped && console.log(`[app] gcEvents dropped ${r.dropped} old lines across ${r.topics} topics`)).catch(err => console.warn('[app] gcEvents failed:', err.message));
setInterval(() => {
  gcEvents().then(r => r.dropped && console.log(`[app] gcEvents dropped ${r.dropped} old lines across ${r.topics} topics`)).catch(err => console.warn('[app] gcEvents failed:', err.message));
}, 24 * 60 * 60 * 1000);

// Start monitor panel UI
const monitorContainer = document.getElementById('monitorPanel');
if (monitorContainer) startMonitorUI({ container: monitorContainer });

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

// -- Auto-connect on load if credentials are already saved ---------------------

(function init() {
  const s = loadSettings();
  if (s.botToken) {
    gwConnect();
  }
})();
