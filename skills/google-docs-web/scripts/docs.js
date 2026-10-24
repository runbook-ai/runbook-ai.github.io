// Google Docs editor helpers. The editor paints onto a canvas; keyboard
// input goes to a hidden same-origin iframe that accepts synthetic events.
// In-page fetch of docs.google.com export / revisions URLs is blocked by
// CSP: the *Url functions build URLs for downloadFile instead.

const sleep = ms => new Promise(r => setTimeout(r, ms));

function currentFile() {
    const m = /\/(document|spreadsheets|presentation)\/d\/([\w-]+)/.exec(location.pathname);
    return m ? { type: m[1], id: m[2] } : null;
}

/** Export URL for downloadFile. docId defaults to the open doc; format: txt, md, html, pdf, docx. -> url */
async function exportUrl({ docId, format = 'txt' } = {}) {
    const id = docId || currentFile()?.id;
    if (!id) throw new Error('no docId given and this tab is not a Google Doc');
    return `https://docs.google.com/document/d/${id}/export?format=${encodeURIComponent(format)}`;
}

/** Paste plain text into the open doc. at: 'end' | 'start' | 'replace' (select all first). -> 'pasted' */
async function insertText({ text, at = 'end' } = {}) {
    const frame = document.querySelector('.docs-texteventtarget-iframe');
    if (!frame) throw new Error('no .docs-texteventtarget-iframe -- is a Google Doc open in edit mode?');
    const d = frame.contentDocument;
    const t = d.activeElement || d.body;
    const key = (k, code, ctrl) => t.dispatchEvent(new KeyboardEvent('keydown',
        { key: k, keyCode: code, which: code, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    if (at === 'end') key('End', 35, true);
    else if (at === 'start') key('Home', 36, true);
    else if (at === 'replace') key('a', 65, true);
    else throw new Error(`at must be 'end', 'start' or 'replace', got "${at}"`);
    await sleep(500);
    const dt = new DataTransfer();
    dt.setData('text/plain', String(text ?? ''));
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'pasted';
}

/** revisions/tiles URL for downloadFile; run on an open editor tab (reads its token). fileId/type default to the open file. -> url */
async function revisionsUrl({ fileId, type } = {}) {
    const info = window._docs_flag_initialData?.info_params;
    if (!info?.token) throw new Error('no _docs_flag_initialData.info_params token -- run this on an open Docs/Sheets/Slides editor tab');
    const cur = currentFile();
    const id = fileId || cur?.id;
    const kind = type || (fileId ? 'document' : cur?.type) || 'document';
    if (!id) throw new Error('no fileId given and this tab is not a Docs/Sheets/Slides file');
    return `https://docs.google.com/${kind}/d/${id}/revisions/tiles?id=${id}&start=1&revisionBatchSize=1500` +
        `&showDetailedRevisions=true&loadType=0&token=${encodeURIComponent(info.token)}&ouid=${encodeURIComponent(info.ouid || '')}&includes_info_params=true`;
}

/** Parse a downloaded revisions/tiles text (e.g. files['json.txt']). Times UTC ISO. -> {revisions: [{time, users}], editors} */
async function parseRevisions(text) {
    const s = String(text || '');
    const at = s.indexOf('{');
    if (!s.trimStart().startsWith(")]}'") || at < 0) throw new Error('not a revisions/tiles response (HTML instead of )]}\'-JSON?) -- the token was missing or stale; rebuild the URL with revisionsUrl');
    const j = JSON.parse(s.slice(at));
    const names = Object.fromEntries(Object.entries(j.userMap || {}).map(([id, u]) => [id, u.name || (u.anonymous ? 'Anonymous' : id)]));
    const revisions = (j.tileInfo || []).map(t => ({
        time: new Date(t.endMillis).toISOString(),
        users: (t.users || []).map(u => names[u] || u),
    }));
    return { revisions, editors: [...new Set(Object.values(names))] };
}
