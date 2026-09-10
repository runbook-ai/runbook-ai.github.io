---
name: google-sheets-web
description: Reading and editing Google Sheets spreadsheets (docs.google.com/spreadsheets/...) -- the grid is a canvas, so page HTML shows no cell data; read via the cookie-authenticated CSV export or gviz query with downloadFile, write cells by driving the name box and pasting TSV with evalJavaScript.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["docs.google.com"]
    autoload: false
    tags: [site, google, sheets, spreadsheet]
    tested: 2026-09-10
---

The spreadsheet id is in the URL: `docs.google.com/spreadsheets/d/<ID>/edit?gid=<GID>`;
`gid` identifies the active sheet (tab). A new empty spreadsheet: navigate
to `https://sheets.new`. Sheet tabs ARE real DOM: enumerate names with
`evalJavaScript`: `[...document.querySelectorAll('.docs-sheet-tab-name')].map(e => e.textContent)`,
and click a tab (it is in the simplified HTML) to switch -- the URL's `gid`
updates.

## Reading: export/gviz endpoints, NOT the page

The grid paints onto a canvas: the simplified HTML contains no cell values,
so never try to read cells from the DOM or scroll the grid to "see" data.
Two cookie-authenticated endpoints return sheet data for any spreadsheet
the account can view -- use `downloadFile` on them, then `readTextFile`
(in-page `fetch` of these URLs is blocked by the page's CSP and fails):

```
https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>
https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&sheet=<SheetName>
```

- The first is the raw sheet as CSV (formulas come back as computed values).
- The gviz form takes a sheet NAME (no gid needed) and an optional SQL-ish
  query, URL-encoded in `tq`, that filters/projects server-side, e.g.
  `&tq=select%20B,C%20where%20C%20is%20not%20null`. Columns are letters,
  strings in single quotes. Use a query instead of downloading a huge sheet.

## Writing cells: name box + TSV paste

Drive the grid from `evalJavaScript` on the spreadsheet's tab: jump the
selection with the name box (a real input, id `t-name-box`), then dispatch
a synthetic paste to the focused grid editor. Untrusted events are
processed normally.

```js
const nb = document.getElementById('t-name-box');
const jump = async (ref) => {           // 'B3', or a range 'A1:C10'
  nb.focus(); nb.value = ref;
  nb.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
  await new Promise(r => setTimeout(r, 600));  // focus returns to the grid editor
};
const paste = async (tsv) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', tsv);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  await new Promise(r => setTimeout(r, 800));
};
await jump('B3');
await paste('alpha\t42\nbeta\t7');   // TSV: tabs = next column, newlines = next row
return 'pasted';
```

- The paste fills a rectangular block anchored at the selected cell --
  build one TSV string for the whole update instead of one call per cell.
- Formulas work: paste `=SUM(C3:C4)` into a cell and it computes. Numbers
  are parsed as numbers.
- Clear cells: `await jump('E1:E10')` then dispatch a Delete keydown to
  `document.activeElement` (`{key:'Delete', keyCode:46, which:46, bubbles:true, cancelable:true}`).
- Appending rows: read the CSV export first to learn the last used row,
  then jump to the first empty row and paste there.
- Saving is automatic; wait ~2s, then verify by re-downloading the CSV
  export and checking the new values. Report success only after that check.

## What does NOT work

- Reading cells from the DOM, `readText`, or scrolling the grid -- the
  grid is canvas-only. (The formula bar shows only the one active cell.)
- `evalJavaScript` fetch of export/gviz URLs from the sheet's tab -- CSP
  blocks it ("Failed to fetch"). Use `downloadFile`.
- Replaying the app's internal `/save` endpoints from
  `discoverApiEndpoints` -- JSPB positional protobuf with revision tokens;
  do not spend turns on it.
