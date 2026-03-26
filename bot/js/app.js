import { loadSettings, saveSettings, getGitHubSync, saveGitHubSync } from './settings.js';
import { gwConnect, gwDisconnect, gw } from './gateway.js';
import { startCron } from './cron.js';
import { enqueueTask, rehydrate, setDeliveryHandler, setTypingHandler } from './task-manager.js';
import { sendDiscordMessage, triggerTyping } from './discord.js';
import { logMessage } from './ui.js';

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
  const sent = await sendDiscordMessage(task.channelId, message, s.botToken, task.replyToId);
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

// -- Auto-connect on load if credentials are already saved ---------------------

(function init() {
  const s = loadSettings();
  if (s.botToken) {
    gwConnect();
  }
})();
