import { loadSettings, saveSettings } from './settings.js';
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

document.getElementById('saveBtn').addEventListener('click', () => {
  const users = fields.allowedUsers.value
    .split('\n')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean);
  saveSettings({
    botToken:     fields.botToken.value.trim(),
    allowedUsers: users,
    freeApiKey:   fields.freeApiKey.checked,
  });
  const ok = document.getElementById('saveOk');
  ok.style.display = 'inline';
  setTimeout(() => { ok.style.display = 'none'; }, 2000);
});

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

// -- Auto-connect on load if credentials are already saved ---------------------

(function init() {
  const s = loadSettings();
  if (s.botToken) {
    gwConnect();
  }
})();
