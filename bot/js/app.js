import { loadSettings, saveSettings } from './settings.js';
import { gwConnect, gwDisconnect, gw } from './gateway.js';

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

// -- Auto-connect on load if credentials are already saved ---------------------

(function init() {
  const s = loadSettings();
  if (s.botToken) {
    gwConnect();
  }
})();
