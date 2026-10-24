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
to `https://sheets.new`. Sheet tabs ARE real DOM: list their names with
`skills.googleSheetsWeb.sheetTabs()` and click a tab (it is in the
simplified HTML) to switch -- the URL's `gid` updates.

Edit/version history (who edited, exactly when): load the
`google-docs-web` skill for the revisions/tiles recipe -- the same
endpoint serves spreadsheets via the `/spreadsheets/` path.

## Reading: export/gviz endpoints, NOT the page

The grid paints onto a canvas: the simplified HTML contains no cell values,
so never try to read cells from the DOM or scroll the grid to "see" data.
Two cookie-authenticated endpoints return sheet data for any spreadsheet
the account can view -- `downloadFile` the URL, then `readTextFile`
(in-page `fetch` of these URLs is blocked by the page's CSP and fails):

- `skills.googleSheetsWeb.csvUrl({gid})` -- the raw sheet as CSV (formulas
  come back as computed values); `gid` defaults to the active tab.
- `skills.googleSheetsWeb.queryUrl({sheet, query})` -- takes a sheet NAME
  and an optional SQL-ish query that filters/projects server-side, e.g.
  `query: "select B, C where C is not null"`. Columns are letters, strings
  in single quotes. Use a query instead of downloading a huge sheet.

## Writing cells: name box + TSV paste

Drive the grid from `evalJavaScript` on the spreadsheet's tab:
`skills.googleSheetsWeb.writeCells({ref: 'B3', values: [['alpha', 42], ['beta', 7]]})`
jumps the selection with the name box (id `t-name-box`) and pastes the
block as TSV (`values` may also be a TSV string). Untrusted events are
processed normally.

- The paste fills a rectangular block anchored at `ref` -- write the whole
  update in one call instead of one call per cell.
- Formulas work: a value `=SUM(C3:C4)` computes. Numbers are parsed as
  numbers.
- Clear cells: `skills.googleSheetsWeb.clearCells({range: 'E1:E10'})`.
- Appending rows: read the CSV export first to learn the last used row,
  then `writeCells` at the first empty row.
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
