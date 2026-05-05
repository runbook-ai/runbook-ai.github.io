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

import { getDueTasks, getTasksByStatus, deleteTask, getTask, deleteRunsOlderThan, deleteLlmLogsOlderThan } from './task-store.js';

const TICK_INTERVAL_MS = 30_000; // check every 30s
const CLEANUP_INTERVAL_MS = 3_600_000; // cleanup every hour
const DEFAULT_TASK_TTL_DAYS = 180;

let tickTimer = null;
let cleanupTimer = null;
let onTaskDue = null; // callback: (task) => void

/** Compute the next run time for a schedule. Returns ISO 8601 string or null. */
export function computeNextRun(schedule, fromMs = Date.now()) {
  if (!schedule) return null;

  switch (schedule.type) {
    case 'every':
      return new Date(fromMs + schedule.intervalMs).toISOString();

    case 'at': {
      const t = new Date(schedule.time).getTime();
      return t > fromMs ? new Date(t).toISOString() : null;
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
      // Monitor tasks are handled by the monitor tick in task-manager, not cron
      if (onTaskDue && task.type !== 'monitor') onTaskDue(task);
    }
  } catch (err) {
    console.error('[cron] tick error:', err);
  }
}

/** Delete completed/failed tasks older than configured TTL. */
async function cleanup() {
  try {
    const now = Date.now();
    const config = getConfigFn ? await getConfigFn() : null;
    const taskTtlDays = config?.taskTtlDays || DEFAULT_TASK_TTL_DAYS;
    const taskMaxAgeMs = taskTtlDays * 24 * 3_600_000;

    for (const status of ['completed', 'failed']) {
      const tasks = await getTasksByStatus(status);
      for (const t of tasks) {
        const age = now - new Date(t.lastRunAt || t.updatedAt || t.createdAt || 0).getTime();
        if (age > taskMaxAgeMs) {
          // Don't delete child tasks whose parent is still active
          if (t.parentId) {
            const parent = await getTask(t.parentId);
            if (parent && !['completed', 'failed'].includes(parent.status)) {
              continue;
            }
          }
          await deleteTask(t.id);
          console.log(`[cron] cleaned up ${status} task ${t.id} (${Math.round(age / 86400000)}d old)`);
        }
      }
    }
    // Clean up local history stores based on configured TTL
    await cleanupLocalHistory(now, config);
  } catch (err) {
    console.error('[cron] cleanup error:', err);
  }
}

let getConfigFn = null;
export function setCronConfig(fn) { getConfigFn = fn; }

async function cleanupLocalHistory(now, config) {
  try {
    if (!config?.enableLocalHistory) return;
    const ttlDays = config.localHistoryTtlDays || DEFAULT_TASK_TTL_DAYS;
    const cutoff = new Date(now - ttlDays * 24 * 3_600_000).toISOString();
    const runsDeleted = await deleteRunsOlderThan(cutoff);
    const logsDeleted = await deleteLlmLogsOlderThan(cutoff);
    if (runsDeleted || logsDeleted) {
      console.log(`[cron] local history cleanup: ${runsDeleted} runs, ${logsDeleted} logs older than ${ttlDays}d`);
    }
  } catch (err) {
    console.warn('[cron] local history cleanup error:', err);
  }
}

/** Start the scheduler. onDue is called with each task that becomes due. */
export function startCron(onDue) {
  onTaskDue = onDue;
  if (tickTimer) return;
  tick(); // run immediately on start
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  cleanup(); // run cleanup on start
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  console.log('[cron] scheduler started');
}

export function stopCron() {
  clearInterval(tickTimer);
  clearInterval(cleanupTimer);
  tickTimer = null;
  cleanupTimer = null;
  onTaskDue = null;
  console.log('[cron] scheduler stopped');
}
