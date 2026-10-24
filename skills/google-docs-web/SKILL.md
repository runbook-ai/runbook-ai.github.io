---
name: google-docs-web
description: Reading and editing Google Docs documents (docs.google.com/document/...) -- the editor is a canvas, so page HTML shows no document text; read via the cookie-authenticated export endpoint with downloadFile, write by dispatching synthetic paste/keyboard events to the hidden text-event iframe with evalJavaScript. Also covers edit/version history for any Google Doc, Sheet or Slide via the revisions/tiles endpoint (exact revision timestamps + editor names).
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["docs.google.com"]
    autoload: false
    tags: [site, google, docs, documents, revisions]
    tested: 2026-09-16
---

The document id is in the URL: `docs.google.com/document/d/<ID>/edit`.
A new empty document: navigate to `https://docs.new` (the URL then carries
the new id). The title is a real DOM input (`.docs-title-input`) -- use
`typeText` on it.

## Reading: export endpoint, NOT the page

The editor paints onto a canvas. The simplified HTML contains no document
text, and `readText` on anything in the page returns UI chrome at best --
do not try to read the document from the DOM, and do not screenshot-read
more than one screen.

Read via the export endpoint, which answers with the session cookies for
any doc the account can view: `downloadFile` the URL from
`skills.googleDocsWeb.exportUrl({format: 'txt'})` (or `{docId, format}` for
another doc), then `readTextFile` (the tool result states the saved file
name). Formats: `txt` (plain text), `md` (markdown -- keeps
headings/lists/links), `html`, `pdf`, `docx`. In-page `fetch` of export
URLs is blocked by the page's CSP -- `evalJavaScript` fetch fails with
"Failed to fetch"; `downloadFile` is the working path.

## Writing: synthetic events to the hidden iframe

All Docs keyboard input lands in a hidden same-origin iframe
(`.docs-texteventtarget-iframe`); synthetic (untrusted) events dispatched
to it are processed normally. From `evalJavaScript` on the doc's tab:
`skills.googleDocsWeb.insertText({text, at: 'end'})` appends; `at: 'start'`
inserts at the top; `at: 'replace'` selects all first, so the paste
REPLACES everything.

- Saving is automatic; wait ~2s, then verify by re-downloading the `txt`
  export. Report success only after that check.
- The paste is plain text: a Ctrl+A full replacement erases the document's
  images and formatting. Use it for docs that are plain text anyway or that
  you just wrote; for a targeted edit in a formatted doc, prefer appending,
  or tell the user the edit needs manual formatting.
- Targeted replacement recipe: downloadFile the `txt` export, build the
  corrected full text, then `insertText({text, at: 'replace'})`. There is no reliable way to
  place the cursor at an arbitrary phrase.

## Edit history of a Doc/Sheet/Slide: revisions/tiles

The version-history data (who edited, exactly when) comes from an internal
but plain-JSON endpoint. It works for Docs, Sheets AND Slides -- only the
path segment differs. It needs a session token:

1. On any OPEN Docs/Sheets/Slides editor tab (e.g. the file itself), build
   the URL with `skills.googleDocsWeb.revisionsUrl({fileId, type})` --
   `type` is `document`, `spreadsheets` or `presentation`; both default to
   the open file. It reads the session token from that tab; ONE token works
   for every file of every editor type in the session.
2. `downloadFile` that URL (in-page fetch is blocked by CSP; downloadFile
   sends the session cookies). The response saves as `json.txt`
   (collisions get -2/-3 suffixes; the tool result states the exact name).
3. Parse it in code instead of reading it: evalJavaScript with
   `inputFiles: ["json.txt"]` and
   `skills.googleDocsWeb.parseRevisions(files["json.txt"])` ->
   `{revisions: [{time, users}], editors}`.

Editor names are display names only -- email addresses are NOT in the
data; never guess or invent one when reporting.

If parseRevisions says the body is HTML, the token was missing or stale:
rebuild the URL with revisionsUrl on an open editor tab and retry.

Granularity caveat: Google consolidates revisions server-side.
`showDetailedRevisions=true` returns the finest granularity kept -- dense
for recent activity, but edits from long ago are merged into coarser
batches, so fine-grained timelines are reliable for recent days and
approximate for old history. Say so when reporting old ranges.

For activity timelines across a whole Drive folder, see the
`google-drive-web` skill (folder listing + aggregation recipe).

## What does NOT work

- Reading the doc from the DOM or `readText` -- the text is canvas-only.
- The revisions/tiles URL without `token`/`ouid` -- returns an HTML shell,
  not JSON.
- `evalJavaScript` fetch of export/API URLs from the docs tab -- CSP blocks
  it ("Failed to fetch"). Use `downloadFile`.
- Replaying the editor's internal `/save` endpoints from
  `discoverApiEndpoints` -- the payload is JSPB (positional protobuf JSON)
  with revision tokens; a partial decode cannot be trusted. Do not spend
  turns on it.
