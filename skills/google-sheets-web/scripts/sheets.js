// Google Sheets editor helpers. The grid is a canvas; cells are written by
// jumping the selection with the name box and dispatching a synthetic TSV
// paste. In-page fetch of export/gviz URLs is blocked by CSP: the *Url
// functions build URLs for downloadFile instead.

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sheetId() {
    const m = /\/spreadsheets\/d\/([\w-]+)/.exec(location.pathname);
    if (!m) throw new Error('this tab is not a Google Sheets spreadsheet');
    return m[1];
}

function currentGid() {
    const m = /[#&?]gid=(\d+)/.exec(location.href);
    return m ? m[1] : '0';
}

async function jump(ref) {
    const nb = document.getElementById('t-name-box');
    if (!nb) throw new Error('no #t-name-box -- is the spreadsheet open in edit mode?');
    nb.focus();
    nb.value = ref;
    nb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(600); // focus returns to the grid editor
}

/** Names of the spreadsheet's sheet tabs, in order. -> [name] */
async function sheetTabs() {
    return [...document.querySelectorAll('.docs-sheet-tab-name')].map(e => e.textContent);
}

/** CSV export URL of one sheet for downloadFile (then readTextFile). gid defaults to the active tab; spreadsheetId to this spreadsheet. Formulas come back as computed values. -> url string */
async function csvUrl({ gid, spreadsheetId } = {}) {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId || sheetId()}/export?format=csv&gid=${gid ?? currentGid()}`;
}

/** gviz query URL for downloadFile: sheet NAME plus an optional SQL-ish query filtered server-side (columns are letters, strings in single quotes), e.g. "select B, C where C is not null". -> url string */
async function queryUrl({ sheet, query, spreadsheetId } = {}) {
    let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId || sheetId()}/gviz/tq?tqx=out:csv`;
    if (sheet) url += `&sheet=${encodeURIComponent(sheet)}`;
    if (query) url += `&tq=${encodeURIComponent(query)}`;
    return url;
}

/** Write a block of cells anchored at ref (e.g. 'B3') on the active sheet. values: a TSV string or a 2-D array of rows. Formulas (=SUM(...)) compute; numbers parse as numbers. -> {anchor, rows, cols} */
async function writeCells({ ref, values } = {}) {
    if (!ref) throw new Error('ref (anchor cell, e.g. "B3") is required');
    const tsv = Array.isArray(values)
        ? values.map(row => (Array.isArray(row) ? row : [row]).map(v => String(v ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n')
        : String(values ?? '');
    await jump(ref);
    const dt = new DataTransfer();
    dt.setData('text/plain', tsv);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(800);
    const rows = tsv.split('\n');
    return { anchor: ref, rows: rows.length, cols: Math.max(...rows.map(r => r.split('\t').length)) };
}

/** Clear a range on the active sheet, e.g. 'E1:E10'. -> {cleared: range} */
async function clearCells({ range } = {}) {
    if (!range) throw new Error('range (e.g. "E1:E10") is required');
    await jump(range);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, which: 46, bubbles: true, cancelable: true }));
    await sleep(500);
    return { cleared: range };
}
