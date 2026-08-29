---
name: gmail-web
description: Reading Gmail from the web app -- its internal sync endpoints are positional protobuf and unusable from scripts; use the Atom feed for unread mail and the UI for everything else.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["mail.google.com"]
    autoload: true
    tags: [site, email, gmail]
    tested: 2026-08-28
---

## Do NOT call Gmail's internal API
`discoverApiEndpoints` on mail.google.com shows the app's real data calls,
`POST https://mail.google.com/sync/u/0/i/fd?...&rt=r&pt=ji` (100+ KB) and
`.../adsfe/main_jspb`. They answer with cookies (`["er", ...]`), but the
payload is JSPB: protobuf serialized as positional JSON arrays -- field N at
index N-1, no names, `null` for unset fields, nested arrays for nested
messages, an anti-XSSI `)]}'` prefix and length-prefixed chunk framing when
`rt=r`. The schema is Google-internal and changes with the `jsver=` build in
the URL. Requests are JSPB too and carry the mailbox's sync version tokens
(`bv`), the `ik` identity key and an xsrf token. Do not spend turns trying to
parse or replay these: `JSON.parse` will fail, and a partial decode cannot
be trusted.

## What works

**New / unread mail: the Atom feed.** Cookie-authenticated, clean XML,
fetchable from any mail.google.com tab:
```js
const xml = await fetch('https://mail.google.com/mail/feed/atom', {credentials: 'include'}).then(r => r.text());
const doc = new DOMParser().parseFromString(xml, 'application/xml');
return [...doc.querySelectorAll('entry')].map(e => ({
  title: e.querySelector('title')?.textContent,
  summary: e.querySelector('summary')?.textContent,
  from: e.querySelector('author > name')?.textContent,
  email: e.querySelector('author > email')?.textContent,
  issued: e.querySelector('issued')?.textContent,
  link: e.querySelector('link')?.getAttribute('href'),
}));
```
`https://mail.google.com/mail/feed/atom/<label>` scopes it to a label
(`/mail/feed/atom/unread`, `/mail/feed/atom/<your-label>`). Limits: UNREAD
messages only, read-only, `summary` is a snippet not the body. This is the
right tool for "watch my inbox for a reply from X" -- poll it instead of
re-reading the DOM.

**Everything else: the UI.** Search (`in:inbox from:x newer_than:2d` in
the search box, then submit), opening a thread to read the full body, reply
/ send / archive / label. Use `clickElement` / `typeText` and verify the
side effect (the sent message appears in the thread, the row leaves the
inbox) before reporting success.

**Reading a thread body**: open it, then take the text from the simplified
HTML; `readText` if it is collapsed. The message list on the left is a
virtual list -- rows scroll out of the DOM, so memorize what you need before
scrolling.

## If the task needs bulk or programmatic access
Say so: the supported path is the Gmail REST API with OAuth (outside the
browser agent), not the web app's endpoints.
