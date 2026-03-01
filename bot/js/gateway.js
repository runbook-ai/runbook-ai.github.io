import { loadSettings } from './settings.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Gateway opcodes - https://discord.com/developers/docs/topics/opcodes-and-status-codes
const OP = {
  DISPATCH:        0,
  HEARTBEAT:       1,
  IDENTIFY:        2,
  RESUME:          6,
  RECONNECT:       7,
  INVALID_SESSION: 9,
  HELLO:           10,
  HEARTBEAT_ACK:   11,
};

// Intent bits: GUILDS=1, GUILD_MESSAGES=512, MESSAGE_CONTENT=32768, DIRECT_MESSAGES=4096
const INTENTS = 1 | 512 | 32768 | 4096;
import { setStatus, setConnectBtn, collapseSettings, logSystem } from './ui.js';
import { handleMessageCreate } from './message-handler.js';

// -- Gateway state -------------------------------------------------------------

export const gw = {
  ws:               null,
  heartbeatTimer:   null,
  ackReceived:      true,
  seq:              null,        // last sequence number received
  sessionId:        null,        // active session ID (for RESUME)
  resumeGatewayUrl: null,        // preferred reconnect URL from READY
  botUserId:        null,        // bot's own user ID (to filter self-messages)
  reconnectTimer:   null,
  reconnectDelay:   1000,        // ms; doubles on each failure, capped at 60 s
  stopped:          false,       // true when the user explicitly disconnected
};

// -- Internal helpers ----------------------------------------------------------

function gwSend(payload) {
  if (gw.ws?.readyState === WebSocket.OPEN) {
    gw.ws.send(JSON.stringify(payload));
  }
}

function startHeartbeat(intervalMs) {
  clearInterval(gw.heartbeatTimer);
  gw.ackReceived = true;
  gw.heartbeatTimer = setInterval(() => {
    if (!gw.ackReceived) {
      // No ACK before the next beat - zombie connection. Reconnect.
      logSystem('Heartbeat ACK not received - reconnecting...');
      gw.ws?.close(4000, 'zombie');
      return;
    }
    gw.ackReceived = false;
    gwSend({ op: OP.HEARTBEAT, d: gw.seq });
  }, intervalMs);
}

function identify() {
  gwSend({
    op: OP.IDENTIFY,
    d: {
      token:      loadSettings().botToken,
      intents:    INTENTS,
      properties: { os: 'linux', browser: 'runbook-ai', device: 'runbook-ai' },
    },
  });
}

function resume() {
  gwSend({
    op: OP.RESUME,
    d: { token: loadSettings().botToken, session_id: gw.sessionId, seq: gw.seq },
  });
}

// -- Gateway message router ----------------------------------------------------

function onGatewayMessage(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const { op, d, s, t } = payload;
  if (s != null) gw.seq = s;

  switch (op) {
    case OP.HELLO:
      startHeartbeat(d.heartbeat_interval);
      // Resume if we have a live session; otherwise start fresh.
      if (gw.sessionId && gw.seq != null) {
        resume();
      } else {
        identify();
      }
      break;

    case OP.HEARTBEAT_ACK:
      gw.ackReceived = true;
      break;

    case OP.HEARTBEAT:
      // Server explicitly requests a heartbeat (unusual but valid per spec).
      gwSend({ op: OP.HEARTBEAT, d: gw.seq });
      break;

    case OP.RECONNECT:
      // Server wants us to reconnect and resume immediately.
      logSystem('Server requested reconnect...');
      gw.ws?.close(4000, 'reconnect');
      break;

    case OP.INVALID_SESSION:
      if (d) {
        // Resumable - wait a short random delay then try again.
        setTimeout(() => resume(), 1000 + Math.random() * 4000);
      } else {
        // Not resumable - start a completely new session.
        gw.sessionId = null;
        gw.seq       = null;
        setTimeout(() => identify(), 1000 + Math.random() * 4000);
      }
      break;

    case OP.DISPATCH:
      onDispatch(t, d);
      break;
  }
}

function onDispatch(event, data) {
  switch (event) {
    case 'READY':
      gw.botUserId        = data.user.id;
      gw.sessionId        = data.session_id;
      gw.resumeGatewayUrl = data.resume_gateway_url;
      gw.reconnectDelay   = 1000; // reset backoff after a clean connect
      setStatus('connected', `Connected as ${data.user.username}`);
      setConnectBtn('Disconnect', 'btn-danger', false);
      logSystem(`Connected as ${data.user.username} (${data.user.id}). Listening for DMs.`);
      collapseSettings();
      break;

    case 'RESUMED':
      // Keep showing 'Connected as ...' - don't flash a different message.
      break;

    case 'MESSAGE_CREATE':
      handleMessageCreate(data, gw.botUserId);
      break;
  }
}

// -- Public API ----------------------------------------------------------------

/** Open the Gateway WebSocket and begin the identify/heartbeat loop. */
export function gwConnect() {
  if (gw.ws) return; // already open or connecting

  const s = loadSettings();
  if (!s.botToken) {
    logSystem('No bot token configured. Fill in the Configuration panel and save.', 'error-msg');
    return;
  }

  setStatus('connecting', '');
  setConnectBtn('Disconnect', 'btn-danger', true);

  // Prefer the resume URL from the last READY event (Discord requirement).
  const ws = new WebSocket(gw.resumeGatewayUrl ?? GATEWAY_URL);
  gw.ws = ws;

  ws.onopen = () => setConnectBtn('Disconnect', 'btn-danger', false);

  ws.onmessage = (e) => onGatewayMessage(e.data);

  ws.onerror = () => logSystem('WebSocket connection error.', 'error-msg');

  ws.onclose = (e) => {
    clearInterval(gw.heartbeatTimer);
    gw.ws = null;

    if (gw.stopped) {
      setStatus('', 'Disconnected');
      setConnectBtn('Connect', 'btn-primary', false);
      return;
    }

    // Auto-reconnect with exponential backoff (capped at 60 s).
    const delay = gw.reconnectDelay;
    logSystem(`Disconnected (code ${e.code}). Reconnecting in ${Math.round(delay / 1000)}s...`);
    setStatus('connecting', '');
    gw.reconnectTimer = setTimeout(() => {
      gw.reconnectTimer = null;
      gwConnect();
    }, delay);
    gw.reconnectDelay = Math.min(delay * 2, 60_000);
  };
}

/** Close the Gateway connection and clear all reconnect state. */
export function gwDisconnect() {
  gw.stopped = true;
  clearInterval(gw.heartbeatTimer);
  clearTimeout(gw.reconnectTimer);
  gw.reconnectTimer   = null;
  gw.ws?.close(1000, 'user disconnect');
  gw.ws               = null;
  gw.sessionId        = null;
  gw.seq              = null;
  gw.resumeGatewayUrl = null;
  gw.botUserId        = null;
  gw.reconnectDelay   = 1000;
  setStatus('', 'Disconnected');
  setConnectBtn('Connect', 'btn-primary', false);
  logSystem('Disconnected.');
}
