// Desktop side of "Scan with phone": open a relay room, show a QR code for
// camera.html, decrypt photo batches as they arrive, and hand each complete
// batch to whichever file widget opened the scanner.
//
// Photos are encrypted on the phone with a key that exists only in the QR
// link's #fragment (never sent to a server); the relay forwards ciphertext and
// stores nothing. See docs/runbooks-page-overhaul-design.md §4.

import { newKey, randomId, decryptBytes, relayBase } from './crypto.js';
import { h, modal, copyText } from './dom.js';

const BATCH_TIMEOUT_MS = 2 * 60 * 1000;

class PhoneLink {
  constructor() {
    this.es = null;
    this.room = null;
    this.key = null;
    this.raw = null;
    this.state = 'idle';     // idle | connecting | ready | phone | error | expired
    this.detail = '';
    this.target = null;      // (files: File[]) => void
    this.batches = new Map();
    this.listeners = new Set();
  }

  onStatus(fn) { this.listeners.add(fn); fn(this); return () => this.listeners.delete(fn); }
  emit(state, detail = '') {
    if (state) this.state = state;
    this.detail = detail;
    for (const fn of this.listeners) fn(this);
  }

  cameraUrl() {
    const dir = location.pathname.replace(/[^/]*$/, '');
    return `${location.origin}${dir}camera.html#r=${this.room}&k=${this.raw}`;
  }

  async start() {
    if (this.es) return;
    this.room = randomId(16);
    const { key, raw } = await newKey();
    this.key = key;
    this.raw = raw;
    this.emit('connecting', 'Connecting to the relay…');
    const es = new EventSource(`${relayBase()}/relay/${this.room}/events`);
    this.es = es;
    let everReady = false;
    es.addEventListener('ready', () => { everReady = true; if (this.state !== 'phone') this.emit('ready', 'Waiting for phone…'); });
    es.addEventListener('phone', () => this.emit('phone', 'Phone connected. Shoot your photos, then tap Send all.'));
    es.addEventListener('photo', (e) => this.onPhoto(JSON.parse(e.data)).catch(err => this.emit(null, `Couldn't read a photo: ${err.message}`)));
    es.addEventListener('expired', () => { this.stop(); this.emit('expired', 'Pairing expired. Open the scanner again for a new QR code.'); });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) { this.stop(); this.emit('error', "Can't reach the phone relay. Use Add files instead, or try again later."); }
      else if (!everReady) this.emit('connecting', 'Still connecting to the relay…');
    };
  }

  async onPhoto(msg) {
    const { batch, index, count, name, type } = msg;
    let b = this.batches.get(batch);
    if (!b) {
      b = { count, files: new Map(), timer: null };
      this.batches.set(batch, b);
    }
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      this.batches.delete(batch);
      this.emit(null, `Received ${b.files.size} of ${b.count} photos — tap Send all on the phone again.`);
    }, BATCH_TIMEOUT_MS);
    const bytes = await decryptBytes(this.key, msg);
    // A retried photo (same index) replaces the earlier copy.
    b.files.set(index, new File([bytes], name || `photo-${String(index).padStart(2, '0')}.jpg`, { type: type || 'image/jpeg' }));
    if (b.files.size < b.count) {
      this.emit(null, `Receiving ${b.files.size} of ${b.count}…`);
      return;
    }
    clearTimeout(b.timer);
    this.batches.delete(batch);
    const files = [...b.files.entries()].sort((x, y) => x[0] - y[0]).map(([, f]) => f);
    if (this.target) this.target(files);
    this.emit(null, `${files.length} photo${files.length === 1 ? '' : 's'} added. Scan more on the phone, or close this window.`);
  }

  stop() {
    if (this.es) this.es.close();
    this.es = null;
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
    this.room = this.key = this.raw = null;
    this.emit('idle', '');
  }
}

export const phoneLink = new PhoneLink();

/**
 * Open the scanner modal. `onFiles(files)` receives each complete batch.
 * The pairing stays open after the modal closes; Stop ends it.
 */
export async function openScanner(label, onFiles) {
  phoneLink.target = onFiles;
  let off = () => {};
  const m = modal('Scan with your phone', { onClose: () => off() });
  const qrBox = h('div.qr-box', h('div.qr-placeholder', 'Preparing…'));
  const link = h('input.qr-link', { readOnly: true, value: '' });
  const status = h('div.scan-status', '');
  const copyBtn = h('button.btn.btn-ghost', { onclick: async () => { if (await copyText(link.value)) copyBtn.textContent = 'Copied'; } }, 'Copy link');
  const stopBtn = h('button.btn.btn-ghost', { onclick: () => { phoneLink.stop(); m.close(); } }, 'Stop pairing');
  m.body.append(
    h('p.muted', `Photos go to “${label}”. Scan this code with your phone's camera, take your photos, review them, then tap Send all.`),
    h('div.scan-grid', qrBox, h('div.scan-side',
      h('ol.scan-steps',
        h('li', 'Point your phone camera at the code and open the link.'),
        h('li', 'Tap the shutter for each page or photo.'),
        h('li', 'Review, then tap ', h('b', 'Send all'), '.')),
      status,
      h('p.fine', 'End-to-end encrypted: the key is only in this code, and photos pass through our relay without being stored.'))),
    h('div.row', link, copyBtn, stopBtn),
  );

  off = phoneLink.onStatus((pl) => {
    status.textContent = pl.detail;
    status.className = 'scan-status ' + pl.state;
    if (pl.raw && link.value !== pl.cameraUrl()) {
      link.value = pl.cameraUrl();
      qrBox.innerHTML = qrSvg(link.value);
    }
    if (pl.state === 'idle' || pl.state === 'expired' || pl.state === 'error') {
      if (pl.state !== 'idle') qrBox.innerHTML = '<div class="qr-placeholder">No active pairing</div>';
    }
  });
  try {
    await phoneLink.start();
  } catch (err) {
    status.textContent = `Couldn't start scanning: ${err.message}`;
  }
  return m;
}

function qrSvg(text) {
  // qrcode-generator (vendor/qrcode.min.js) is loaded as a classic script.
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
