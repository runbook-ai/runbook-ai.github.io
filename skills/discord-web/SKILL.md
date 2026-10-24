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
Any search or navigation task on discord.com: searching server messages,
finding channels, checking a user's messages or a server's rules. The
functions below call Discord's internal API from `evalJavaScript` on any
`discord.com` tab, e.g.

    skills.discordWeb.searchGuild({guild: 'robonation', query: 'pilot'})

## Rules
1. **Search the server, not channel by channel**: `searchGuild` covers every
   channel of a server in one request. Do not loop over `channelMessages`
   to find text.
2. **One expression**: do lookups and the search in ONE `evalJavaScript`
   call -- an async IIFE can await several functions and return one result.
3. **Rate limits**: Discord search throttles bursts (HTTP 429). Use
   `searchAllGuilds` (1 s apart) to cover many servers; never fire your own
   loop of searches.
4. **Compact results**: the functions return short strings. If you call
   `/api/v9` yourself, map messages to strings and slice -- raw message
   objects are huge and push the result into transient memory.

## Traps & Limits
- The functions fail with "no Discord token" on a logged-out tab: open
  discord.com/channels/@me and make sure the account is signed in.
- Search results lag new messages by a few seconds to minutes.
