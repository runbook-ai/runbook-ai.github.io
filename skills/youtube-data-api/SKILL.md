---
name: youtube-data-api
description: Bulk-read YouTube search results, playlists, comments, video metadata and transcripts via the page's own innertube API from evalJavaScript; covers the signatureTimestamp and per-video token traps.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["*.youtube.com", "youtu.be"]
    autoload: true
    tags: [site, api, video, transcripts]
    tested: 2026-08-28
---

## When to use
Any bulk read on youtube.com: search results, playlist items, comments,
video metadata, transcripts. Everything below runs from `evalJavaScript` on
any youtube.com page (the logged-in cookies are sent automatically). Do ALL
the calls a task needs in ONE expression and use `saveToFile` for the
result -- never one endpoint probe per turn.

## Setup (reuse in every expression)
```js
const cfg = ytcfg.data_, key = cfg.INNERTUBE_API_KEY, ctx = cfg.INNERTUBE_CONTEXT;
const yt = (ep, body) => fetch(`/youtubei/v1/${ep}?key=${key}&prettyPrint=false`, {
  method: 'POST', credentials: 'include', headers: {'content-type': 'application/json'},
  body: JSON.stringify({ context: ctx, ...body }) }).then(r => r.json());
const walk = (o, key, out = []) => { if (o && typeof o === 'object') { if (o[key]) out.push(o[key]); for (const k in o) walk(o[k], key, out); } return out; };
```

## Recipes
- **Search**: `yt('search', {query})` → `walk(res, 'videoRenderer')` →
  `{videoId, title: v.title.runs[0].text, channel: v.ownerText.runs[0].text}`. 20 per page; more via `walk(res, 'continuationCommand')[0].token` → `yt('search', {continuation: token})`.
- **Playlist**: `yt('browse', {browseId: 'VL' + playlistId})` → items are
  `walk(res, 'lockupViewModel').map(x => x.contentId)` (NOT `playlistVideoRenderer`, that key is gone). Title in `res.metadata.playlistMetadataRenderer.title`.
- **Metadata**: `yt('player', {videoId, playbackContext: {contentPlaybackContext: {signatureTimestamp: cfg.STS}}})` → `res.videoDetails` (title, author, lengthSeconds, viewCount, shortDescription, keywords). TRAP: without `signatureTimestamp` the call returns `playabilityStatus.status === 'UNPLAYABLE'` with no captions; that is not an error with the video.
- **Comments**: `yt('next', {videoId})` → the comment continuation token is `walk(res, 'continuationItemRenderer').find(...)` under the section whose `sectionIdentifier === 'comment-item-section'` (`res.contents.twoColumnWatchNextResults.results.results.contents`) → `yt('next', {continuation: token})` → `walk(res, 'commentEntityPayload')` → `{author: c.author.displayName, text: c.properties.content.content, likes: c.toolbar.likeCountNotliked}`; repeat with the next `continuationCommand.token` (20 per page).
- **Transcripts**: caption `baseUrl`s from `/player` return an EMPTY 200 body without a per-video BotGuard `pot` token, and `/youtubei/v1/get_transcript` needs a per-video attestation -- neither can be minted from a script. The only bulk route is the page's own player, which requests captions (with the token) only while it is PLAYING with SUBTITLES ON. Open ONE watch page (any of the videos), then run this whole loop in one expression -- do not probe endpoints one call per turn:
  ```js
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Capture caption requests at the source (fetch + XHR); Resource Timing misses cached ones.
  if (!window.__ytTT) { window.__ytTT = [];
    const of = window.fetch; window.fetch = function (i, o) { const u = typeof i === 'string' ? i : i.url; if (/timedtext/.test(u)) window.__ytTT.push(u); return of.apply(this, arguments); };
    const oo = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { if (/timedtext/.test(String(u))) window.__ytTT.push(String(u)); return oo.apply(this, arguments); }; }
  const player = document.querySelector('#movie_player');
  player.playVideo(); await wait(1000);
  const cc = document.querySelector('.ytp-subtitles-button');            // the CC button; player.toggleSubtitlesOn() does NOT work
  if (cc && cc.getAttribute('aria-pressed') !== 'true') { cc.click(); await wait(2000); }
  const out = [];
  for (const id of ids) {
    const seen = window.__ytTT.length; player.loadVideoById(id); let u = null;
    for (let i = 0; i < 30 && !u; i++) { await wait(500); u = window.__ytTT.slice(seen).find(x => x.includes('v=' + id) && /pot=/.test(x)); }
    if (!u) { out.push({videoId: id, error: 'no caption request seen'}); continue; }
    const url = new URL(u, location.href); url.searchParams.set('fmt', 'json3');
    const j = await fetch(url, {credentials: 'include'}).then(r => r.json());
    out.push({videoId: id, title: player.getVideoData().title, lang: url.searchParams.get('lang'),
      lines: (j.events || []).filter(x => x.segs).map(x => ({t: Math.round(x.tStartMs / 1000), text: x.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim()}))});
  }
  player.pauseVideo(); return out;
  ```
  ~1-2 s per video. If every entry says "no caption request seen", subtitles did not turn on: re-run once (the CC click needs the player to be playing); do not switch to `/player` caption URLs or `get_transcript` -- they cannot work. Run it with `saveToFile`: the save response already reports the item count and a snippet, so report from that -- do not re-read the file with readTextFile to count lines.

## Limits
- Video/audio bytes are NOT obtainable from the page (signature cipher, `n` throttling, per-video `pot`, and YouTube's terms). If the task asks for a download, say so and stop; do not try `videoplayback` URLs.
- `num_to_fetch`-style paging does not exist; continuation tokens are the only paging.
- Do not add `headers: {'x-youtube-client-version': ...}` etc. -- the defaults above work; extra headers only add ways to fail.
