// Phone side of "Scan with phone" (camera.html).
// Viewfinder with a burst shutter -> review grid -> Send all.
// Fallback: native camera / library pickers feed the same review grid.
// Each photo is resized, encrypted with the key from the #fragment, and sent
// one by one as a batch; the runbook page adds the batch once all arrived.

import { importKey, encryptBytes, randomId, relayBase } from './crypto.js';

const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;
const MAX_PHOTOS = 50;

const $ = id => document.getElementById(id);
const frag = new URLSearchParams(location.hash.slice(1));
const room = frag.get('r');
const rawKey = frag.get('k');
const RELAY = relayBase();

/** photos: [{ blob, url }] in page order */
let photos = [];
let key = null;
let stream = null;
let imageCapture = null;
let retakeIndex = null;
let viewerIndex = null;
let sending = false;
let sentOnce = false;

// ------------------------------------------------------------- header ---
function header(state, text) {
  $('hdr').className = state;
  $('hdrText').textContent = text;
}
function updateCounts() {
  const n = photos.length;
  $('hdrCount').textContent = n ? `${n} photo${n === 1 ? '' : 's'}` : '';
  $('doneBtn').disabled = n === 0;
  $('doneBtn').textContent = n ? `Review (${n}) ✓` : 'Review ✓';
  $('shutter').disabled = n >= MAX_PHOTOS && retakeIndex === null;
  $('sendBtn').disabled = n === 0 || sending;
  $('sendBtn').textContent = n ? `Send all (${n})` : 'Send all';
}

function fatal(msg) {
  for (const id of ['cameraView', 'reviewView', 'viewer']) $(id).classList.add('hidden');
  $('fatal').textContent = msg;
  $('fatal').classList.remove('hidden');
  header('bad', 'Not connected');
  stopCamera();
}

