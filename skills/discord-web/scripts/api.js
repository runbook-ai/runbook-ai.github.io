// Discord's internal REST API (/api/v9), called with the session token.
// Runs on any discord.com tab. Results are compact strings: raw message
// objects carry large author/embed payloads.

// The user token lives in localStorage, which Discord hides from its own
// window; a fresh same-origin iframe still sees it.
function authHeaders() {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
        const raw = iframe.contentWindow.localStorage.getItem('token');
        if (!raw) throw new Error('no Discord token in localStorage -- is this tab logged in to discord.com?');
        return { Authorization: JSON.parse(raw) };
    } finally {
        iframe.remove();
    }
}

async function api(path) {
    const r = await fetch('/api/v9' + path, { headers: authHeaders() });
    if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        throw new Error(`rate limited (HTTP 429); retry after ${j.retry_after ?? '?'} s`);
    }
    if (!r.ok) throw new Error(`GET /api/v9${path} -> HTTP ${r.status}`);
    return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatMessage(m, prefix) {
    const day = new Date(m.timestamp).toLocaleDateString();
    return `${prefix || ''}${m.author.username} (${day}): ${String(m.content || '').slice(0, 300)}`;
}

async function resolveGuild(guild) {
    const guilds = await api('/users/@me/guilds');
    if (guild == null || guild === '') return guilds[0];
    const g = String(guild).toLowerCase();
    const hit = guilds.find(x => x.id === String(guild)) || guilds.find(x => x.name.toLowerCase().includes(g));
    if (!hit) throw new Error(`no server matching "${guild}"; servers: ${guilds.map(x => x.name).join(', ')}`);
    return hit;
}

/** Servers the account is in. -> [{id, name}] */
async function listGuilds() {
    return (await api('/users/@me/guilds')).map(g => ({ id: g.id, name: g.name }));
}

/** Search one server's messages across all its channels in one call. guild: server id or name substring (default: the first server). -> {server, guildId, total, matches: ["user (date): text"]} */
async function searchGuild({ guild, query, limit = 8 } = {}) {
    const g = await resolveGuild(guild);
    const res = await api(`/guilds/${g.id}/messages/search?content=${encodeURIComponent(query || '')}`);
    const matches = (res.messages || []).flat().slice(0, limit).map(m => formatMessage(m));
    return { server: g.name, guildId: g.id, total: res.total_results || 0, matches };
}

/** Search every server the account is in, pausing 1 s between servers (Discord throttles search with HTTP 429). -> ["server | user (date): text"] */
async function searchAllGuilds({ query, limit = 10 } = {}) {
    const guilds = await api('/users/@me/guilds');
    const out = [];
    for (const g of guilds) {
        try {
            const res = await api(`/guilds/${g.id}/messages/search?content=${encodeURIComponent(query || '')}`);
            out.push(...(res.messages || []).flat().map(m => formatMessage(m, g.name + ' | ')));
        } catch (e) {
            out.push(`${g.name} | error: ${e.message}`);
        }
        if (out.length >= limit) break;
        await sleep(1000);
    }
    return out.slice(0, limit);
}

/** A server's text channels and categories. guild: server id or name substring. -> [{id, name, type}] */
async function listChannels({ guild } = {}) {
    const g = await resolveGuild(guild);
    const channels = await api(`/guilds/${g.id}/channels`);
    return channels.filter(c => c.name).map(c => ({ id: c.id, name: c.name, type: c.type }));
}

/** Latest messages of one channel, newest first (max 100). -> ["user (date): text"] */
async function channelMessages({ channelId, limit = 20 } = {}) {
    const msgs = await api(`/channels/${channelId}/messages?limit=${Math.min(Math.max(1, limit), 100)}`);
    return msgs.map(m => formatMessage(m));
}
