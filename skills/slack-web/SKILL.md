---
name: slack-web
description: Read Slack threads, search and channel history from the web client's own API in one evalJavaScript call; go to app.slack.com, never to an /archives/ permalink -- that URL never loads.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["*.slack.com"]
    autoload: true
    tags: [site, api, chat, slack]
    tested: 2026-08-29
---

## When to use
Any read on Slack: a thread from a permalink, a message search, recent channel
messages. Do NOT click and scroll Slack's panes to collect messages -- they are
virtualized and lossy (see Traps). Get the data from the client's own API in ONE
`evalJavaScript` call.

## Step 1 -- never open a workspace permalink
`https://<workspace>.slack.com/archives/<CID>/p<digits>` parks permanently on a
`Redirecting… | Slack` app-launcher interstitial ("open this link in your
browser"). It never resolves; this is not an auth problem, and reloading or
waiting will not help. Take the ids out of the URL instead:

- **channel** = the `C…` / `D…` / `G…` segment after `/archives/`
- **message ts** = `p1787950886727819` → `1787950886.727819` (decimal point
  before the last 6 digits)
- if the URL carries `?thread_ts=<ts>`, **that** is the thread root and the
  `p…` value is just one reply inside it -- use `thread_ts`

Then `navigateToUrl` **`https://app.slack.com/`** -- one navigation, nothing else.
That page may render as a "Welcome back" workspace picker rather than the chat
UI; **that is fine and it is where you stop.** `/api/*` answers from it. Do NOT
navigate on to `app.slack.com/client/<team>…` or derive
`…/client/<team>/<channel>/thread/…`: the client URL needs a team id you do not
have, it redirects to the channel, and it leaves you scrolling a virtualized pane.
If you are already on any `slack.com` page (including the interstitial), one
navigation to `https://app.slack.com/` is still all you need.

## Step 2 -- one call for the data
On any `app.slack.com` page `/api/*` is same-origin. Auth needs the session
cookie **and** an `xoxc` token from `localStorage`; without the token every call
returns `{ok: false, error: "not_authed"}`. Never print the token or put it in
`setMemory`, `description` or `reasoning`.

```js
const cfg = JSON.parse(localStorage.localConfig_v2);
const toks = Object.values(cfg.teams).map(t => t.token);   // one per workspace
const api = async (method, params) => {                    // first token that works
  let last;
  for (const token of toks) {
    const fd = new FormData();
    fd.append('token', token);
    for (const k in params) fd.append(k, params[k]);
    last = await (await fetch('/api/' + method, {method: 'POST', body: fd, credentials: 'include'})).json();
    if (last.ok) return last;
  }
  return last;                                             // e.g. {error: 'channel_not_found'}
};
const fmt = m => ({ts: m.ts, when: new Date(+m.ts * 1000).toISOString(),
  who: (m.user_profile && (m.user_profile.real_name || m.user_profile.display_name)) || m.user || m.bot_id,
  text: m.text});
```

- **Whole thread**: `api('conversations.replies', {channel, ts: threadTs, limit: '200'})`
  → `messages` in order, root first, each already carrying `user_profile` (no
  name lookup needed). **Completeness oracle: `messages[0].reply_count` is the
  reply count, so `messages.length` must equal `reply_count + 1`** -- return both
  numbers and say PARTIAL if they differ. If `has_more` is true, repeat with
  `cursor: <response_metadata.next_cursor>` and concatenate until the counts agree.
- **Search**: `api('search.messages', {query, count: '20', sort: 'timestamp'})` →
  `messages.total`, `messages.pagination.page_count`, and `messages.matches[]`
  with `{ts, text, permalink, channel: {id, name}, user}`. Slack's query
  modifiers work in `query`: `in:#channel-name`, `from:@display-name`,
  `after:2026-08-01`, `"exact phrase"`. Paginate with `page: '2'`. Matches carry
  an opaque numeric `username` -- resolve the real names from the `user` ids with
  ONE `api('users.info', {users: 'U1,U2,U3'})` (`users[].profile.real_name`).
- **Recent channel messages**: `api('conversations.history', {channel, limit: '50'})`
  -- newest first, `user_profile` included, `has_more` + `cursor` for older.

Return only what the task needs, and `saveToFile` anything long.

## Message text is markup, not plain text
`<@U0A1B2C3D4E>` is a user mention (resolve with `users.info`), `<#C0A1B2C3D4E|name>` a
channel, `<https://x/y|label>` a link (keep `label`, or the URL if there is no
`|`), and `&amp;` `&lt;` `&gt;` are HTML-escaped -- unescape them. Quoted lines
arrive as `&gt; …`. Decode before quoting a message back to the user.

## Traps
- **Do not scroll the thread pane.** It is virtualized and opens anchored to the
  newest message, so it reports `(100%)` on first paint while older messages are
  not in the DOM at all. That reads as "fully read" and silently truncates the
  thread -- the API call above is the reason this skill exists.
- **Use the relative path `/api/…`.** Slack's own client calls
  `https://<org>.enterprise.slack.com/api/…`; that host is cross-origin from
  `app.slack.com` and a fetch to it dies with `TypeError: Failed to fetch` (CORS).
- `discoverApiEndpoints` lists the endpoints but shows **no** request bodies for
  them -- the client issues them from a worker, so nothing is recorded to replay.
  Use the recipe above rather than hunting for an `observed: POST` annotation.
- On Enterprise Grid `localConfig_v2.teams` holds several workspaces and the
  permalink's hostname does **not** identify the right one (its subdomain often
  belongs to a different workspace than the channel); that is why `api()` loops
  over the tokens and keeps the first `ok` response.
- Read-only. Do not post, react, or mark channels read through the API. If the
  task is to send a message, do it in the UI and verify it appears.
