/**
 * Event store — pub/sub backed by the existing file store.
 *
 * One topic = one append-only JSONL file at `events/<topic>.jsonl`.
 * Each line is one event: { ts, payload, dedupKey?, sourceTaskId? }
 *
 * Cursor = ISO 8601 ts of the last consumed event, stored on the
 * subscription task itself. Survives GC because timestamps don't
 * renumber when old lines are dropped.
 *
 * See auto-chrome/docs/event-driven-tasks-design.md for the design.
 */

import { readFile, appendFile, listFiles, writeFile } from './file-store.js';

const PREFIX = 'events/';
const SUFFIX = '.jsonl';
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const TTL_DAYS_DEFAULT = 30;

function topicPath(topic) {
  return PREFIX + topic + SUFFIX;
}

function parseLines(content) {
  if (!content) return [];
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Append one event to a topic. Returns the appended row, or the existing
 * row on dedup collision (same topic+dedupKey within 24h).
 */
export async function appendEvent({ topic, payload, dedupKey, sourceTaskId }) {
  if (!topic || typeof topic !== 'string') {
    throw new Error('appendEvent: topic is required');
  }
  const path = topicPath(topic);
  const now = new Date();
  const nowIso = now.toISOString();

  if (dedupKey) {
    const existing = await readFile(path);
    if (existing?.content) {
      const cutoff = now.getTime() - DEDUP_WINDOW_MS;
      const rows = parseLines(existing.content);
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (new Date(r.ts).getTime() < cutoff) break;
        if (r.dedupKey === dedupKey) return r;
      }
    }
  }

  const row = { ts: nowIso, payload };
  if (dedupKey) row.dedupKey = dedupKey;
  if (sourceTaskId) row.sourceTaskId = sourceTaskId;

  await appendFile(path, JSON.stringify(row) + '\n');
  return row;
}

/**
 * Return events on `topic` whose ts is strictly greater than `sinceTs`.
 * `sinceTs` is an ISO 8601 string; pass null/undefined for all events.
 */
export async function getEventsSince(topic, sinceTs) {
  const rec = await readFile(topicPath(topic));
  if (!rec?.content) return [];
  const rows = parseLines(rec.content);
  if (!sinceTs) return rows;
  return rows.filter(r => r.ts > sinceTs);
}

/**
 * Return the ts of the latest event on `topic`, or null if empty.
 * Used to set a subscription's initial cursor to "now" without races.
 */
export async function latestEventTs(topic) {
  const rec = await readFile(topicPath(topic));
  if (!rec?.content) return null;
  const rows = parseLines(rec.content);
  if (rows.length === 0) return null;
  return rows[rows.length - 1].ts;
}

/**
 * Return the ts of the oldest event on `topic`, or null if empty.
 * Used to detect cursor-lag-past-GC.
 */
export async function oldestEventTs(topic) {
  const rec = await readFile(topicPath(topic));
  if (!rec?.content) return null;
  const rows = parseLines(rec.content);
  if (rows.length === 0) return null;
  return rows[0].ts;
}

/**
 * Drop events older than `maxAgeDays` from every topic. Rewrites each
 * topic file. Returns { topics: N, dropped: total }.
 */
export async function gcEvents(maxAgeDays = TTL_DAYS_DEFAULT) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
  const files = await listFiles(PREFIX);
  let dropped = 0;
  for (const f of files) {
    if (!f.path.endsWith(SUFFIX)) continue;
    const rec = await readFile(f.path);
    if (!rec?.content) continue;
    const rows = parseLines(rec.content);
    const kept = rows.filter(r => r.ts >= cutoff);
    if (kept.length === rows.length) continue;
    dropped += rows.length - kept.length;
    const newContent = kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '');
    await writeFile(f.path, newContent, { mimeType: 'application/jsonl', encoding: 'utf8' });
  }
  return { topics: files.length, dropped };
}

/** List all known topic names (strips events/ prefix and .jsonl suffix). */
export async function listTopics() {
  const files = await listFiles(PREFIX);
  return files
    .filter(f => f.path.endsWith(SUFFIX))
    .map(f => f.path.slice(PREFIX.length, -SUFFIX.length));
}
