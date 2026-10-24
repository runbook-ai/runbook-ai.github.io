// YouTube's own innertube API (/youtubei/v1/*), called with the page's
// config and cookies. Runs on any youtube.com tab.

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cfg() {
    const c = window.ytcfg?.data_;
    if (!c?.INNERTUBE_API_KEY) throw new Error('ytcfg not found -- run this on a youtube.com page');
    return c;
}

/** Low-level innertube call: POST /youtubei/v1/<endpoint> with the page's client context merged into body (e.g. innertube('browse', {browseId})). Use it for anything the other functions do not cover. -> raw JSON */
async function innertube(endpoint, body = {}) {
    const c = cfg();
    const r = await fetch(`/youtubei/v1/${endpoint}?key=${c.INNERTUBE_API_KEY}&prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: c.INNERTUBE_CONTEXT, ...body }),
    });
    if (!r.ok) throw new Error(`innertube ${endpoint} -> HTTP ${r.status}`);
    return r.json();
}

/** Every value stored under `key` anywhere inside obj (depth-first), e.g. findAll(res, 'videoRenderer'). -> [value] */
async function findAll(obj, key) {
    return walk(obj, key);
}

function walk(o, key, out = []) {
    if (o && typeof o === 'object') {
        if (o[key] !== undefined) out.push(o[key]);
        for (const k in o) walk(o[k], key, out);
    }
    return out;
}

const text = t => (t ? t.simpleText ?? (t.runs || []).map(r => r.text).join('') : null);

/** Search videos; pages of ~20 results each. -> [{videoId, title, channel, views, published, length}] */
async function search({ query, pages = 1 } = {}) {
    const out = [];
    let res = await innertube('search', { query });
    for (let p = 0; p < pages; p++) {
        for (const v of walk(res, 'videoRenderer')) {
            out.push({
                videoId: v.videoId, title: text(v.title), channel: text(v.ownerText),
                views: text(v.viewCountText), published: text(v.publishedTimeText), length: text(v.lengthText),
            });
        }
        const token = walk(res, 'continuationCommand')[0]?.token;
        if (!token || p === pages - 1) break;
        res = await innertube('search', { continuation: token });
    }
    return out;
}

/** A playlist's title and video ids (first page, ~100 items). -> {title, videoIds} */
async function playlist({ playlistId } = {}) {
    const res = await innertube('browse', { browseId: 'VL' + String(playlistId).replace(/^VL/, '') });
    const ids = walk(res, 'lockupViewModel').map(x => x.contentId).filter(Boolean);
    const legacy = walk(res, 'playlistVideoRenderer').map(x => x.videoId);
    return {
        title: res.metadata?.playlistMetadataRenderer?.title ?? null,
        videoIds: [...new Set(ids.length ? ids : legacy)],
    };
}

/** Metadata of one or more videos (passes signatureTimestamp, without which /player answers UNPLAYABLE). -> [{videoId, title, author, channelId, lengthSeconds, viewCount, publishDate, shortDescription, keywords, playability}] */
async function videoInfo({ videoIds, videoId } = {}) {
    const ids = videoIds || [videoId];
    const sts = cfg().STS;
    const out = [];
    for (const id of ids) {
        const res = await innertube('player', { videoId: id, playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } } });
        const d = res.videoDetails || {};
        const micro = res.microformat?.playerMicroformatRenderer || {};
        out.push({
            videoId: id, title: d.title ?? null, author: d.author ?? null, channelId: d.channelId ?? null,
            lengthSeconds: Number(d.lengthSeconds) || null, viewCount: Number(d.viewCount) || null,
            publishDate: micro.publishDate ?? null, shortDescription: d.shortDescription ?? null,
            keywords: d.keywords || [], playability: res.playabilityStatus?.status ?? null,
        });
    }
    return out;
}

function commentPageItems(res) {
    for (const e of res.onResponseReceivedEndpoints || []) {
        const items = (e.reloadContinuationItemsCommand || e.appendContinuationItemsAction)?.continuationItems;
        if (items?.some(i => i.commentThreadRenderer)) return items;
    }
    return null;
}

/** Top-level comments of a video, ~20 per page. -> [{author, text, likes, published, replies}] */
async function comments({ videoId, pages = 1 } = {}) {
    const next = await innertube('next', { videoId });
    const sections = next.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    const section = sections.map(s => s.itemSectionRenderer).find(s => s?.sectionIdentifier === 'comment-item-section');
    let token = section && walk(section, 'continuationCommand')[0]?.token;
    if (!token) throw new Error('no comment section (comments may be turned off for this video)');
    const out = [];
    for (let p = 0; p < pages && token; p++) {
        const res = await innertube('next', { continuation: token });
        for (const c of walk(res, 'commentEntityPayload')) {
            out.push({
                author: c.author?.displayName ?? null,
                text: c.properties?.content?.content ?? null,
                likes: c.toolbar?.likeCountNotliked ?? null,
                published: c.properties?.publishedTime ?? null,
                replies: Number(c.toolbar?.replyCount) || 0,
            });
        }
        const items = commentPageItems(res) || [];
        const last = items[items.length - 1];
        token = last?.continuationItemRenderer ? walk(last, 'continuationCommand')[0]?.token : null;
    }
    return out;
}

/** Transcripts by driving the page's own player: run on ONE open watch page; it plays each video with subtitles on and captures the caption request (which carries the per-video token). ~1-2 s per video; use saveToFile for the result. -> [{videoId, title, lang, lines: [{t, text}]} | {videoId, error}] */
async function transcripts({ videoIds } = {}) {
    // Capture caption requests at the source (fetch + XHR); Resource Timing
    // misses cached ones.
    if (!window.__ytTT) {
        window.__ytTT = [];
        const of = window.fetch;
        window.fetch = function (i, o) {
            const u = typeof i === 'string' ? i : i.url;
            if (/timedtext/.test(u)) window.__ytTT.push(u);
            return of.apply(this, arguments);
        };
        const oo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (m, u) {
            if (/timedtext/.test(String(u))) window.__ytTT.push(String(u));
            return oo.apply(this, arguments);
        };
    }
    const player = document.querySelector('#movie_player');
    if (!player?.loadVideoById) throw new Error('no #movie_player -- open a youtube.com/watch page first');
    player.playVideo();
    await sleep(1000);
    // The CC button; player.toggleSubtitlesOn() does NOT work.
    const cc = document.querySelector('.ytp-subtitles-button');
    if (cc && cc.getAttribute('aria-pressed') !== 'true') { cc.click(); await sleep(2000); }
    const out = [];
    for (const id of videoIds || []) {
        const seen = window.__ytTT.length;
        player.loadVideoById(id);
        let u = null;
        for (let i = 0; i < 30 && !u; i++) {
            await sleep(500);
            u = window.__ytTT.slice(seen).find(x => x.includes('v=' + id) && /pot=/.test(x));
        }
        if (!u) { out.push({ videoId: id, error: 'no caption request seen' }); continue; }
        const url = new URL(u, location.href);
        url.searchParams.set('fmt', 'json3');
        const j = await fetch(url, { credentials: 'include' }).then(r => r.json());
        out.push({
            videoId: id, title: player.getVideoData().title, lang: url.searchParams.get('lang'),
            lines: (j.events || []).filter(x => x.segs).map(x => ({
                t: Math.round(x.tStartMs / 1000),
                text: x.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim(),
            })),
        });
    }
    player.pauseVideo();
    return out;
}
