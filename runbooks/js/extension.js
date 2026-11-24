// Bridge to the Runbook AI extension (externally_connectable on runbookai.net).

export const EXTENSION_ID = 'kjbhngehjkiiecaflccjenmoccielojj';
export const INSTALL_URL = 'https://chromewebstore.google.com/detail/runbook-ai/kjbhngehjkiiecaflccjenmoccielojj';
export const FREE_LLM = { llmBaseUrl: 'https://llm.runbookai.net/v1', llmApiKey: 'free' };

function runtime() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage ? chrome.runtime : null;
}

/** Send an action to the extension. Rejects if the extension isn't there. */
export function ext(action, args = {}) {
  const rt = runtime();
  if (!rt) return Promise.reject(Object.assign(new Error('The Runbook AI extension is not installed.'), { code: 'extension-missing' }));
  return new Promise((resolve, reject) => {
    try {
      rt.sendMessage(EXTENSION_ID, { action, args }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(Object.assign(new Error(err.message), { code: 'extension-missing' }));
        else resolve(resp);
      });
    } catch (err) {
      reject(Object.assign(err, { code: 'extension-missing' }));
    }
  });
}

/**
 * Is the extension installed? Any reply counts -- including an error from a
 * closed side panel -- since only an installed extension can answer.
 * Uses a harmless unknown action (never getConfig, which returns settings).
 */
export async function probeExtension(timeoutMs = 2500) {
  if (!runtime()) return false;
  try {
    await Promise.race([ext('ping'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return true;
  } catch (err) {
    return err.code !== 'extension-missing' && err.message !== 'timeout';
  }
}

/** Open the side panel. Must run inside a user gesture (a click handler). */
export async function openSidePanel() {
  // Not fatal: the panel may already be open, or this Chrome may not allow
  // opening it here. If the panel really is unreachable, the next action
  // fails with side-panel-message-failed and the caller says so.
  try {
    const resp = await ext('openSidePanel');
    if (resp?.error) console.warn('openSidePanel:', resp.message || resp.error);
  } catch (err) {
    if (err.code === 'extension-missing') throw err;
    console.warn('openSidePanel:', err.message);
  }
  // Give the side panel a moment to load before forwarding actions to it.
  await new Promise(r => setTimeout(r, 500));
}

/** User-facing text for an extension error. */
export function extensionErrorText(err) {
  if (err?.code === 'extension-missing') return 'Failed to run. Make sure the Runbook AI extension is installed and enabled.';
  if (err?.code === 'side-panel-message-failed') return 'Couldn’t reach the Runbook AI side panel. Open it from the extension icon, then try again.';
  return err?.message || String(err);
}