// ---------------------------------------------------------------- relay ---
async function post(kind, body) {
  return fetch(`${RELAY}/relay/${room}/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function hello() {
  try {
    const r = await post('hello', { device: deviceName() });
    if (r.status === 404) { header('bad', 'Runbook page not listening — rescan the QR code'); return false; }
    if (!r.ok) { header('bad', `Relay error ${r.status}`); return false; }
    header('ok', 'Connected to your runbook page');
    return true;
  } catch {
    header('bad', "Can't reach the relay — check your connection");
    return false;
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

// --------------------------------------------------------------- camera ---
async function startCamera() {
  if (stream) return true;
  if (!navigator.mediaDevices?.getUserMedia) { cameraUnavailable('This browser can’t show a live camera here. Use Native camera or Library.'); return false; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    cameraUnavailable(denied ? 'Camera access was blocked. Use Native camera or Library below.' : 'No camera available. Use Native camera or Library below.');
    return false;
  }
  const video = $('video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  imageCapture = null;
  if ('ImageCapture' in window) {
    try { imageCapture = new ImageCapture(track); } catch { imageCapture = null; }
  }
  const caps = track.getCapabilities?.() || {};
  $('torchBtn').classList.toggle('hidden', !caps.torch);
  $('cameraMsg').classList.add('hidden');
  $('shutter').disabled = false;
  return true;
}

function stopCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  imageCapture = null;
  $('torchBtn').classList.remove('on');
}

function cameraUnavailable(msg) {
  stopCamera();
  // No live camera: go straight to the review grid with the picker buttons.
  showReview(msg);
}

$('torchBtn').addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const on = !$('torchBtn').classList.contains('on');
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); $('torchBtn').classList.toggle('on', on); } catch { /* unsupported */ }
});

async function capture() {
  const video = $('video');
  if (!stream || !video.videoWidth) return null;
  // Full-resolution still where supported (Android Chrome); otherwise the
  // current video frame at the stream's resolution (iOS Safari).
  if (imageCapture) {
    try {
      const blob = await imageCapture.takePhoto();
      return await compress(blob);
    } catch { /* fall through to a frame grab */ }
  }
  return compress(video, video.videoWidth, video.videoHeight);
}

$('shutter').addEventListener('click', async () => {
  $('shutter').disabled = true;
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  try {
    const blob = await capture();
    if (blob) addPhoto(blob, retakeIndex);
  } finally {
    $('shutter').disabled = false;
    if (retakeIndex !== null) { retakeIndex = null; $('retakeBanner').classList.add('hidden'); showReview(); }
    updateCounts();
  }
});

// ------------------------------------------------------------- images ---
/** Resize to MAX_EDGE and re-encode as JPEG. Source: Blob, video, or bitmap. */
async function compress(source, w0, h0) {
  let src = source;
  let w = w0, h = h0;
  if (source instanceof Blob) {
    try {
      src = await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch {
      return source.type === 'image/jpeg' ? source : null;   // can't decode (some HEIC): send as is if JPEG
    }
    w = src.width; h = src.height;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(src, 0, 0, cw, ch);
  if (src.close) src.close();
  return new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', JPEG_QUALITY));
}

function addPhoto(blob, replaceAt = null) {
  const item = { blob, url: URL.createObjectURL(blob) };
  if (replaceAt !== null && photos[replaceAt]) {
    URL.revokeObjectURL(photos[replaceAt].url);
    photos[replaceAt] = item;
  } else if (photos.length < MAX_PHOTOS) {
    photos.push(item);
  }
  drawStrip();
  updateCounts();
}

async function addFiles(fileList) {
  for (const f of [...fileList]) {
    if (photos.length >= MAX_PHOTOS) break;
    const blob = await compress(f);
    if (blob) addPhoto(blob);
  }
  drawGrid();
  updateCounts();
}

function drawStrip() {
  const strip = $('strip');
  strip.replaceChildren(...photos.slice(-12).map(p => Object.assign(document.createElement('img'), { src: p.url, alt: '' })));
  strip.scrollLeft = strip.scrollWidth;
}

// ------------------------------------------------------------- review ---
function showCamera() {
  if (sending) return;
  $('reviewView').classList.add('hidden');
  $('cameraView').classList.remove('hidden');
  startCamera().then(ok => { if (ok) drawStrip(); });
}

function showReview(msg = '') {
  stopCamera();   // battery + privacy: no camera while reviewing
  $('cameraView').classList.add('hidden');
  $('reviewView').classList.remove('hidden');
  $('reviewSub').textContent = msg || 'Tap a photo to view, retake, delete or reorder it.';
  $('backBtn').classList.toggle('hidden', !navigator.mediaDevices?.getUserMedia);
  drawGrid();
  updateCounts();
}

function drawGrid() {
  const grid = $('grid');
  if (!photos.length) {
    grid.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No photos yet.' }));
    return;
  }
  grid.replaceChildren(...photos.map((p, i) => {
    const b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = `<img alt=""><span class="n">${i + 1}</span><span class="st"></span>`;
    b.querySelector('img').src = p.url;
    b.querySelector('.st').textContent = p.state === 'sent' ? '✅' : p.state === 'failed' ? '⚠️' : p.state === 'sending' ? '⏳' : '';
    b.addEventListener('click', () => openViewer(i));
    return b;
  }));
}

$('doneBtn').addEventListener('click', () => showReview());
$('backBtn').addEventListener('click', showCamera);

// ------------------------------------------------------------- viewer ---
function openViewer(i) {
  if (sending) return;
  viewerIndex = i;
  $('viewerImg').src = photos[i].url;
  $('vEarlier').disabled = i === 0;
  $('vLater').disabled = i === photos.length - 1;
  $('vRetake').disabled = !navigator.mediaDevices?.getUserMedia;
  $('viewer').classList.remove('hidden');
}
const closeViewer = () => { $('viewer').classList.add('hidden'); viewerIndex = null; drawGrid(); updateCounts(); };
function move(delta) {
  const i = viewerIndex, j = i + delta;
  if (j < 0 || j >= photos.length) return;
  [photos[i], photos[j]] = [photos[j], photos[i]];
  openViewer(j);
}
$('vEarlier').addEventListener('click', () => move(-1));
$('vLater').addEventListener('click', () => move(1));
$('vDelete').addEventListener('click', () => {
  URL.revokeObjectURL(photos[viewerIndex].url);
  photos.splice(viewerIndex, 1);
  closeViewer();
});
$('vRetake').addEventListener('click', () => {
  retakeIndex = viewerIndex;
  $('viewer').classList.add('hidden');
  $('retakeBanner').textContent = `Retaking photo ${retakeIndex + 1}`;
  $('retakeBanner').classList.remove('hidden');
  showCamera();
});
$('vClose').addEventListener('click', closeViewer);

// ---------------------------------------------------------- fallbacks ---
for (const id of ['nativeBtn', 'nativeBtn2']) $(id).addEventListener('click', () => $('nativeInput').click());
for (const id of ['libraryBtn', 'libraryBtn2']) $(id).addEventListener('click', () => $('libraryInput').click());
for (const id of ['nativeInput', 'libraryInput']) {
  $(id).addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files?.length) { showReview(); await addFiles(files); }
    e.target.value = '';
  });
}

// ------------------------------------------------------------ send all ---
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendOne(batch, i, count) {
  const p = photos[i];
  const bytes = new Uint8Array(await p.blob.arrayBuffer());
  const { iv, data } = await encryptBytes(key, bytes);
  const body = { batch, index: i + 1, count, name: `photo-${String(i + 1).padStart(2, '0')}.jpg`, type: 'image/jpeg', iv, data };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const r = await post('photo', body);
      if (r.ok) return 'sent';
      if (r.status === 404) return 'gone';
      if (r.status === 400 || r.status === 413) return 'failed';
    } catch { /* network: retry */ }
  }
  return 'failed';
}

$('sendBtn').addEventListener('click', async () => {
  if (sending || !photos.length) return;
  sending = true;
  updateCounts();
  $('backBtn').disabled = true;
  const status = $('sendStatus');
  const bar = $('progressBar');
  $('progress').classList.remove('hidden');
  status.className = 'status';
  const count = photos.length;
  const batch = randomId(9);
  let sent = 0;
  let outcome = 'ok';
  for (const p of photos) if (p.state !== 'sent') p.state = '';
  for (let i = 0; i < count; i++) {
    photos[i].state = 'sending';
    drawGrid();
    status.textContent = `Sending ${i + 1} of ${count}…`;
    const r = await sendOne(batch, i, count);
    photos[i].state = r === 'sent' ? 'sent' : 'failed';
    if (r === 'sent') sent++;
    bar.style.width = `${Math.round(((i + 1) / count) * 100)}%`;
    drawGrid();
    if (r === 'gone') { outcome = 'gone'; break; }
    if (r === 'failed') outcome = 'failed';
  }
  sending = false;
  $('backBtn').disabled = false;
  if (outcome === 'gone') {
    status.textContent = 'The runbook page stopped listening. Open the scanner there again and rescan the QR code.';
    status.className = 'status bad';
    header('bad', 'Runbook page not listening');
  } else if (outcome === 'failed') {
    status.textContent = `${sent} of ${count} sent. Tap Send all to retry — the page only adds the set once every photo arrives.`;
    status.className = 'status bad';
  } else {
    sentOnce = true;
    status.textContent = `Sent ✓ — ${count} photo${count === 1 ? '' : 's'}. Check your runbook page.`;
    status.className = 'status ok';
    $('reviewTitle').textContent = 'Sent';
    $('sendBtn').classList.add('hidden');
    $('backBtn').textContent = 'Scan more';
    $('backBtn').onclick = () => { resetBatch(); showCamera(); };
  }
  updateCounts();
});

function resetBatch() {
  for (const p of photos) URL.revokeObjectURL(p.url);
  photos = [];
  $('reviewTitle').textContent = 'Review';
  $('sendBtn').classList.remove('hidden');
  $('backBtn').textContent = 'Back to camera';
  $('backBtn').onclick = null;
  $('progress').classList.add('hidden');
  $('progressBar').style.width = '0';
  $('sendStatus').textContent = '';
  drawStrip();
  updateCounts();
}

// Stop the camera when the page is hidden; restart on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (!$('cameraView').classList.contains('hidden')) startCamera();
});
window.addEventListener('beforeunload', (e) => {
  if (photos.length && !sentOnce) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- init ---
(async () => {
  if (!room || !rawKey || !/^[A-Za-z0-9_-]{22,64}$/.test(room)) {
    fatal('Open this page by scanning the QR code on the runbook page (Scan with phone).');
    return;
  }
  if (!globalThis.crypto?.subtle) { fatal('This browser can’t encrypt photos here. Open the link in Safari or Chrome.'); return; }
  try { key = await importKey(rawKey); } catch { fatal('This link is incomplete. Rescan the QR code.'); return; }
  hello();
  $('cameraView').classList.remove('hidden');
  updateCounts();
  await startCamera();
})();
