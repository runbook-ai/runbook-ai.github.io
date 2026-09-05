---
name: discord-web
description: Search messages, list servers/channels, and fetch announcements on discord.com via Discord's internal API from evalJavaScript in one turn.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["*.discord.com", "discord.com"]
    autoload: true
    tags: [site, api, discord, search, chat]
    tested: 2026-09-04
---

## When to use
Any search or navigation task on discord.com (e.g. searching server messages, finding specific channels, checking user submissions/messages or rules). Everything below runs from `evalJavaScript` on any `discord.com` page in 1-2 turns.

## CRITICAL RULES FOR SPEED & STABILITY
1. **Compact String Mapping**: NEVER return raw API message objects (which contain large author/embed metadata). Map results to lightweight strings (e.g. `` `${m.author.username}: ${m.content}` ``) and `.slice(0, 10)`. Returning > 2,000 chars forces the agent to waste extra turns reading transient memory.
2. **Guild Search over Channel Slicing**: ALWAYS use `/api/v9/guilds/<guildId>/messages/search?content=<query>` to search a server across all channels in 1 call instead of looping `/channels/<id>/messages`.
3. **Rate Limit Prevention**: Discord search endpoint throttles rapid loops (HTTP 429). Add `await new Promise(r => setTimeout(r, 1000))` between guild search requests when iterating over multiple servers.
4. **Single-Turn Execution**: Combine token extraction + guild selection + search query + string mapping into ONE single `evalJavaScript` expression.

## Setup (Token Extraction)
```js
const iframe = document.createElement('iframe');
document.body.appendChild(iframe);
const token = JSON.parse(iframe.contentWindow.localStorage.getItem('token'));
iframe.remove();
const headers = { 'Authorization': token, 'Content-Type': 'application/json' };
```

## Recipes

### 1. Fast Single-Turn Server Search (1-2 Turns Max)
Run this complete block in `evalJavaScript`:
```js
(async () => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const token = JSON.parse(iframe.contentWindow.localStorage.getItem('token'));
  iframe.remove();
  const headers = { 'Authorization': token };

  // A. Find Target Server
  const guilds = await fetch('/api/v9/users/@me/guilds', { headers }).then(r => r.json());
  const guild = guilds.find(g => g.name.toLowerCase().includes('robonation')) || guilds[0];

  // B. Guild Search
  const query = 'pilot'; // or user query / keyword
  const searchRes = await fetch('/api/v9/guilds/' + guild.id + '/messages/search?content=' + encodeURIComponent(query), { headers }).then(r => r.json());

  // C. Compact Formatting (prevents transient memory overflow)
  if (!searchRes.messages) return { total: 0, matches: [] };
  const matches = searchRes.messages.flatMap(g => g).slice(0, 8).map(m => 
    `${m.author.username} (${new Date(m.timestamp).toLocaleDateString()}): ${m.content}`
  );

  return { server: guild.name, total: searchRes.total_results, matches };
})()
```

### 2. Multi-Server Search (With Rate-Limit Safety)
If searching across multiple servers, include 1s delays to avoid HTTP 429 rate limiting:
```js
(async () => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const token = JSON.parse(iframe.contentWindow.localStorage.getItem('token'));
  iframe.remove();
  const headers = { 'Authorization': token };

  const guilds = await fetch('/api/v9/users/@me/guilds', { headers }).then(r => r.json());
  let matches = [];

  for (const g of guilds) {
    try {
      const res = await fetch('/api/v9/guilds/' + g.id + '/messages/search?content=' + encodeURIComponent('pilot'), { headers }).then(r => r.json());
      if (res.messages && res.messages.length > 0) {
        matches.push(...res.messages.flatMap(m => m).map(m => `${g.name} | ${m.author.username}: ${m.content.slice(0, 150)}`));
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1000)); // Rate limit guard
  }
  return matches.slice(0, 10);
})()
```

### 3. List Server Channels
```js
const channels = await fetch('/api/v9/guilds/' + guild.id + '/channels', { headers }).then(r => r.json());
return channels.filter(c => c.name).map(c => ({ id: c.id, name: c.name }));
```

## Traps & Limits
- Returning full raw message objects causes **transient memory overflow**, adding 2+ extra turns. Map messages to plain strings!
- Firing > 3 search requests per second triggers **HTTP 429 rate limiting**. Keep searches targeted or add 1s delays.
