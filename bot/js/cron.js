/**
 * Cron scheduler — checks for due tasks and enqueues them.
 *
 * Schedule types:
 *   { type: "every", intervalMs: 7200000 }   — recurring interval
 *   { type: "at",    time: "2026-03-06T09:00:00Z" } — one-shot absolute time
 *
 * The scheduler runs a check every TICK_INTERVAL_MS. When a waiting task's
 * nextRunAt <= now, it is moved to 'queued' and picked up by the task manager.
 */

import { getDueTasks } from './task-store.js';

const TICK_INTERVAL_MS = 30_000; // check every 30s

let tickTimer = null;
let onTaskDue = null; // callback: (task) => void

/** Compute the next run time for a schedule. Returns epoch ms or null. */
export function computeNextRun(schedule, fromMs = Date.now()) {
  if (!schedule) return null;

  switch (schedule.type) {
    case 'every':
      return fromMs + schedule.intervalMs;

    case 'at': {
      const t = new Date(schedule.time).getTime();
      return t > fromMs ? t : null; // expired one-shots return null
    }

    default:
      return null;
  }
}

/** Exponential backoff: 30s, 1m, 5m, 15m, 60m cap. */
const BACKOFF_STEPS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export function computeBackoff(consecutiveErrors) {
  const idx = Math.min(consecutiveErrors, BACKOFF_STEPS.length) - 1;
  return BACKOFF_STEPS[Math.max(0, idx)];
}

/** Main tick: find due tasks and notify the callback. */
async function tick() {
  try {
    const due = await getDueTasks();
    for (const task of due) {
      if (onTaskDue) onTaskDue(task);
    }
  } catch (err) {
    console.error('[cron] tick error:', err);
  }
}

/** Start the scheduler. onDue is called with each task that becomes due. */
export function startCron(onDue) {
  onTaskDue = onDue;
  if (tickTimer) return;
  tick(); // run immediately on start
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  console.log('[cron] scheduler started');
}

export function stopCron() {
  clearInterval(tickTimer);
  tickTimer = null;
  onTaskDue = null;
  console.log('[cron] scheduler stopped');
}
