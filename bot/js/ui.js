// -- Status bar ----------------------------------------------------------------

/** Set the header status indicator. cls is one of '', 'connecting', 'connected', 'error'. */
export function setStatus(cls, text) {
  document.getElementById('statusDot').className = `status-dot ${cls}`;
  document.getElementById('statusText').textContent = text;
}

/** Update the Connect/Disconnect button in the header. */
export function setConnectBtn(text, cls, disabled) {
  const btn = document.getElementById('connectBtn');
  btn.textContent = text;
  btn.className   = `btn ${cls}`;
  btn.disabled    = disabled;
}

/** Collapse the Settings card (called automatically after a successful READY). */
export function collapseSettings() {
  document.getElementById('settingsToggle').classList.remove('open');
  document.getElementById('settingsBody').classList.add('hidden');
}

// -- Activity log --------------------------------------------------------------

/** Escape a string for safe HTML insertion. */
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getLogContainer() {
  return document.getElementById('logContainer');
}

/** Append a DOM element to the log and scroll to the bottom. */
export function appendLog(el) {
  document.getElementById('logEmpty')?.remove();
  const container = getLogContainer();
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

/** Append an error notice to the log. Connection/system messages are suppressed. */
export function logSystem(msg, type = 'system-msg') {
  if (type !== 'error-msg') return; // only errors go in the activity log
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.innerHTML =
    `<div class="log-meta">` +
    `<span class="log-author system">Error</span>` +
    `<span>${new Date().toLocaleTimeString()}</span>` +
    `</div>` +
    `<div class="log-content">${escHtml(msg)}</div>`;
  appendLog(el);
}

/** Append an incoming or outgoing Discord message to the log. */
export function logMessage(msg, direction) {
  const el = document.createElement('div');
  el.className = `log-entry ${direction}`;
  const chBadge    = `<span class="ch-badge">#${escHtml(msg.channel_id)}</span>`;
  const authorCls  = direction === 'outgoing' ? 'bot' : 'user';
  const authorName = direction === 'outgoing' ? 'Bot' : escHtml(msg.author?.username ?? 'unknown');
  el.innerHTML =
    `<div class="log-meta">${chBadge}` +
    `<span class="log-author ${authorCls}">${authorName}</span>` +
    `<span>${new Date().toLocaleTimeString()}</span>` +
    `</div>` +
    `<div class="log-content">${escHtml(msg.content)}</div>`;
  appendLog(el);
}

// Single floating "thinking" indicator - replaced on each new request.
let processingEl = null;

/** Show an animated "Bot thinking..." row in the log. */
export function showProcessing(channelId) {
  hideProcessing();
  processingEl = document.createElement('div');
  processingEl.className = 'processing';
  processingEl.innerHTML =
    `<span class="ch-badge">#${escHtml(channelId)}</span>` +
    `<span>Bot thinking</span>` +
    `<span class="dots"><span></span><span></span><span></span></span>`;
  appendLog(processingEl);
}

/** Remove the "Bot thinking..." indicator if present. */
export function hideProcessing() {
  processingEl?.remove();
  processingEl = null;
}
