import { PROXY_URL } from './settings.js';

const DISCORD_API = 'https://discord.com/api/v10';

// Route Discord REST calls through the CORS proxy.
function proxyFetch(targetUrl, opts = {}) {
  return fetch(`${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, opts);
}

/**
 * POST to a Discord REST endpoint.
 * Throws on non-2xx responses with a descriptive error message.
 */
export async function discordPost(path, body, token) {
  const resp = await proxyFetch(`${DISCORD_API}${path}`, {
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
 * Ensure a DM channel is open with the given user; returns the channel ID.
 * Safe to call even if the channel already exists — Discord returns the existing one.
 */
export async function openDMChannel(userId, token) {
  const resp = await proxyFetch(`${DISCORD_API}/users/@me/channels`, {
    method:  'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => String(resp.status));
    throw new Error(`Cannot open DM channel: ${text}`);
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Send a message to a Discord channel.
 * Splits content into <=1990-char chunks to stay under Discord's 2000-char limit.
 * If replyToId is given, the first chunk is sent as a reply to that message.
 */
export async function sendDiscordMessage(channelId, content, token, replyToId = null) {
  const chunks = [];
  for (let i = 0; i < content.length; i += 1990) {
    chunks.push(content.slice(i, i + 1990));
  }
  for (let i = 0; i < chunks.length; i++) {
    const body = { content: chunks[i] };
    if (i === 0 && replyToId) {
      body.message_reference = { message_id: replyToId };
    }
    await discordPost(`/channels/${channelId}/messages`, body, token);
  }
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
