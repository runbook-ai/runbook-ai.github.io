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
import { runPlan, UserCancelledError } from './planner.js';
import { appendDailyMemory } from './memory-store.js';
import { runMonitorPoll } from './monitor.js';

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

/** Deliver a message for a task using the registered handler. Retries up to 3 times. */
async function deliver(task, message) {
  if (!deliverFn || !task.channelId) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await deliverFn(task, message);
    } catch (err) {
      console.error(`[task-manager] delivery failed (attempt ${attempt + 1}/3):`, err);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return null;
}

// ── Typing indicator callback ──────────────────────────────────────────────

let typingFn = null;

/** Register a typing indicator function: (task) => void */
export function setTypingHandler(fn) {
  typingFn = fn;
}

// ── Processing indicator hooks ────────────────────────────────────────────────

let processingStartFn = null;
let processingStopFn  = null;

/**
 * Register processing-indicator hooks. Called when a task begins and ends
 * executing, regardless of host. Bot page wires these to `showProcessing` /
 * `hideProcessing` on its feed; the extension sidepanel wires them to the
 * step strip.
 *   onStart: (task) => void
 *   onStop:  (task) => void
 */
export function setProcessingHandlers({ onStart, onStop } = {}) {
  processingStartFn = onStart || null;
  processingStopFn  = onStop  || null;
}

