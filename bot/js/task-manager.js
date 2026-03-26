/**
 * Task manager — lifecycle, serial execution, and chaining.
 *
 * Orchestrates the task queue:
 *   1. Accepts tasks from message-handler or cron
 *   2. Executes them serially via the planner or direct extension call
 *   3. Manages task state transitions in IndexedDB
 *   4. Delegates delivery to a callback (no Discord-specific logic here)
 */

import {
  putTask, getTask, createTaskRecord,
  getTasksByStatus, getAllTasks, deleteTask,
  getChildTasks,
} from './task-store.js';
import { computeNextRun, computeBackoff } from './cron.js';
import { showProcessing, hideProcessing } from './ui.js';
import { runPlan, UserCancelledError } from './planner.js';

// ── Delivery callback ──────────────────────────────────────────────────────

// Set by the app layer to handle message delivery (Discord, etc.)
let deliverFn = null;

/**
 * Register a delivery function: async (task, message) => sentMessage
 * sentMessage should have an `id` property (e.g. Discord message ID).
 */
export function setDeliveryHandler(fn) {
  deliverFn = fn;
}

/** Deliver a message for a task using the registered handler. */
async function deliver(task, message) {
  if (!deliverFn || !task.channelId) return null;
  try {
    return await deliverFn(task, message);
  } catch (err) {
    console.error('[task-manager] delivery failed:', err);
    return null;
  }
}

// ── Typing indicator callback ──────────────────────────────────────────────

let typingFn = null;

/** Register a typing indicator function: (task) => void */
export function setTypingHandler(fn) {
  typingFn = fn;
}

// ── Serial queue ────────────────────────────────────────────────────────────

const readyQueue = []; // task IDs ready to execute
let running = false;

/** Enqueue a task for execution. Persists it and starts the queue if idle. */
export async function enqueueTask(task) {
  if (task.status !== 'queued') {
    task.status = 'queued';
  }
  await putTask(task);
  if (!readyQueue.includes(task.id)) {
    readyQueue.push(task.id);
  }
  if (!running) drainQueue();
}

/** Create and enqueue a new task from a user message. */
export async function createAndEnqueue({ prompt, files, config, channelId, replyToId, createdBy, schedule, maxRuns, parentId, context }) {
  const task = createTaskRecord({
    prompt,
    files: files ?? {},
    config,
    channelId,
    replyToId,
    createdBy,
    schedule: schedule ?? null,
    maxRuns: maxRuns ?? null,
    parentId: parentId ?? null,
    context: context ?? {},
    // First run is always immediate; nextRunAt is set after the first run completes
    nextRunAt: null,
    status: 'queued',
  });
  await putTask(task);

  if (task.status === 'queued') {
    readyQueue.push(task.id);
    if (!running) drainQueue();
  }

  return task;
}

async function drainQueue() {
  if (running) return;
  running = true;

  while (readyQueue.length > 0) {
    const id = readyQueue.shift();
    const task = await getTask(id);
    if (!task || task.status !== 'queued') continue;
    await executeTask(task);
  }

  running = false;
}

// ── Execution ───────────────────────────────────────────────────────────────

