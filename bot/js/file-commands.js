/**
 * Shared chat-command dispatcher for file-store commands.
 *
 * Both the bot page (local-ui.js, message-handler.js) and the extension
 * sidepanel route text input through this. Returns `{ text }` when the content
 * matched a file command, or `null` so the caller can continue dispatching.
 *
 * Commands:
 *   !files [prefix]       — list files (optionally scoped)
 *   !file <path>          — read a file (text content, or metadata for binary)
 *   !grep <pat> [prefix]  — search file contents
 *   !rm <path>            — delete a file
 */

import { readFile, listFiles, deleteFile, fileInfo, grepFiles } from './file-store.js';

function fmtSize(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * @param {string} content
 * @returns {Promise<{text: string} | null>}
 */
export async function maybeRunFileCommand(content) {
  const trimmed = content.trim();

  // !files [prefix]
  const filesMatch = trimmed.match(/^!files(?:\s+(\S.*))?$/i);
  if (filesMatch) {
    const prefix = (filesMatch[1] ?? '').trim();
    const list = await listFiles(prefix);
    if (!list.length) return { text: prefix ? `No files under "${prefix}".` : 'No files.' };
    const lines = list.map(f => `${f.path}  (${fmtSize(f.size)})`);
    return { text: lines.join('\n') };
  }

  // !file <path>
  const fileMatch = trimmed.match(/^!file\s+(.+)$/i);
  if (fileMatch) {
    const path = fileMatch[1].trim();
    const info = await fileInfo(path);
    if (!info) return { text: `File not found: ${path}` };
    if (info.encoding === 'base64') {
      return { text: `${path}\n(binary, mimeType=${info.mimeType}, size=${fmtSize(info.size)})` };
    }
    const rec = await readFile(path);
    return { text: `${path}\n\n${rec?.content ?? ''}` };
  }

  // !grep <pattern> [prefix]
  const grepMatch = trimmed.match(/^!grep\s+(\S+)(?:\s+(\S.*))?$/i);
  if (grepMatch) {
    const pattern = grepMatch[1];
    const prefix = (grepMatch[2] ?? '').trim();
    const { matches } = await grepFiles(pattern, { prefix, maxResults: 10 });
    if (!matches.length) return { text: `No matches for "${pattern}"${prefix ? ` under "${prefix}"` : ''}.` };
    const lines = [];
    for (const m of matches) {
      for (const l of (m.lines ?? [])) lines.push(`${m.path}:${l.lineNum}: ${l.text}`);
    }
    return { text: lines.join('\n') };
  }

  // !rm <path>
  const rmMatch = trimmed.match(/^!rm\s+(.+)$/i);
  if (rmMatch) {
    const path = rmMatch[1].trim();
    const ok = await deleteFile(path);
    return { text: ok ? `Deleted ${path}.` : `File not found: ${path}` };
  }

  return null;
}

/** Help text for these commands, shareable with the !help handler. */
export const FILE_COMMANDS_HELP =
  '!files [prefix] - list files\n' +
  '!file <path> - read a file\n' +
  '!grep <pat> [prefix] - search files\n' +
  '!rm <path> - delete a file';
