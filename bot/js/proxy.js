import { PROXY_URL } from './settings.js';

const MAX_RETRIES = 3;
const RETRY_STATUSES = new Set([502, 503, 504]);

/**
 * Fetch through the CORS proxy with retry for transient errors.
 * Retries up to 3 times on 502/503/504 and network errors with exponential backoff.
 */
export async function proxyFetch(targetUrl, opts = {}) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, opts);
      if (RETRY_STATUSES.has(resp.status) && attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}
