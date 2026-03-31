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
import { appendDailyMemory } from './memory-store.js';

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
    const planResult = await runPlan(task);

    // Re-read from DB to check if task was cancelled during execution
    const freshTask = await getTask(task.id);
    if (freshTask && freshTask.status === 'failed' && freshTask.lastError === 'Cancelled by user') {
      return; // Task was cancelled while running — don't overwrite
    }

    task.result            = planResult.result || 'Task completed with no result.';
    task.consecutiveErrors = 0;
    task.lastError         = null;

    // Replace memory — model returns full snapshot each run, old fields are discarded
    if (planResult.memory && typeof planResult.memory === 'object') {
      const { history, __childStatuses, __runSummary, __trajectory, __browseTrajectories, __pendingFollowUp } = task.context;
      task.context = { history, __childStatuses, __runSummary, __trajectory, __browseTrajectories, __pendingFollowUp, ...planResult.memory };
    }

    // Save cumulative run summary for recurring tasks
    if (planResult.runSummary) {
      task.context.__runSummary = planResult.runSummary;
    }

    // Flush learnings to global daily memory
    if (planResult.learnings && Array.isArray(planResult.learnings) && planResult.learnings.length > 0) {
      appendDailyMemory(planResult.learnings).catch(err => {
        console.warn('[task-manager] failed to save learnings:', err);
      });
    }

    // Save full planner trajectory (last run only)
    if (planResult.trajectory) {
      task.context.__trajectory = planResult.trajectory;
    }

    // Save browse-level trajectories (last run only)
    if (planResult.browseTrajectories && planResult.browseTrajectories.length > 0) {
      task.context.__browseTrajectories = planResult.browseTrajectories;
    } else {
      delete task.context.__browseTrajectories;
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

    // If this child finished a run, wake the parent — but only when:
    // - no siblings are still actively executing (queued/running)
    // - the child had something to report (not silent)
    // If the parent is already completed/failed, deliver the child result directly.
    let childDeliveredDirectly = false;
    if (task.parentId && !planResult.silent && (task.status === 'completed' || task.status === 'waiting')) {
      const siblings = await getChildTasks(task.parentId);
      const anyActive = siblings.some(s => s.status === 'queued' || s.status === 'running');
      if (!anyActive) {
        const parent = await getTask(task.parentId);
        if (parent && parent.status === 'waiting') {
          parent.nextRunAt = new Date().toISOString(); // wake immediately on next cron tick
          await putTask(parent);
        } else if (parent && ['completed', 'failed'].includes(parent.status) && task.channelId) {
          // Parent is done — deliver child result directly since no one else will
          await deliver(task, task.result);
          childDeliveredDirectly = true;
        }
      }
    }

    // Deliver final result
    // - Child tasks deliver only if parent is gone (handled above)
    // - Planner can set silent=true to suppress delivery (e.g. nothing new to report)
    const isChildTask = !!task.parentId;
    if (!isChildTask && !planResult.silent && task.channelId) {
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

    // Check for pending follow-up (user replied while task was running)
    const freshTask = await getTask(task.id);
    if (freshTask?.context?.__pendingFollowUp) {
      const followUp = freshTask.context.__pendingFollowUp;
      delete freshTask.context.__pendingFollowUp;
      await putTask(freshTask, { skipSync: true });
      await continueTask(freshTask, followUp.prompt, {
        files: followUp.files,
        replyToId: followUp.replyToId,
      });
    }
  }
}

// ── Public API for commands ─────────────────────────────────────────────────

/** List all tasks (optionally filtered by status). */
export async function listTasks(statusFilter) {
  if (statusFilter) return getTasksByStatus(statusFilter);
  return getAllTasks();
}

/** Cancel a task and all its children recursively. */
export async function cancelTask(id) {
  const task = await getTask(id);
  if (!task) return null;
  task.status    = 'failed';
  task.nextRunAt = null;
  task.lastError = 'Cancelled by user';
  await putTask(task);
  const idx = readyQueue.indexOf(id);
  if (idx !== -1) readyQueue.splice(idx, 1);
  // Recursively cancel children
  const children = await getChildTasks(id);
  for (const child of children) {
    if (['queued', 'running', 'waiting', 'paused'].includes(child.status)) {
      await cancelTask(child.id);
    }
  }
  return task;
}

/**
 * Find a root task (no parent) whose replyToId matches the given message ID.
 * Returns the task or null.
 */
export async function findRootTaskByReplyToId(messageId) {
  const all = await getAllTasks();
  return all.find(t => t.replyToId === messageId && !t.parentId) || null;
}

/**
 * Continue an existing task with new user input.
 * Appends the message to conversation history and re-enqueues.
 * If the task is currently running, queues the follow-up for after it completes.
 */
export async function continueTask(task, newPrompt, { files, replyToId } = {}) {
  if (task.status === 'running') {
    // Task is mid-execution — store the follow-up so executeTask can pick it up
    if (!task.context) task.context = {};
    task.context.__pendingFollowUp = { prompt: newPrompt, files, replyToId };
    await putTask(task);
    return task;
  }
  // Append current prompt+result as history before adding new input
  if (!task.context) task.context = {};
  if (!task.context.history) task.context.history = [];
  if (task.result) {
    task.context.history.push({ role: 'user', content: task.prompt });
    task.context.history.push({ role: 'assistant', content: task.result });
  }
  // Update prompt to the new user input
  task.prompt = newPrompt;
  if (replyToId) task.replyToId = replyToId;
  if (files && Object.keys(files).length > 0) {
    task.files = { ...(task.files || {}), ...files };
  }
  task.status = 'queued';
  task.nextRunAt = null;
  task.lastError = null;
  await enqueueTask(task);
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
