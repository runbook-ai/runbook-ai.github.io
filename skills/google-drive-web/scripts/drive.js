// Google Drive web helpers. The file list is real DOM (rows carry the file
// id in data-id); edit history comes from downloaded revisions/tiles
// responses (google-docs-web skill).

/** Files of the folder in this (active) tab, from the DOM rows mounted now. -> [{id, name, type, lines}] */
async function listFolder() {
    const rows = [...document.querySelectorAll('tr[data-id], [role="listitem"][data-id]')];
    const types = /Google (Docs|Sheets|Slides|Forms|Drawings)|Folder|PDF|Image|Video|Microsoft \w+|Shortcut/;
    const seen = new Set();
    const out = [];
    for (const e of rows) {
        const id = e.getAttribute('data-id');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const lines = e.innerText.split('\n').map(x => x.trim()).filter(Boolean);
        const typeHit = types.exec(e.innerText) || types.exec(e.querySelector('[aria-label]')?.getAttribute('aria-label') || '');
        out.push({ id, name: lines[0] || null, type: typeHit ? typeHit[0] : null, lines: lines.slice(0, 4) });
    }
    return out;
}

function parseTiles(text) {
    const s = String(text || '');
    const at = s.indexOf('{');
    if (!s.trimStart().startsWith(")]}'") || at < 0) return null;
    return JSON.parse(s.slice(at));
}

/** Edit counts per editor per hour/day across files: {label: revisions/tiles text} (e.g. the inputFiles `files`); timeZone IANA, default the browser's. -> {timeZone, buckets: [{bucket, users: {name: n}, files}], skipped} */
async function activityTimeline({ files, by = 'hour', timeZone } = {}) {
    const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        ...(by === 'day' ? {} : { hour: '2-digit', hourCycle: 'h23' }),
    });
    const buckets = new Map();
    const skipped = [];
    for (const [label, text] of Object.entries(files || {})) {
        const j = parseTiles(text);
        if (!j) { skipped.push(label); continue; }
        const names = Object.fromEntries(Object.entries(j.userMap || {}).map(([id, u]) => [id, u.name || id]));
        for (const t of j.tileInfo || []) {
            const key = fmt.format(new Date(t.endMillis)) + (by === 'day' ? '' : ':00');
            if (!buckets.has(key)) buckets.set(key, { bucket: key, users: {}, files: new Set() });
            const b = buckets.get(key);
            b.files.add(label);
            for (const u of t.users || []) {
                const n = names[u] || u;
                b.users[n] = (b.users[n] || 0) + 1;
            }
        }
    }
    const out = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
        .map(b => ({ bucket: b.bucket, users: b.users, files: [...b.files] }));
    return { timeZone: tz, buckets: out, skipped };
}
