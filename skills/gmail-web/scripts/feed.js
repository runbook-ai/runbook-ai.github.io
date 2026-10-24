// Gmail's Atom feed: cookie-authenticated, clean XML, UNREAD mail only.
// Runs on any mail.google.com tab.

/** Unread messages from the Atom feed, newest first. label scopes it (e.g. 'unread', 'important', a user label); account is the /u/N index. summary is a snippet, not the body. -> {count, entries: [{title, summary, from, email, issued, link}]} */
async function unreadMail({ label = '', account } = {}) {
    const base = account != null ? `https://mail.google.com/mail/u/${account}/feed/atom` : 'https://mail.google.com/mail/feed/atom';
    const url = label ? `${base}/${encodeURIComponent(label)}` : base;
    // Gmail enforces Trusted Types, so DOMParser.parseFromString throws;
    // XHR's responseXML parses without a string-to-DOM sink.
    const doc = await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('GET', url);
        x.withCredentials = true;
        x.overrideMimeType('text/xml');
        x.onload = () => (x.status === 200 ? resolve(x.responseXML) : reject(new Error(`GET ${url} -> HTTP ${x.status}`)));
        x.onerror = () => reject(new Error(`GET ${url} failed`));
        x.send();
    });
    if (!doc || doc.querySelector('parsererror')) throw new Error('feed is not XML -- is this tab signed in to Gmail?');
    const text = (e, sel) => e.querySelector(sel)?.textContent ?? null;
    const entries = [...doc.querySelectorAll('entry')].map(e => ({
        title: text(e, 'title'),
        summary: text(e, 'summary'),
        from: text(e, 'author > name'),
        email: text(e, 'author > email'),
        issued: text(e, 'issued'),
        link: e.querySelector('link')?.getAttribute('href') ?? null,
    }));
    return { count: Number(text(doc, 'fullcount') ?? entries.length), entries };
}