async function executeTask(task) {
  task.status    = 'running';
  task.lastRunAt = new Date().toISOString();
  task.runCount += 1;
  await putTask(task);

  if (task.channelId) {
    showProcessing(task.channelId);
    if (typingFn) typingFn(task);
  }

  try {
    // Inject child task statuses so the planner can react to child completions
    const children = await getChildTasks(task.id);
    if (children.length > 0) {
      task.context.__childStatuses = children.map(c => ({
        id: c.id,
        status: c.status,
        result: c.result,
        prompt: c.prompt.slice(0, 200),
        runCount: c.runCount,
        memory: c.context ? (({ history, __childStatuses, ...rest }) => rest)(c.context) : {},
      }));
    }

    // Run through the planner
    const planResult = await runPlan(task, async (message) => {
      // onNotify callback — deliver progress updates
      await deliver(task, message);
    });

    // Re-read from DB to check if task was cancelled during execution
    const freshTask = await getTask(task.id);
    if (freshTask && freshTask.status === 'failed' && freshTask.lastError === 'Cancelled by user') {
      return; // Task was cancelled while running — don't overwrite
    }

    task.result            = planResult.result || 'Task completed with no result.';
    task.consecutiveErrors = 0;
    task.lastError         = null;

    // Merge memory from the plan into persistent context
    if (planResult.memory && typeof planResult.memory === 'object') {
      task.context = { ...task.context, ...planResult.memory };
    }

    // Save conversation history for follow-up runs
    if (planResult.history) {
      task.context.history = planResult.history;
    }

    // Decide next state
    if (task.schedule) {
      if (planResult.stopReached) {
        // Stop condition met — auto-complete the recurring task
        task.status    = 'completed';
        task.nextRunAt = null;
      } else if (task.maxRuns && task.runCount >= task.maxRuns) {
        task.status    = 'completed';
        task.nextRunAt = null;
      } else if (task.schedule.type === 'at') {
        task.status    = 'completed';
        task.nextRunAt = null;
      } else {
        task.status    = 'waiting';
        task.nextRunAt = computeNextRun(task.schedule);
      }
    } else {
      task.status    = 'completed';
      task.nextRunAt = null;
    }
    await putTask(task);

    // If this child finished a run, wake the parent — but only when no siblings
    // are still actively executing (queued/running). Children that are waiting
    // (between recurring runs), completed, or failed are all settled states.
    if (task.parentId && (task.status === 'completed' || task.status === 'waiting')) {
      const siblings = await getChildTasks(task.parentId);
      const anyActive = siblings.some(s => s.status === 'queued' || s.status === 'running');
      if (!anyActive) {
        const parent = await getTask(task.parentId);
        if (parent && parent.status === 'waiting') {
          parent.nextRunAt = new Date().toISOString(); // wake immediately on next cron tick
          await putTask(parent);
        }
      }
    }

    // Deliver final result
    // - Child tasks never deliver directly — the parent handles user communication
    // - Recurring scheduled tasks still waiting skip delivery (quiet run)
    // - The planner can always use notify_user during execution for mid-run updates
    const isChildTask = !!task.parentId;
    const isQuietRun = task.schedule && task.status === 'waiting';
    if (!isChildTask && !isQuietRun && task.delivery !== 'silent' && task.channelId) {
      await deliver(task, task.result);
    }

  } catch (err) {
    console.error('[task-manager] executeTask failed:', err);

    // Re-read from DB to check if task was cancelled during execution
    const freshTask = await getTask(task.id);
    if (freshTask && freshTask.status === 'failed' && freshTask.lastError === 'Cancelled by user') {
      return; // Task was cancelled while running — don't overwrite
    }

    // User cancelled the task in the extension — stop immediately, don't retry
    if (err instanceof UserCancelledError) {
      task.status    = 'failed';
      task.lastError = 'Cancelled by user';
      task.nextRunAt = null;
      await putTask(task);

      if (task.channelId) {
        await deliver(task, 'Task cancelled by user.');
      }
      return;
    }

    task.consecutiveErrors += 1;
    task.lastError = err?.message ?? String(err);

    if (task.schedule && task.consecutiveErrors < 5) {
      task.status    = 'waiting';
      task.nextRunAt = new Date(Date.now() + computeBackoff(task.consecutiveErrors)).toISOString();
    } else {
      task.status = 'failed';
    }
    await putTask(task);

    // Notify user of error — but for scheduled tasks that will retry, stay quiet
    const willRetry = task.schedule && task.status === 'waiting';
    if (!willRetry && task.channelId) {
      const isExtErr = err?.message?.includes('extension');
      const notice = isExtErr
        ? `Extension error: ${task.lastError}\n\nMake sure the Runbook AI extension side panel is opened.`
        : `Error: ${task.lastError}`;
      await deliver(task, notice);
    }
  } finally {
    hideProcessing();
  }
}

// ── Public API for commands ─────────────────────────────────────────────────

/** List all tasks (optionally filtered by status). */
export async function listTasks(statusFilter) {
  if (statusFilter) return getTasksByStatus(statusFilter);
  return getAllTasks();
}

/** Cancel a task — marks it as failed and removes from queue. */
export async function cancelTask(id) {
  const task = await getTask(id);
  if (!task) return null;
  task.status    = 'failed';
  task.nextRunAt = null;
  task.lastError = 'Cancelled by user';
  await putTask(task);
  const idx = readyQueue.indexOf(id);
  if (idx !== -1) readyQueue.splice(idx, 1);
  return task;
}

/** Pause a scheduled task. */
export async function pauseTask(id) {
  const task = await getTask(id);
  if (!task || !task.schedule) return null;
  task.status = 'paused';
  await putTask(task);
  return task;
}

/** Resume a paused task. */
export async function resumeTask(id) {
  const task = await getTask(id);
  if (!task || task.status !== 'paused') return null;
  task.status    = 'waiting';
  task.nextRunAt = computeNextRun(task.schedule);
  await putTask(task);
  return task;
}

/** Remove a task entirely. */
export async function removeTask(id) {
  await deleteTask(id);
}

/** Rehydrate: on page load, re-enqueue any tasks that were 'queued' or 'running'. */
export async function rehydrate() {
  const queued  = await getTasksByStatus('queued');
  const stuck   = await getTasksByStatus('running');
  for (const task of [...stuck, ...queued]) {
    task.status = 'queued';
    await putTask(task);
    if (!readyQueue.includes(task.id)) {
      readyQueue.push(task.id);
    }
  }
  if (readyQueue.length > 0 && !running) drainQueue();
}
