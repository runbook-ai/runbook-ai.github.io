/**
 * Shared extension messaging — sends messages to the Runbook AI
 * Chrome extension via chrome.runtime.sendMessage.
 */

const EXTENSION_ID = 'kjbhngehjkiiecaflccjenmoccielojj';

export async function extensionCall(action, args) {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('Runbook AI extension is not available on this page');
  }
  const resp = await chrome.runtime.sendMessage(EXTENSION_ID, { action, args });
  if (resp?.error) throw new Error(resp.message || resp.error);
  return resp;
}
