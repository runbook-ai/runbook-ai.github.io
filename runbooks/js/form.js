// The run form: params (text/number/textarea/date/select/file). Used by the
// Run page and the Designer's Try it tab.

import { h, clear } from './dom.js';
import { openScanner } from './phone-relay.js';

// ---------------------------------------------------------------- files ---

/** A file input with drag-drop, thumbnails and "Scan with phone". */
export function fileWidget({ label, multiple = false, accept = '', onChange = () => {} }) {
  let files = [];
  const thumbs = h('div.thumbs');
  const picker = h('input', { type: 'file', multiple, accept, hidden: true });
  const drop = h('div.dropzone',
    thumbs,
    h('div.drop-actions',
      h('button.btn.btn-ghost', { type: 'button', onclick: () => picker.click() }, '+ Add files'),
      h('button.btn.btn-ghost', { type: 'button', onclick: () => openScanner(label, add) }, '📱 Scan with phone'),
      h('span.fine.drop-hint', multiple ? 'or drop files here' : 'or drop a file here')),
    picker);

  function render() {
    clear(thumbs);
    files.forEach((f, i) => {
      const isImg = /^image\//.test(f.type);
      const url = isImg ? URL.createObjectURL(f) : null;
      thumbs.append(h('div.thumb', { title: `${f.name} (${Math.round(f.size / 1024)} KB)` },
        isImg ? h('img', { src: url, alt: f.name, onload: () => URL.revokeObjectURL(url) }) : h('div.thumb-file', f.name.split('.').pop().toUpperCase()),
        h('span.thumb-name', f.name),
        h('button.thumb-x', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); render(); onChange(); } }, '✕')));
    });
    drop.classList.toggle('has-files', files.length > 0);
  }
  function add(list) {
    const arr = [...list];
    if (!arr.length) return;
    files = multiple ? files.concat(arr) : [arr[arr.length - 1]];
    render();
    onChange();
  }
  picker.addEventListener('change', () => { add(picker.files); picker.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); add(e.dataTransfer.files); });
  return { el: drop, files: () => files.slice(), add, clear: () => { files = []; render(); onChange(); } };
}

// ---------------------------------------------------------------- params ---

/**
 * Build the params form for a manifest.
 * Returns { el, values(), fileGroups(), missing(), allFiles() }.
 * Runbooks without a file param get an optional "Attachments" widget.
 */
export function paramsForm(manifest, { onChange = () => {} } = {}) {
  const params = Array.isArray(manifest?.params) ? manifest.params : [];
  const el = h('form.params', { onsubmit: (e) => e.preventDefault() });
  const inputs = new Map();
  const widgets = new Map();

  for (const p of params) {
    if (!p || !p.name) continue;
    const id = `p_${p.name}_${Math.random().toString(36).slice(2, 6)}`;
    const label = h('label.label', { for: id }, p.label || p.name, p.required ? h('span.required-mark', ' *') : null);
    const field = h('div.field', label);
    if (p.type === 'file') {
      const w = fileWidget({ label: p.label || p.name, multiple: !!p.multiple, accept: p.accept || '', onChange });
      widgets.set(p.name, w);
      field.append(w.el);
    } else {
      let input;
      if (Array.isArray(p.options)) {
        input = h('select');
        for (const opt of p.options) {
          const val = typeof opt === 'object' ? opt.value : opt;
          const lab = typeof opt === 'object' ? (opt.label || opt.value) : opt;
          input.append(h('option', { value: String(val) }, String(lab)));
        }
      } else if (p.type === 'textarea') {
        input = h('textarea', { rows: 3 });
      } else {
        input = h('input', { type: p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text' });
      }
      input.id = id;
      input.name = p.name;
      if (p.placeholder) input.placeholder = p.placeholder;
      if (p.default !== undefined) input.value = String(p.default);
      input.addEventListener('input', onChange);
      input.addEventListener('change', onChange);
      inputs.set(p.name, input);
      field.append(input);
    }
    el.append(field);
  }

  if (!params.some(p => p && p.type === 'file')) {
    const w = fileWidget({ label: 'Attachments', multiple: true, onChange });
    widgets.set('__attachments', w);
    el.append(h('details.attachments', h('summary', 'Attachments (optional)'), w.el));
  }

  return {
    el,
    values() {
      const v = {};
      for (const [name, input] of inputs) v[name] = input.value;
      for (const [name, w] of widgets) if (name !== '__attachments') v[name] = w.files().map(f => f.name).join(', ');
      return v;
    },
    fileGroups() { return [...widgets.entries()].map(([name, w]) => ({ name, files: w.files() })); },
    allFiles() { return [...widgets.values()].flatMap(w => w.files()); },
    missing() {
      return params.filter(p => {
        if (!p || !p.required) return false;
        if (p.type === 'file') return !(widgets.get(p.name)?.files().length);
        const v = inputs.get(p.name)?.value;
        return !v || !String(v).trim();
      });
    },
  };
}
