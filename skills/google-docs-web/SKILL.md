---
name: google-docs-web
description: Reading and editing Google Docs documents (docs.google.com/document/...) -- the editor is a canvas, so page HTML shows no document text; read via the cookie-authenticated export endpoint with downloadFile, write by dispatching synthetic paste/keyboard events to the hidden text-event iframe with evalJavaScript.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["docs.google.com"]
    autoload: false
    tags: [site, google, docs, documents]
    tested: 2026-09-10
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
any doc the account can view:

```
https://docs.google.com/document/d/<ID>/export?format=txt
```

Formats: `txt` (plain text), `md` (markdown -- keeps headings/lists/links),
`html`, `pdf`, `docx`. Use `downloadFile` on that URL, then `readTextFile`
(the tool result states the saved file name). In-page `fetch` of export
URLs is blocked by the page's CSP -- `evalJavaScript` fetch will fail with
"Failed to fetch"; `downloadFile` is the working path.

## Writing: synthetic events to the hidden iframe

All Docs keyboard input lands in a hidden same-origin iframe
(`.docs-texteventtarget-iframe`). Synthetic (untrusted) events dispatched
to it are processed normally. From `evalJavaScript` on the doc's tab:

```js
const d = document.querySelector('.docs-texteventtarget-iframe').contentDocument;
const t = d.activeElement || d.body;
const key = (k, code, mods={}) => t.dispatchEvent(new KeyboardEvent('keydown',
  {key: k, keyCode: code, which: code, ctrlKey: !!mods.ctrl, bubbles: true, cancelable: true}));
// Position the cursor first:
key('End', 35, {ctrl: true});   // end of doc (append)
// key('Home', 36, {ctrl: true}) // start of doc
// key('a', 65, {ctrl: true})    // select all (paste then REPLACES everything)
await new Promise(r => setTimeout(r, 500));
// Insert text at the cursor (replaces the selection if any):
const dt = new DataTransfer();
dt.setData('text/plain', 'Text to insert.\nNewlines become new lines.');
t.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
return 'pasted';
```

- Saving is automatic; wait ~2s, then verify by re-downloading
  `export?format=txt` and checking the text is there. Report success only
  after that check.
- The paste is plain text: a Ctrl+A full replacement erases the document's
  images and formatting. Use it for docs that are plain text anyway or that
  you just wrote; for a targeted edit in a formatted doc, prefer appending,
  or tell the user the edit needs manual formatting.
- Targeted replacement recipe: downloadFile the `txt` export, build the
  corrected full text, then Ctrl+A + paste it. There is no reliable way to
  place the cursor at an arbitrary phrase.

## What does NOT work

- Reading the doc from the DOM or `readText` -- the text is canvas-only.
- `evalJavaScript` fetch of export/API URLs from the docs tab -- CSP blocks
  it ("Failed to fetch"). Use `downloadFile`.
- Replaying the editor's internal `/save` endpoints from
  `discoverApiEndpoints` -- the payload is JSPB (positional protobuf JSON)
  with revision tokens; a partial decode cannot be trusted. Do not spend
  turns on it.
