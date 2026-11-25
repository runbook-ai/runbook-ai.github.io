/**
 * Runbook AI CORS Proxy
 *
 * Forwards browser requests to any upstream URL, adding CORS headers so
 * the agent page can call external APIs without exposing credentials to
 * third-party CORS proxies.
 *
 * Security: only requests from whitelisted origins are accepted.
 * All others receive 403. No upstream restrictions — origin allowlist
 * is the sole gating mechanism.
 *
 * Route:  /proxy?url=<encoded upstream URL>
 */

import http from 'node:http';
import { handleRelay } from './relay.js';

// ------------------------------------------------------------------ //
//  Configuration
// ------------------------------------------------------------------ //

const PORT = parseInt(process.env.PORT || '8082', 10);

const ALLOWED_ORIGINS = new Set([
  'http://localhost:9003',
  'https://runbookai.net',
  'https://www.runbookai.net',
  // The Runbook AI extension's side panel (phone scan via /relay). The ID is
  // fixed by the manifest key, so it's the same for store and unpacked builds.
  'chrome-extension://kjbhngehjkiiecaflccjenmoccielojj',
  // Extra origins for local development, comma-separated.
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);

// ------------------------------------------------------------------ //
//  Helpers
// ------------------------------------------------------------------ //

// Hop-by-hop headers must not be forwarded to the upstream.
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers#hop-by-hop_headers
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  // Also strip headers that belong to the proxy↔browser leg, not the proxy↔upstream leg.
  'host', 'origin', 'referer', 'cookie',
]);

function corsHeaders(origin, requestedHeaders) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    // Echo back whatever headers the browser says it wants to send so we don't
    // have to maintain a static allowlist here.
    'Access-Control-Allow-Headers': requestedHeaders || 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ //
//  Server
// ------------------------------------------------------------------ //

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';

  // ---- CORS preflight ----
  if (req.method === 'OPTIONS') {
    if (ALLOWED_ORIGINS.has(origin)) {
      const requestedHeaders = req.headers['access-control-request-headers'];
      res.writeHead(204, corsHeaders(origin, requestedHeaders));
    } else {
      res.writeHead(403);
    }
    res.end();
    return;
  }

  // ---- Phone relay: requests without an Origin header ----
  // Chrome sends no Origin on GETs from an extension page with host
  // permissions (the side panel's EventSource). The origin check adds no
  // protection to the relay -- non-browser clients can send any Origin; the
  // random room id is what keeps a room private -- so a missing Origin is
  // allowed there. A wrong Origin is still rejected below, and the CORS proxy
  // keeps the strict check.
  if (!origin && (req.url || '').startsWith('/relay/')) {
    if (handleRelay(req, res, {})) return;
  }

  // ---- Origin check ----
  if (!ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  // ---- Phone -> desktop photo relay ----
  if (handleRelay(req, res, corsHeaders(origin))) return;

  // ---- Resolve target URL from query string ----
  const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  const targetUrl = reqUrl.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    return;
  }

  // Validate it's an absolute http/https URL
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: 'Invalid target URL' }));
    return;
  }

  // ---- Forward request ----
  const body = await readBody(req);

  // Forward only application-level headers — strip all browser-generated
  // headers (sec-fetch-*, sec-ch-ua-*, accept-*, user-agent) that Discord's
  // abuse detection may flag when they arrive on a bot-token request.
  const BROWSER_ONLY = new Set([
    'user-agent', 'accept', 'accept-language', 'accept-encoding',
    'cache-control', 'pragma',
  ]);
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      !HOP_BY_HOP.has(lower) &&
      !BROWSER_ONLY.has(lower) &&
      !lower.startsWith('sec-')
    ) {
      forwardHeaders[key] = value;
    }
  }
  forwardHeaders['user-agent'] = 'runbook-ai-proxy/1.0';

  try {
    const upstream = await fetch(parsedTarget.toString(), {
      method:  req.method,
      headers: forwardHeaders,
      body:    body.length > 0 ? body : undefined,
    });

    const respBody = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      ...corsHeaders(origin),
    });
    res.end(Buffer.from(respBody));

  } catch (err) {
    console.error('[proxy] upstream error:', err.message);
    res.writeHead(502, {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    });
    res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Runbook AI CORS proxy listening on port ${PORT}`);
  console.log('Allowed origins:', [...ALLOWED_ORIGINS].join(', '));
});

server.on('error', (err) => {
  console.error('[proxy] server error:', err);
  process.exit(1);
});

