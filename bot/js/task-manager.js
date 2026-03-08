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
  getChildTasks, putMessageMapping,
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
    const sent = await deliverFn(task, message);
    // Record the sent message in the message map for reply-chain tracing
    if (sent?.id) {
      await putMessageMapping(sent.id, task.id);
    }
    return sent;
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
export async function createAndEnqueue({ prompt, files, config, channelId, replyToId, createdBy, schedule, maxRuns }) {
  const task = createTaskRecord({
    prompt,
    files: files ?? {},
    config,
    channelId,
    replyToId,
    createdBy,
    schedule: schedule ?? null,
    maxRuns: maxRuns ?? null,
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
  task.lastRunAt = Date.now();
  task.runCount += 1;
  await putTask(task);

  if (task.channelId) {
    showProcessing(task.channelId);
    if (typingFn) typingFn(task);
  }

  try {
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

    // Deliver final result
    // For recurring scheduled tasks still waiting, skip delivery — only notify
    // when the task completes (stop condition met or max runs reached) or
    // when the planner explicitly used notify_user during execution.
    const isQuietRun = task.schedule && task.status === 'waiting';
    if (!isQuietRun && task.delivery !== 'silent' && task.channelId) {
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
      task.nextRunAt = Date.now() + computeBackoff(task.consecutiveErrors);
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

// ── Follow-up handling ──────────────────────────────────────────────────────

/**
 * Apply a user follow-up message to an existing task.
 * Appends to conversation history and re-enqueues for immediate execution.
 *
 * @param {string} taskId - The task to follow up on
 * @param {string} userMessage - The user's follow-up message
 * @param {string} [replyToId] - The message ID to reply to (the follow-up message)
 * @returns {object|null} The updated task, or null if not found
 */
export async function applyFollowUp(taskId, userMessage, replyToId, files) {
  const task = await getTask(taskId);
  if (!task) return null;

  // Merge any new attached files into the task
  if (files && Object.keys(files).length > 0) {
    task.files = { ...(task.files || {}), ...files };
  }

  // Append user's follow-up to conversation history (with inline images if any)
  task.context.history = task.context.history || [];
  const imageEntries = Object.entries(files || {}).filter(([, f]) => f.mimeType?.startsWith('image/'));
  if (imageEntries.length > 0) {
    const parts = [{ type: 'text', text: userMessage || '(see attached images)' }];
    for (const [name, f] of imageEntries) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${f.mimeType};base64,${f.base64}` },
      });
      parts.push({ type: 'text', text: `(image: ${name})` });
    }
    task.context.history.push({ role: 'user', content: parts });
  } else {
    task.context.history.push({ role: 'user', content: userMessage });
  }

  // Update replyToId so the bot's response threads to the follow-up message
  if (replyToId) {
    task.replyToId = replyToId;
  }

  // Propagate context updates to active child cron tasks
  const children = await getChildTasks(taskId);
  for (const child of children) {
    if (child.status === 'waiting' || child.status === 'queued' || child.status === 'paused') {
      child.context.history = task.context.history;
      await putTask(child);
    }
  }

  // Re-enqueue the task for immediate execution
  await enqueueTask(task);

  return task;
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
