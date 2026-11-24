// Voice input for a textarea, ported from the extension side panel's
// voice-input.js: Chrome's Web Speech API (webkitSpeechRecognition, i.e.
// Google's speech service) dictates into the box; nothing is sent anywhere
// else until the user presses Send. Unlike the side panel, a normal web page
// gets Chrome's own microphone prompt, so no separate permission page.

/** Dictated text appended to what was typed, one space between them. */
export function voiceMergeText(base, dictated) {
  const d = (dictated || '').trim();
  if (!d) return base || '';
  if (!base || /\s$/.test(base)) return (base || '') + d;
  return base + ' ' + d;
}

export function voiceSupported() {
  return typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
}

const IDLE_TITLE = 'Voice input (audio is transcribed by Google)';

/**
 * Wire a mic button to a textarea. Returns { cancel, stop, isListening }.
 * `onError(message)` shows a user-facing message. When speech recognition is
 * unsupported (non-Chrome browsers) the button is removed.
 */
export function attachVoiceInput(box, button, { onError = () => {} } = {}) {
  if (!voiceSupported()) { button.remove(); return { cancel() {}, stop() {}, isListening: () => false }; }
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let base = '';
  let finalText = '';

  button.type = 'button';
  button.classList.add('mic-btn');
  button.title = IDLE_TITLE;
  button.setAttribute('aria-label', 'Voice input');
  button.setAttribute('aria-pressed', 'false');
  if (!button.innerHTML.trim()) {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  }

  const render = () => {
    const on = !!rec;
    button.classList.toggle('listening', on);
    button.title = on ? 'Stop voice input' : IDLE_TITLE;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  const reset = () => { rec = null; render(); };
  const show = (dictated) => {
    if (box.disabled) { cancel(); return; }
    box.value = voiceMergeText(base, dictated);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.scrollTop = box.scrollHeight;
  };

  function start() {
    if (rec || box.disabled) return;
    const r = new Rec();
    r.continuous = true;          // Chrome still ends it after a long silence
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    base = box.value;
    finalText = '';
    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText = voiceMergeText(finalText, res[0].transcript);
        else interim = voiceMergeText(interim, res[0].transcript);
      }
      show(voiceMergeText(finalText, interim));
    };
    r.onerror = (event) => {
      const code = event.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') { cancel(); onError('Voice input: microphone access was blocked. Allow it in the address bar and try again.'); }
      else if (code === 'audio-capture') { cancel(); onError('Voice input: no microphone found.'); }
      else if (code === 'network') { cancel(); onError('Voice input: Google transcription is unavailable. Check your connection.'); }
      else if (code === 'language-not-supported') { cancel(); onError(`Voice input: language "${navigator.language}" is not supported.`); }
      // no-speech / aborted: onend resets quietly.
    };
    r.onend = () => {
      if (rec !== r) return;
      show(finalText);
      reset();
    };
    rec = r;
    render();
    try { r.start(); } catch (err) { reset(); onError(`Voice input failed to start: ${err.message}`); }
  }

  // Stop listening, keeping what was recognized.
  function stop() { if (rec) rec.stop(); }

  // Stop and drop pending results -- used on send, so a late result can't
  // refill the box that was just cleared.
  function cancel() {
    const r = rec;
    if (!r) return;
    r.onresult = r.onerror = r.onend = null;
    r.abort();
    reset();
  }

  button.addEventListener('click', () => (rec ? stop() : start()));
  return { cancel, stop, isListening: () => !!rec };
}
