// Small DOM helpers.

/** h('div.card#id', {attrs/props/on*}, ...children) */
export function h(tag, props = {}, ...children) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function download(name, bytesOrText, type = 'application/octet-stream') {
  const blob = new Blob([bytesOrText], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Modal dialog. Returns { el, body, close }. Closes on Esc / backdrop. */
export function modal(title, { wide = false, onClose } = {}) {
  const body = h('div.modal-body');
  const closeBtn = h('button.icon-btn', { 'aria-label': 'Close', title: 'Close' }, '✕');
  const box = h('div.modal' + (wide ? '.modal-wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), closeBtn), body);
  const backdrop = h('div.modal-backdrop', box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { el: box, body, close };
}

let toastTimer = null;
export function toast(msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) { el = h('div#toast'); document.body.append(el); }
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3500);
}
