import { proxyFetch } from './proxy.js';

const DISCORD_API = 'https://discord.com/api/v10';
const PERMANENT_ERRORS = [401, 403, 404, 405];

/**
 * Execute a Discord REST call with retry on 429 rate limits and transient errors.
 * Retries up to 3 times; respects Discord's retry_after header.
 */
async function discordFetchWithRetry(url, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await proxyFetch(url, opts);
    if (resp.status === 429 && attempt < 2) {
      const body = await resp.json().catch(() => ({}));
      const delay = (body.retry_after || 2) * 1000;
      console.warn(`[discord] rate limited, retry ${attempt + 1}/2 in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return resp;
  }
}

/**
 * POST to a Discord REST endpoint.
 * Retries on 429 rate limits. Throws on non-2xx responses.
 */
export async function discordPost(path, body, token) {
  const resp = await discordFetchWithRetry(`${DISCORD_API}${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => String(resp.status));
    throw new Error(`Discord API ${resp.status}: ${text}`);
  }
  return resp;
}

/**
 * GET from a Discord REST endpoint.
 * Retries on 429 rate limits. Returns the parsed JSON or throws on non-2xx.
 */
export async function discordGet(path, token) {
  const resp = await discordFetchWithRetry(`${DISCORD_API}${path}`, {
    method:  'GET',
    headers: { 'Authorization': `Bot ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => String(resp.status));
    throw new Error(`Discord API ${resp.status}: ${text}`);
  }
  return resp.json();
}


/**
 * Send a message to a Discord channel.
 * Splits content into <=1990-char chunks to stay under Discord's 2000-char limit.
 * If replyToId is given, the first chunk is sent as a reply to that message.
 * Returns the last sent message object (for recording in message map).
 */
export async function sendDiscordMessage(channelId, content, token, replyToId = null) {
  const chunks = [];
  for (let i = 0; i < content.length; i += 1990) {
    chunks.push(content.slice(i, i + 1990));
  }
  let firstMsg = null;
  for (let i = 0; i < chunks.length; i++) {
    const body = { content: chunks[i] };
    if (i === 0 && replyToId) {
      body.message_reference = { message_id: replyToId };
    } else if (i > 0 && firstMsg?.id) {
      // Chain subsequent chunks to the first so reply chain walk can traverse them
      body.message_reference = { message_id: firstMsg.id };
    }
    let resp;
    try {
      resp = await discordPost(`/channels/${channelId}/messages`, body, token);
    } catch (err) {
      // If message_reference points to a deleted/unknown message, retry without it
      if (body.message_reference && err.message?.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE')) {
        console.warn('[discord] referenced message not found, sending without reply reference');
        delete body.message_reference;
        resp = await discordPost(`/channels/${channelId}/messages`, body, token);
      } else {
        throw err;
      }
    }
    const msg = await resp.json().catch(() => null);
    if (i === 0) firstMsg = msg;
  }
  return firstMsg;
}

/**
 * Add a reaction to a message. emoji should be a URL-encoded unicode emoji e.g. '%F0%9F%91%80'.
 * Fire-and-forget; errors are silently ignored.
 */
export function addReaction(channelId, messageId, emoji, token) {
  proxyFetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`, {
    method:  'PUT',
    headers: { 'Authorization': `Bot ${token}` },
  }).catch(() => {});
}

/**
 * Trigger the Discord "...is typing" indicator in a channel.
 * Lasts ~10 s on Discord's side. Fire-and-forget; errors are silently ignored.
 */
export function triggerTyping(channelId, token) {
  proxyFetch(`${DISCORD_API}/channels/${channelId}/typing`, {
    method:  'POST',
    headers: { 'Authorization': `Bot ${token}` },
  }).catch(() => {});
}

/**
 * Fetch a single Discord message by ID from a channel.
 * Returns the message object or null if not found.
 */
export async function fetchDiscordMessage(channelId, messageId, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await discordGet(`/channels/${channelId}/messages/${messageId}`, token);
    } catch (err) {
      const msg = err.message || '';
      if (PERMANENT_ERRORS.some(code => msg.includes(String(code)))) return null;
      if (attempt >= 4) return null;
      const retryMatch = msg.match(/"retry_after":\s*([\d.]+)/);
      const delay = retryMatch ? parseFloat(retryMatch[1]) * 1000 : 2000;
      console.warn(`[discord] fetch ${messageId} failed (${msg.slice(0, 50)}), retry ${attempt + 1}/4 in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}
