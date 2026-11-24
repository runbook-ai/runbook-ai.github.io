// AES-GCM helpers shared by the runbook page (desktop) and camera.html (phone).
// The key travels only in the QR link's #fragment, never to a server.

const subtle = () => globalThis.crypto.subtle;

export function b64urlEncode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Random id, base64url. 16 bytes -> 22 chars. */
export function randomId(bytes = 16) {
  return b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** New AES-GCM-256 key. Returns { key: CryptoKey, raw: base64url }. */
export async function newKey() {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await subtle().exportKey('raw', key));
  return { key, raw: b64urlEncode(raw) };
}

export async function importKey(rawB64url) {
  const raw = b64urlDecode(rawB64url);
  if (raw.length !== 32) throw new Error('bad-key');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt bytes. Returns { iv, data } as base64url strings. */
export async function encryptBytes(key, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: b64urlEncode(iv), data: b64urlEncode(ct) };
}

/** Decrypt { iv, data } (base64url). Throws if tampered or wrong key. */
export async function decryptBytes(key, { iv, data }) {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, key, b64urlDecode(data));
  return new Uint8Array(pt);
}

/** Relay base URL, derived from the page's own origin (never from a link). */
export function relayBase(loc = globalThis.location) {
  const host = loc?.hostname || '';
  if (host === 'runbookai.net' || host.endsWith('.runbookai.net') || host === 'runbook-ai.github.io') {
    return 'https://proxy.runbookai.net';
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8082`;
  }
  return 'https://proxy.runbookai.net';
}
