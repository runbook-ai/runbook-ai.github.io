// -- Status bar ----------------------------------------------------------------

/** Set the header status indicator. cls is one of '', 'connecting', 'connected', 'error'. */
export function setStatus(cls, text) {
  const dot = document.getElementById('statusDot');
  dot.className = cls ? `status-dot ${cls}` : 'status-dot';
  document.getElementById('statusText').textContent = text;
}

/** Update the Connect/Disconnect button in the header. */
export function setConnectBtn(text, cls, disabled) {
  const btn = document.getElementById('connectBtn');
  btn.textContent = text;
  btn.className   = `btn ${cls}`;
  btn.disabled    = disabled;
}

/** Collapse the Settings panel and show the chat panel (called after a successful READY). */
export function collapseSettings() {
  document.getElementById('settingsPanel')?.classList.add('hidden');
  document.getElementById('chatPanel')?.classList.remove('hidden');
  document.getElementById('settingsPanelBtn')?.classList.remove('active');
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
  return document.getElementById('chatFeed');
}

const MAX_LOG_ENTRIES = 100;

/** Append a DOM element to the log and scroll to the bottom. */
export function appendLog(el) {
  document.getElementById('chatEmpty')?.remove();
  const container = getLogContainer();
  container.appendChild(el);
  while (container.children.length > MAX_LOG_ENTRIES) {
    container.removeChild(container.firstChild);
  }
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

/** Append an incoming or outgoing message to the feed.
 *  For local:ui channel the channel badge is omitted (already shown as chat bubble). */
export function logMessage(msg, direction) {
  if (msg.channel_id === 'local:ui') return; // rendered as chat bubbles by local-ui.js
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
  const badge = channelId === 'local:ui' ? '' : `<span class="ch-badge">#${escHtml(channelId)}</span>`;
  processingEl.innerHTML =
    `${badge}<span>Bot thinking</span>` +
    `<span class="dots"><span></span><span></span><span></span></span>`;
  appendLog(processingEl);
}

/** Remove the "Bot thinking..." indicator if present. */
export function hideProcessing() {
  processingEl?.remove();
  processingEl = null;
}