function showProcessing(task) { if (processingStartFn) processingStartFn(task); }
function hideProcessing(task) { if (processingStopFn)  processingStopFn(task);  }

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
export async function createAndEnqueue({ prompt, files, config, channelId, replyToId, createdBy, schedule, maxRuns, parentId, context, channelMode, label }) {
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
    channelMode: channelMode ?? null,
    label: label ?? null,
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
    showProcessing(task);
    if (typingFn) typingFn(task);
  }

  // Monitor fires go through their own narrower flow.
  if (task.type === 'monitor') {
    try {
      await executeMonitorFire(task);
    } finally {
      hideProcessing(task);
    }
    return;
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
    // Preserve all __ prefixed meta fields and history
    if (planResult.memory && typeof planResult.memory === 'object') {
      const preserved = {};
      for (const [k, v] of Object.entries(task.context)) {
        if (k === 'history' || k.startsWith('__')) preserved[k] = v;
      }
      task.context = { ...preserved, ...planResult.memory };
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

    // For recurring tasks with a follow-up, restore original prompt and save the exchange
    if (task.context?.__originalPrompt) {
      if (!task.context.history) task.context.history = [];
      task.context.history.push({ role: 'user', content: task.prompt });
      task.context.history.push({ role: 'assistant', content: task.result });
      task.prompt = task.context.__originalPrompt;
      delete task.context.__originalPrompt;
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

    // If this child finished a run:
    // 1. If parent is still active (waiting), wake it when all siblings are settled
    // 2. If parent is already done (completed/failed), deliver child result directly
    let childDeliveredDirectly = false;
    if (task.parentId && !planResult.silent && (task.status === 'completed' || task.status === 'waiting')) {
      const parent = await getTask(task.parentId);
      if (parent && parent.status === 'waiting') {
        // Wake parent only when no siblings are still actively executing
        const siblings = await getChildTasks(task.parentId);
        const anyActive = siblings.some(s => s.status === 'queued' || s.status === 'running');
        if (!anyActive) {
          parent.nextRunAt = new Date().toISOString(); // wake immediately on next cron tick
          await putTask(parent);
        }
      } else if (parent && ['completed', 'failed'].includes(parent.status) && task.channelId) {
        // Parent is done — deliver child result directly since no one else will
        await deliver(task, task.result);
        childDeliveredDirectly = true;
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
    hideProcessing(task);

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
 * Fallback: find a root task whose __lastReplyToId matches any message in the chain.
 * Used when the reply chain walk stops early (rate limit, broken chain) and the
 * root message doesn't match any task's replyToId.
 */
export async function findTaskByChainMessageIds(messageIds) {
  if (!messageIds || messageIds.size === 0) return null;
  const all = await getAllTasks();
  return all.find(t => !t.parentId && t.context?.__lastReplyToId && messageIds.has(t.context.__lastReplyToId)) || null;
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
  if (task.type === 'monitor') {
    // Monitors are driven by the monitor tick, not the main queue. Update the
    // instruction in place and keep status='waiting' so the next tick picks it up.
    if (!task.config) task.config = {};
    task.config.instruction = newPrompt;
    task.prompt = newPrompt;
    if (replyToId) {
      if (!task.context) task.context = {};
      task.context.__lastReplyToId = replyToId;
    }
    if (files && Object.keys(files).length > 0) {
      task.files = { ...(task.files || {}), ...files };
    }
    if (task.status === 'failed' || task.status === 'completed') {
      task.status = 'waiting';
      task.consecutiveErrors = 0;
      task.lastError = null;
    }
    task.nextRunAt = new Date().toISOString();
    await putTask(task);
    return task;
  }
  // Append current prompt+result as history before adding new input
  if (!task.context) task.context = {};
  if (!task.context.history) task.context.history = [];
  if (task.result) {
    // For recurring tasks, skip adding the original prompt again — it's always the main prompt.
    // Only add if this is a non-recurring task, or if the history is empty (first follow-up),
    // or if the current prompt is a follow-up (differs from original).
    const isRepeatedOriginal = task.schedule
      && task.context.history.length > 0
      && !task.context.__originalPrompt; // no __originalPrompt means prompt was restored = it's the original
    if (!isRepeatedOriginal) {
      task.context.history.push({ role: 'user', content: task.prompt });
      task.context.history.push({ role: 'assistant', content: task.result });
    }
  }
  // Update prompt to the new user input
  task.context.__hasNewInput = true;
  // For recurring tasks, save the original prompt so it can be restored after the follow-up
  if (task.schedule && !task.context.__originalPrompt) {
    task.context.__originalPrompt = task.prompt;
  }
  task.prompt = newPrompt;
  // Don't update replyToId — keep the original so reply chain root resolution still works
  // Track the latest message for Discord reply threading
  if (replyToId) task.context.__lastReplyToId = replyToId;
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

/**
 * Rehydrate on host (sidepanel / bot-page) reload.
 *
 * - `queued` agent/scheduled task → resume (never got to run, safe to execute).
 * - `running` agent task → fail terminally (mid-LLM call interrupted; don't
 *   silently redo an expensive run and don't risk state corruption).
 * - `running` recurring task → fail this run but bounce to 'waiting' with
 *   nextRunAt=now so cron fires the next scheduled occurrence.
 * - Any monitor task found in `queued`/`running` → reset to 'waiting' with
 *   nextRunAt=now; next monitor tick re-polls. Stashed
 *   `config.pendingMonitorEvents` is discarded (re-detected by fresh poll).
 */
export async function rehydrate() {
  const queued = await getTasksByStatus('queued');
  const stuck  = await getTasksByStatus('running');
  const now = new Date().toISOString();

  // Resume `queued` tasks (they never started).
  for (const task of queued) {
    if (task.type === 'monitor') {
      if (task.config) delete task.config.pendingMonitorEvents;
      task.status    = 'waiting';
      task.nextRunAt = now;
      await putTask(task, { skipSync: true });
      continue;
    }
    // Already 'queued' in IDB; just push onto the in-memory readyQueue.
    if (!readyQueue.includes(task.id)) readyQueue.push(task.id);
  }

  // Fail `running` tasks (interrupted mid-run).
  for (const task of stuck) {
    if (task.type === 'monitor') {
      if (task.config) delete task.config.pendingMonitorEvents;
      task.status    = 'waiting';
      task.nextRunAt = now;
      await putTask(task, { skipSync: true });
      continue;
    }

    task.consecutiveErrors = (task.consecutiveErrors ?? 0) + 1;
    task.lastError = 'Interrupted by sidepanel close';

    if (task.schedule) {
      // Recurring — fail this run, keep the task alive for its next fire.
      task.status    = 'waiting';
      task.nextRunAt = now;
    } else {
      // One-shot — fail terminally. User can re-send if they want.
      task.status    = 'failed';
      task.nextRunAt = null;
    }
    await putTask(task, { skipSync: true });
  }

  if (readyQueue.length > 0 && !running) drainQueue();
}

// ── Monitor tick ──────────────────────────────────────────────────────────────

const MONITOR_TICK_MS = 2_000;
let monitorTickTimer  = null;

/**
 * Poll one monitor. Cheap: fetchWebPage + content-hash diff only. When the
 * poll detects events, stash them on the task and hand it off to the serial
 * readyQueue via enqueueTask(). The actual planner run (which contends for
 * the browser) happens inside `executeTask` → `executeMonitorFire`, so
 * simultaneous monitor fires are serialized with all other browser work
 * and never hit `task-already-running` from runHeadlessTaskWithConfig.
 *
 * If the poll doesn't fire, or fails with a non-fatal error, the task stays
 * 'waiting' and its nextRunAt is pushed by intervalMs. A tab-gone error
 * marks the task 'failed' and clears nextRunAt so the tick stops picking
 * it up (same behavior as before).
 */
async function pollMonitor(task) {
  task.lastRunAt = new Date().toISOString();

  try {
    const events = await runMonitorPoll(task);

    if (events.length > 0) {
      if (!task.config) task.config = {};
      // Stash for executeMonitorFire. Cleared after the fire runs so each
      // re-queue has its own batch.
      task.config.pendingMonitorEvents = events;
      task.status = 'queued';
      await putTask(task, { skipSync: true });
      if (!readyQueue.includes(task.id)) readyQueue.push(task.id);
      if (!running) drainQueue();
      return;
    }
  } catch (err) {
    console.error('[task-manager] pollMonitor error:', task.id, err);
    const errorMsg = err?.message ?? String(err);

    // Fail immediately if tab is gone — no point retrying
    if (errorMsg.includes('no longer available')) {
      task.status    = 'failed';
      task.nextRunAt = null;
      task.lastError = errorMsg;
      await putTask(task, { skipSync: true });
      return;
    }

    task.consecutiveErrors = (task.consecutiveErrors ?? 0) + 1;
    task.lastError = errorMsg;
  }

  // No fire this tick — reschedule the next poll.
  const intervalMs = task.schedule?.intervalMs ?? 60_000;
  task.status    = 'waiting';
  task.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  await putTask(task, { skipSync: true });
}

/**
 * Run the planner for a monitor whose poll detected events. Invoked from
 * executeTask (serialized with every other agent task through readyQueue).
 * Reads task.config.pendingMonitorEvents set by pollMonitor, builds the
 * fire prompt, runs the planner, saves the exchange, and resets status
 * to 'waiting' with a fresh nextRunAt so monitorTick picks it up again.
 */
async function executeMonitorFire(task) {
  if (!task.config) task.config = {};
  const events = task.config.pendingMonitorEvents || [];
  delete task.config.pendingMonitorEvents;

  if (events.length === 0) {
    // Shouldn't happen, but be defensive — bounce back to waiting.
    const intervalMs = task.schedule?.intervalMs ?? 60_000;
    task.status    = 'waiting';
    task.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    await putTask(task, { skipSync: true });
    return;
  }

  try {
    // Append to message history (bounded to 100 entries)
    if (!Array.isArray(task.config.messageHistory)) task.config.messageHistory = [];
    task.config.messageHistory.push({ at: new Date().toISOString(), events });
    if (task.config.messageHistory.length > 100) {
      task.config.messageHistory = task.config.messageHistory.slice(-100);
    }

    // Build prompt: user instruction first, then detected content below
    const instruction = task.config.instruction ?? task.prompt;
    const eventTexts  = events.map(e => e.text).join('\n\n');
    const url         = events[0]?.source ?? task.config.tabUrl ?? '';
    if (!task.config.instruction) task.config.instruction = instruction; // backfill for restore
    task.prompt =
      `${instruction}\n\n---\n\n` +
      `The watched page${url ? ' (' + url + ')' : ''} changed. Below is a unified diff ` +
      `produced by a content-hash DOM diff: lines starting with "-" are HTML present in the ` +
      `prior snapshot but not the current one; lines starting with "+" are HTML present now ` +
      `but not before; lines starting with " " (space) are unchanged structural context that ` +
      `aligns the two sides. Each line is a single tag or text node, indented to reflect ` +
      `nesting. Prefer to answer the user's instruction directly from this diff without ` +
      `calling browse — it is usually sufficient for summarization, notification, and ` +
      `similar tasks. Only call browse if the instruction genuinely needs information that ` +
      `isn't in the diff (e.g., opening a full email body, following a link). If the change ` +
      `isn't material to the instruction, call done with silent=true.\n\n` +
      `Diff:\n${eventTexts}`;

    // Inject event history into context so planner has full conversation thread
    if (!task.context) task.context = {};
    task.context.__monitorEvents = task.config.messageHistory.slice(-10);

    const planResult = await runPlan(task);

    // Persist result and update conversation history
    task.result = planResult.result || '';
    if (planResult.memory && typeof planResult.memory === 'object') {
      const preserved = {};
      for (const [k, v] of Object.entries(task.context)) {
        if (k === 'history' || k.startsWith('__')) preserved[k] = v;
      }
      task.context = { ...preserved, ...planResult.memory };
    }
    if (planResult.runSummary) task.context.__runSummary = planResult.runSummary;
    if (planResult.trajectory) task.context.__trajectory = planResult.trajectory;

    if (!task.context.history) task.context.history = [];
    task.context.history.push({ role: 'user',      content: task.prompt });
    task.context.history.push({ role: 'assistant', content: task.result });

    // Restore original prompt (instruction) for display
    task.prompt = task.config.instruction ?? task.prompt;

    task.consecutiveErrors = 0;
    task.lastError = null;

    if (task.result && task.channelId && !planResult.silent) {
      await deliver(task, task.result);
    }
  } catch (err) {
    console.error('[task-manager] executeMonitorFire error:', task.id, err);
    task.consecutiveErrors = (task.consecutiveErrors ?? 0) + 1;
    task.lastError = err?.message ?? String(err);
    // fall through to reset below so the tick keeps retrying
  }

  // Reset to waiting with next scheduled poll (unless already failed above)
  if (task.status === 'failed') return;
  const intervalMs = task.schedule?.intervalMs ?? 60_000;
  task.status    = 'waiting';
  task.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  await putTask(task, { skipSync: true });
}

/**
 * Monitor tick: every 2 s, polls all due monitors in parallel (cheap — each
 * poll is just fetchWebPage + hash diff, no browser agent). Polls that
 * detect events enqueue the task onto `readyQueue`, where the actual
 * planner run is serialized with every other browser task via drainQueue.
 */
async function monitorTick() {
  try {
    const waiting = await getTasksByStatus('waiting');
    const now     = Date.now();
    const due     = waiting.filter(t =>
      t.type === 'monitor' &&
      t.nextRunAt &&
      new Date(t.nextRunAt).getTime() <= now
    );
    if (due.length > 0) {
      await Promise.allSettled(due.map(t => pollMonitor(t)));
    }
  } catch (err) {
    console.error('[task-manager] monitorTick error:', err);
  }
}

/** Start the monitor scheduler. Call from app.js after rehydrate(). */
export function startMonitorTick() {
  if (monitorTickTimer) return;
  monitorTick(); // immediate first check
  monitorTickTimer = setInterval(monitorTick, MONITOR_TICK_MS);
  console.log('[task-manager] monitor tick started');
}
