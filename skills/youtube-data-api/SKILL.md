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
video metadata, transcripts. The functions below call the page's own
innertube API from `evalJavaScript` on any youtube.com page (the logged-in
cookies are sent automatically), e.g.

    skills.youtubeDataApi.search({query: 'lofi', pages: 2})

Do ALL the calls a task needs in ONE expression (an async IIFE awaiting
several functions) and use `saveToFile` for the result -- never one
endpoint probe per turn.

## Recipes
- **Search**: `search({query, pages})` -- ~20 videos per page.
- **Playlist**: `playlist({playlistId})` -> `{title, videoIds}`.
- **Metadata**: `videoInfo({videoIds})` -- it passes `signatureTimestamp`;
  a raw `/player` call without it returns `UNPLAYABLE` with no captions,
  which is not an error with the video.
- **Comments**: `comments({videoId, pages})` -- top-level comments, ~20
  per page.
- **Transcripts**: caption `baseUrl`s from `/player` return an EMPTY 200
  body without a per-video BotGuard `pot` token, and
  `/youtubei/v1/get_transcript` needs a per-video attestation -- neither can
  be minted from a script. The only bulk route is the page's own player,
  which requests captions (with the token) only while it is PLAYING with
  SUBTITLES ON. Open ONE watch page (any of the videos), then run
  `transcripts({videoIds})` once for all of them, with `saveToFile`. If
  every entry says "no caption request seen", subtitles did not turn on:
  re-run once (the CC click needs the player to be playing); do not switch
  to `/player` caption URLs or `get_transcript` -- they cannot work. The
  save response already reports the item count and a snippet, so report
  from that -- do not re-read the file with readTextFile to count lines.
- **Anything else**: `innertube(endpoint, body)` and `findAll(obj, key)`
  are the building blocks the functions use.

## Limits
- Video/audio bytes are NOT obtainable from the page (signature cipher, `n` throttling, per-video `pot`, and YouTube's terms). If the task asks for a download, say so and stop; do not try `videoplayback` URLs.
- `num_to_fetch`-style paging does not exist; continuation tokens are the only paging.
- Do not add `headers: {'x-youtube-client-version': ...}` etc. to innertube calls -- the defaults work; extra headers only add ways to fail.
