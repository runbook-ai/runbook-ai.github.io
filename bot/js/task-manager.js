/**
 * Task manager — lifecycle, serial execution, and chaining.
 *
 * Orchestrates the task queue:
 *   1. Accepts tasks from message-handler or cron
 *   2. Executes them serially via the Chrome extension
 *   3. Parses results for follow-up scheduling
 *   4. Manages task state transitions in IndexedDB
 */

import { loadSettings } from './settings.js';
import {
  putTask, getTask, createTaskRecord,
  getTasksByStatus, getAllTasks, deleteTask,
} from './task-store.js';
import { computeNextRun, computeBackoff } from './cron.js';
import { logMessage, logSystem, showProcessing, hideProcessing } from './ui.js';
import { sendDiscordMessage, triggerTyping, addReaction } from './discord.js';

const EXTENSION_ID = 'kjbhngehjkiiecaflccjenmoccielojj';

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

/** Create and enqueue a new task from a Discord message. */
export async function createAndEnqueue({ prompt, config, channelId, replyToId, createdBy, schedule }) {
  const task = createTaskRecord({
    prompt,
    config,
    channelId,
    replyToId,
    createdBy,
    schedule: schedule ?? null,
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
  const s = loadSettings();

  task.status    = 'running';
  task.lastRunAt = Date.now();
  task.runCount += 1;
  await putTask(task);

  if (task.channelId) {
    showProcessing(task.channelId);
    triggerTyping(task.channelId, s.botToken);
  }

  class ExtensionError extends Error {}

  try {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      throw new ExtensionError('Runbook AI extension is not available on this page');
    }

    const openResp = await chrome.runtime.sendMessage(EXTENSION_ID, { action: 'openSidePanel' });
    if (openResp?.error) throw new ExtensionError(openResp.message || openResp.error);

    await new Promise(r => setTimeout(r, 500));

    // Build the prompt with injected context from prior runs
    const fullPrompt = buildPrompt(task);

    const configResp = await chrome.runtime.sendMessage(EXTENSION_ID, {
      action: 'setRemoteConfig',
      args: {
        config: {
          ...task.config,
          ...(s.freeApiKey ? {
            llmBaseUrl: 'https://llm.runbookai.net/v1',
            llmApiKey:  'free',
          } : {}),
          returnTaskState: true,
        },
      },
    });
    if (configResp?.error) throw new ExtensionError(configResp.message || configResp.error);

    const taskResp = await chrome.runtime.sendMessage(EXTENSION_ID, {
      action: 'runHeadlessTask',
      args: { prompt: fullPrompt },
    });

    if (taskResp?.error) throw new Error(taskResp.message || taskResp.error);

    // Switch back to bot tab
    const botUrl = document.location.href;
    const botTab = taskResp?.taskState?.tabs?.find(t => t.url && t.url === botUrl);
    if (botTab?.tabId != null) {
      chrome.runtime.sendMessage(EXTENSION_ID, {
        action: 'switchToTab',
        args: { tabId: botTab.tabId },
      }).catch(() => {});
    }

    const rawResult = taskResp?.taskResult?.result || 'Task completed with no result.';

    // Try to parse structured result
    const parsed = parseResult(rawResult);

    task.result            = parsed.result || rawResult;
    task.consecutiveErrors = 0;
    task.lastError         = null;

    // Merge memory from this run into persistent context
    if (parsed.memory && typeof parsed.memory === 'object') {
      task.context = { ...task.context, ...parsed.memory };
    }

    // Handle follow-up task creation
    if (parsed.followUp) {
      await handleFollowUp(task, parsed.followUp);
    }

    // Decide next state
    if (task.schedule) {
      // Recurring task: compute next run and go to 'waiting'
      if (task.maxRuns && task.runCount >= task.maxRuns) {
        task.status    = 'completed';
        task.nextRunAt = null;
      } else if (task.schedule.type === 'at') {
        // One-shot scheduled task — done
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

    // Deliver result to Discord
    if (task.delivery !== 'silent' && task.channelId) {
      const reply = task.result;
      await sendDiscordMessage(task.channelId, reply, s.botToken, task.replyToId);
      logMessage({ channel_id: task.channelId, content: reply }, 'outgoing');
    }

  } catch (err) {
    console.error('[task-manager] executeTask failed:', err);

    task.consecutiveErrors += 1;
    task.lastError = err?.message ?? String(err);

    if (task.schedule && task.consecutiveErrors < 5) {
      // Retry with backoff
      task.status    = 'waiting';
      task.nextRunAt = Date.now() + computeBackoff(task.consecutiveErrors);
    } else {
      task.status = 'failed';
    }
    await putTask(task);

    // Notify Discord of error
    if (task.channelId) {
      const isExtErr = err instanceof ExtensionError;
      const notice = isExtErr
        ? `Extension error: ${task.lastError}\n\nMake sure the Runbook AI extension side panel is opened.`
        : `Error: ${task.lastError}`;
      await sendDiscordMessage(task.channelId, notice, s.botToken, task.replyToId).catch(() => {});
      logMessage({ channel_id: task.channelId, content: notice }, 'outgoing');
    }
  } finally {
    hideProcessing();
  }
}

// ── Prompt building ─────────────────────────────────────────────────────────

function buildPrompt(task) {
  let prompt = task.prompt;

  // Inject context from prior runs if any
  if (task.context && Object.keys(task.context).length > 0) {
    prompt += '\n\n---TASK CONTEXT (from prior runs)---\n';
    prompt += JSON.stringify(task.context, null, 2);
    prompt += '\n---END TASK CONTEXT---';
  }

  // Instruct the agent to structure its output
  if (task.schedule || task.parentId) {
    prompt += '\n\n---OUTPUT FORMAT---\n';
    prompt += 'When done, structure your final result as JSON with these fields:\n';
    prompt += '- "result": string — your findings or actions taken (this is shown to the user)\n';
    prompt += '- "memory": object — key data to persist for the next run (e.g. listings found, emails sent)\n';
    prompt += '- "followUp": { "prompt": string, "schedule": { "type": "every", "intervalMs": number } } — optional, to schedule a follow-up task\n';
    prompt += 'If you cannot structure as JSON, just return your result as plain text.\n';
    prompt += '---END OUTPUT FORMAT---';
  }

  return prompt;
}

// ── Result parsing ──────────────────────────────────────────────────────────

function parseResult(raw) {
  // Try to extract JSON from the result (may be wrapped in markdown code block)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/^(\{[\s\S]*\})$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch { /* fall through */ }
  }
  // Try raw parse
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* fall through */ }
  return { result: raw };
}

// ── Follow-up handling ──────────────────────────────────────────────────────

async function handleFollowUp(parentTask, followUp) {
  const childTask = createTaskRecord({
    parentId:  parentTask.id,
    prompt:    followUp.prompt,
    config:    parentTask.config,
    context:   { ...parentTask.context },
    schedule:  followUp.schedule ?? null,
    nextRunAt: followUp.schedule ? computeNextRun(followUp.schedule) : null,
    status:    followUp.schedule ? 'waiting' : 'queued',
    channelId: parentTask.channelId,
    replyToId: parentTask.replyToId,
    delivery:  followUp.delivery ?? parentTask.delivery,
    createdBy: parentTask.createdBy,
  });
  await putTask(childTask);

  if (childTask.status === 'queued') {
    readyQueue.push(childTask.id);
  }

  console.log('[task-manager] created follow-up task', childTask.id, 'from', parentTask.id);
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
