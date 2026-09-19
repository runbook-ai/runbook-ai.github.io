---
name: google-drive-web
description: Google Drive web (drive.google.com) -- list folder contents from the DOM (file rows are real DOM with the file id in data-id), and build per-user activity timelines (e.g. hour-by-hour) across a whole folder by combining the listing with per-file edit history from the revisions/tiles recipe in the google-docs-web skill.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["drive.google.com"]
    autoload: false
    tags: [site, google, drive, revisions, activity]
    tested: 2026-09-16
---

## Listing a folder: the DOM is real

Unlike the Docs/Sheets editors, the Drive file list is ordinary DOM. A
folder's URL is `drive.google.com/drive/folders/<FOLDER_ID>` (also
`/drive/my-drive`, `/drive/shared-with-me`, `/drive/trash`). Each file row
is a `tr[data-id]` (list view) or `[role=listitem][data-id]` (grid view),
and `data-id` IS the file id. From `evalJavaScript` on the folder's tab:

```js
[...document.querySelectorAll('tr[data-id], [role="listitem"][data-id]')]
  .map(e => ({ id: e.getAttribute('data-id'),
               lines: e.innerText.split('\n').filter(Boolean).slice(0, 3) }))
```

The first lines give name/owner/date; the row also contains the type as
text ("Google Docs", "Google Sheets", "Folder"). Rows only render text in
the ACTIVE tab -- a backgrounded Drive tab returns ids with empty text, so
read the folder from the tab you are on. Long listings virtualize:
scroll the file list to mount more rows and re-collect. Recurse into
subfolders by navigating to their `/drive/folders/<id>` URL.
`https://drive.google.com/open?id=<FILE_ID>` redirects to the right editor
when the type is unknown. Drive search understands
`drive.google.com/drive/search?q=type:document` (results include a
Location column); note new files can lag content search by hours.

## Per-user activity timeline for a folder

Per-file edit history (exact revision timestamps + editor display names
for any Google Doc/Sheet/Slide) comes from the docs.google.com
revisions/tiles endpoint -- load the `google-docs-web` skill for that
recipe. Then:

1. List the folder's files from the DOM (above); note each id and type.
2. Get one token, then `downloadFile` the tiles URL for each file.
3. `readTextFile` each, then aggregate: bucket every `tileInfo` entry by
   `Math.floor(endMillis / 3600000)` (hour), count per `userMap` name, and
   present hour-by-hour per user. `endMillis` is UTC -- convert to the
   user's timezone when presenting. Mind the granularity caveat in the
   tiles recipe: old history is consolidated into coarser batches.

## What does NOT work

- The details-pane "Activity" tab (select a file, "View details") as an
  edit-history source -- it is the coarse Drive activity feed (created /
  moved / renamed, edits consolidated per session), not per-revision
  history. Use revisions/tiles from the `google-docs-web` skill.

- `evalJavaScript` fetch on drive.google.com or docs.google.com tabs --
  page CSP blocks it ("Failed to fetch"). Use `downloadFile`.
- Replaying Drive's own listing/search API calls from
  `discoverApiEndpoints` -- JSPB positional protobuf; the DOM listing is
  the reliable path.
- Reading file rows from a backgrounded Drive tab -- text comes back
  empty; keep the Drive tab active while reading.
