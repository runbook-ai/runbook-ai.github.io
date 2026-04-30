# Bot E2E Test Procedure

End-to-end testing of the bot page using Chrome DevTools MCP.

## Prerequisites

1. Chrome browser with Runbook AI extension installed and side panel open
2. Chrome DevTools MCP server connected (`chrome-devtools-mcp`)
3. Two tabs open:
   - **Tab 1**: Bot page at `http://localhost:9003/bot/` (with bot token configured and connected to Discord)
   - **Tab 2**: Discord DM page with the RunbookAI Bot (`https://discord.com/channels/@me/<channel_id>`)
4. Bot page must show "Connected as RunbookAI Bot" before starting tests

## Constraints

- CDP is occupied by chrome-devtools-mcp, so the extension cannot use CDP-dependent actions (click, type on pages)
- Extension CAN do: `navigateToUrl`, pure computation, summarize page content
- Use tasks that don't require page interaction (e.g. "navigate to X and read the title")

## Important notes

- Always use `bringToFront: true` when calling `select_page` — clicking
  and typing into elements on background tabs will fail with timeout errors.
- Always take a fresh `take_snapshot` after `select_page` before interacting
  with elements — stale snapshots reference elements that no longer exist.
- Do NOT use `click` on Discord's message input textbox — it times out due
  to Discord's Slate editor. Instead, use `type_text` directly after
  `select_page` — Discord auto-focuses the message input.
- The Runbook AI extension side panel must be open for tasks to execute.
  Commands like `!help` and `!tasks` work without the extension, but
  free-form tasks require it.

## Test Procedure

### Phase 1: Verify bot page loads correctly

1. `list_pages` — identify bot page and Discord page IDs
2. `select_page` the bot page (with `bringToFront: true`)
3. `take_snapshot` — verify page rendered (settings, activity log, connect button or "Connected" status)
4. `list_console_messages` — check for:
   - `[cron] scheduler started` (cron module loaded)
   - `[app] task rehydration complete` (task-manager + IndexedDB initialized)
   - No JS errors
5. `evaluate_script` — verify IndexedDB exists:
   ```js
   async () => {
     const dbs = await indexedDB.databases();
     return dbs.map(d => d.name);
   }
   ```
   Expect: array includes `"runbookai_tasks"`

### Phase 2: Verify Discord connection

1. `take_snapshot` on bot page — confirm status text says "Connected as RunbookAI Bot"
2. If not connected, click the Connect button and wait for status change

### Phase 3: Test `!help` command

1. `select_page` Discord tab (with `bringToFront: true`) (with `bringToFront: true`)
2. `take_snapshot` to get fresh element UIDs
2. `type_text` `!help` with `submitKey: "Enter"`
4. `wait_for` text `["!schedule", "!tasks"]` (timeout 15s)
5. Verify response includes all commands: `!run`, `!schedule`, `!tasks`, `!cancel`, `!pause`, `!resume`, `!remove`, `!help`

### Phase 4: Test free-form task execution

1. `type_text` `navigate to https://example.com and read the page title` with `submitKey: "Enter"`
3. `select_page` bot page (with `bringToFront: true`)
4. `take_snapshot` — verify activity log shows incoming message and "Bot thinking"
5. `evaluate_script` — query IndexedDB for the task:
   ```js
   async () => {
     const db = await new Promise((resolve, reject) => {
       const req = indexedDB.open('runbookai_tasks', 1);
       req.onsuccess = () => resolve(req.result);
       req.onerror = () => reject(req.error);
     });
     const tx = db.transaction('tasks', 'readonly');
     const store = tx.objectStore('tasks');
     const all = await new Promise((resolve, reject) => {
       const req = store.getAll();
       req.onsuccess = () => resolve(req.result);
       req.onerror = () => reject(req.error);
     });
     return all.map(t => ({
       id: t.id, status: t.status, prompt: t.prompt.slice(0, 80),
       runCount: t.runCount, schedule: t.schedule,
       consecutiveErrors: t.consecutiveErrors, lastError: t.lastError,
       result: t.result ? t.result.slice(0, 100) : null,
     }));
   }
   ```
6. Wait for task to complete (poll IndexedDB or wait ~30-60s)
7. Verify: `status: "completed"`, `runCount: 1`, `consecutiveErrors: 0`, `result` contains "Example Domain"
8. `select_page` Discord tab (with `bringToFront: true`) — `take_snapshot` to verify bot replied with "Example Domain"

### Phase 5: Test `!schedule` command

1. `type_text` `!schedule 1m navigate to https://example.com and tell me the page title` with `submitKey: "Enter"`
3. `wait_for` text `["Scheduled task"]` (timeout 15s)
4. Verify bot response includes task ID and "First run starting now"
5. `select_page` bot page (with `bringToFront: true`)
6. `evaluate_script` — verify task in IndexedDB:
   - `status: "queued"` or `"running"` (first run is immediate)
   - `schedule: { type: "every", intervalMs: 60000 }`
7. Wait for first run to complete (~30s)
8. `evaluate_script` — verify `runCount: 1`, `status: "waiting"`, `nextRunAt` is set ~1m in future
9. Wait for cron to fire (~60s more)
10. `list_console_messages` — look for `[app] cron fired for task <id>`
11. `evaluate_script` — verify `runCount: 2`
12. `select_page` Discord tab (with `bringToFront: true`) — verify two result messages delivered

### Phase 6: Test `!tasks` command

1. `type_text` `!tasks` with `submitKey: "Enter"`
3. `wait_for` text containing a task ID (timeout 15s)
4. Verify response lists tasks with:
   - Status icons (⏰ waiting, ✅ completed, ▶ running, etc.)
   - Task IDs
   - Schedule info for recurring tasks (e.g. "(every 1m)")
   - Prompt preview

### Phase 7: Test `!cancel` command

1. Note the scheduled task ID from Phase 5
2. `click` Discord message input
3. `type_text` `!cancel <task_id>` with `submitKey: "Enter"`
4. `wait_for` text `["Cancelled task"]` (timeout 15s)
5. Verify response says "Cancelled task `<id>`."
6. `select_page` bot page (with `bringToFront: true`) — `evaluate_script` to verify task `status: "failed"`, `lastError: "Cancelled by user"`
7. Confirm no further cron runs for this task

### Phase 8: Test `!pause` and `!resume` (optional)

1. Create a new scheduled task: `!schedule 2m test pause resume`
2. Wait for first run to complete
3. Send `!pause <id>` — verify response and task `status: "paused"` in IndexedDB
4. Wait past the interval — confirm no cron fire
5. Send `!resume <id>` — verify response and task `status: "waiting"` with `nextRunAt` set
6. Cancel the task to clean up: `!cancel <id>`

## Group DM Mode Tests

Enable "Force group DM mode" in the bot page Configuration section before
running these tests. This treats the 1:1 DM channel as a group DM so the
triage path is exercised.

### Phase G1: Verify group mode is active

1. `select_page` bot page (with `bringToFront: true`)
2. `take_snapshot` — expand Configuration if needed
3. Verify "Force group DM mode" checkbox is checked
4. If not, `click` the checkbox and verify `forceGroupMode: true` in localStorage

### Phase G2: Test `!help` command in group mode

1. `select_page` Discord tab (with `bringToFront: true`)
2. `type_text` `!help` with `submitKey: "Enter"`
3. `select_page` bot page (with `bringToFront: true`)
4. Verify activity log shows incoming `!help` and outgoing commands list
5. `select_page` Discord tab (with `bringToFront: true`) — verify response is **reply-linked** to the command message

### Phase G3: Test triager reply (simple question)

1. `type_text` `what are you working on?` with `submitKey: "Enter"`
2. `select_page` bot page (with `bringToFront: true`)
3. Wait for response, verify activity log shows outgoing reply
4. Check console for `[triage] 1 action(s): reply`
5. `select_page` Discord tab (with `bringToFront: true`) — verify response is **flat** (no "replying to" header)

### Phase G4: Test triager add_task (task request)

1. `type_text` `check the title of example.com` with `submitKey: "Enter"`
2. `select_page` bot page (with `bringToFront: true`)
3. Check console for `[triage] 1 action(s): add_task`
4. Wait for task to complete (poll IndexedDB or wait ~30s)
5. Verify task record has `channelMode: 'group'` and `label` is set
6. `select_page` Discord tab (with `bringToFront: true`) — verify:
   - Response is **flat** (no "replying to" header)
   - Response is prefixed with **[label]** (e.g. `[check example.com title]`)

### Phase G5: Test triager skip (irrelevant message)

1. `type_text` `hey bob how's it going` with `submitKey: "Enter"`
2. `select_page` bot page (with `bringToFront: true`)
3. Wait ~15s, verify no outgoing message in activity log
4. Check console for `[triage] 1 action(s): skip`

### Phase G6: Test mention in incoming message

This tests that the bot correctly handles messages where it is @mentioned.

1. `select_page` Discord tab (with `bringToFront: true`)
2. `type_text` `@RunbookAI Bot what is 3+3` with `submitKey: "Enter"`
   (Discord auto-completes the mention to `<@BOT_ID>`)
3. `select_page` bot page (with `bringToFront: true`)
4. Verify the message was received (appears in activity log)
5. Check console — the triager should process it (not skip)
6. Verify the bot creates a task or replies

### Phase G7: Test mention in outgoing message

This tests that the bot can tag other participants in its responses.
Requires channel participants to be available in the triager/planner context.

1. `select_page` bot page (with `bringToFront: true`)
2. `evaluate_script` to verify participants are cached:
   ```js
   () => {
     // Access the module's internal state via a test helper
     const log = document.getElementById('logContainer').innerText;
     return log.includes('participants:');
   }
   ```
3. Check console for `[handler] channel ... participants: ...` log line
4. `select_page` Discord tab (with `bringToFront: true`)
5. `type_text` a prompt that asks the bot to mention someone, e.g.:
   `tell runbookai that the task is done`
6. Verify the bot's response includes a `<@USER_ID>` mention (rendered as
   a clickable @mention in Discord)

### Phase G8: Test reply-linked messages are ignored

1. `select_page` Discord tab (with `bringToFront: true`)
2. Reply to an existing message (use Discord's reply UI)
3. `select_page` bot page (with `bringToFront: true`)
4. Verify the replied message does NOT appear in activity log
5. Check console — no triage log for that message

## Local Chat Mode Tests

The bot page exposes an in-browser chat panel (#chatPanel) that creates tasks
with `channelId = LOCAL_CHANNEL_ID` (`local:ui`). Replies render directly in
the page — no Discord call. Tests run entirely on the bot page and do not
require the Discord tab.

Notes:
- Same CDP constraint as Discord tests: free-form prompts that drive the
  extension still require the extension's CDP actions to be free. Use
  CDP-free prompts (e.g. "what is 2+2", or `!help`/`!tasks`).
- Use `#chatInput` / `#chatSend` (or press Enter) to send. Bot responses
  render as `.log-entry.outgoing` with the bot's task id on `data-task-id`.

### Phase L1: Verify chat panel renders

1. `select_page` bot page (with `bringToFront: true`)
2. `take_snapshot` — confirm `#chatPanel` is visible (not `.hidden`),
   `#chatFeed` shows the empty state, and `#chatInput` is enabled
3. Verify `Settings` and `Monitor` buttons exist in the nav

### Phase L2: Test `!help` in local chat

1. `fill` `#chatInput` with `!help`, then click `#chatSend` (or press Enter)
2. `wait_for` text including `!schedule` and `!tasks` in the chat feed
3. Verify the response lists: `!run`, `!schedule`, `!tasks`, `!cancel`,
   `!pause`, `!resume`, `!help`
4. Confirm the user message appears as `.log-entry` with author "You" and
   the bot reply as `.log-entry.outgoing` with author "Bot"

### Phase L3: Test `!tasks` in local chat

1. Send `!tasks` via the chat input
2. `wait_for` either `No tasks.` or a list with status icons
3. If tasks exist, verify each line includes a status icon
   (⏰/✅/▶/⏳/⏸/❌) and a task id

### Phase L4: Test free-form chat (CDP-free task)

1. Send `what is 2+2 — answer with just the number` via the chat input
2. `take_snapshot` — verify the typing indicator (`#chatTyping`) appears
3. Wait for typing to disappear and a bot reply containing `4`
4. `evaluate_script` IndexedDB query (same as Phase 4 step 5) — verify
   the most recent task has `channelId: 'local:ui'`, `status: 'completed'`,
   `runCount: 1`

### Phase L5: Test reply-threaded continuation

1. Hover the bot's last `.log-entry.outgoing` — `.reply-btn` becomes visible
2. `click` the reply button
3. Verify `#chatReplyBanner` is visible with a preview of the bot message
4. Send `and times 3?` via the chat input
5. Wait for a bot reply containing `12`
6. `evaluate_script` — verify the new exchange continued the same task
   (same task id, `runCount` incremented), not a new task

### Phase L6: Test `!schedule` and `!cancel` in local chat

1. Send `!schedule 1m what is 5+5 — answer with just the number`
2. `wait_for` text `Scheduled task` containing a task id
3. Note the task id (extract from the bot reply)
4. `evaluate_script` — verify task has
   `schedule: { type: 'every', intervalMs: 60000 }` and
   `channelId: 'local:ui'`
5. Wait for the first run (~30–60s) — bot reply with `10` appears
6. Send `!cancel <id>` — verify response says `Cancelled task <id>`
7. `evaluate_script` — verify `status: 'failed'`,
   `lastError: 'Cancelled by user'`

## Monitor Feature Tests

The Monitor panel (#monitorPanel, toggled by `#monitorPanelBtn`) lists
all active agents and watches. Watch tasks (`type: 'monitor'`) poll a
Chrome tab's DOM and fire the planner only when content changes.
`monitor.js` builds a tree-aware unified diff of the DOM between polls.

Notes:
- Creating a real watch requires the extension (it calls `fetchWebPage`),
  so these tests need the extension connected and a CDP-free polling
  scenario. CDP being occupied by chrome-devtools-mcp prevents the
  extension from clicking/typing — but `fetchWebPage` does not need
  CDP page-action access, so polling works.
- The monitor tick runs every 2s; warm-up absorbs the first 2 polls,
  so real triggers fire from poll 3 onward (see monitor.js).

### Phase M1: Verify Monitor panel renders

1. `select_page` bot page (with `bringToFront: true`)
2. `click` `#monitorPanelBtn`
3. `take_snapshot` — verify `#monitorPanel` is visible, `#chatPanel` is
   hidden, and the panel shows either the empty state
   (`.agent-empty`: "No active agents or watches…") or one or more
   `.agent-row` entries
4. `list_console_messages` — confirm `[task-manager] monitor tick started`
   appeared at boot

### Phase M2: Active task appears in Monitor

1. From the chat panel, send `!schedule 2m what is 7+7 — answer with just the number`
2. `click` `#monitorPanelBtn`
3. `take_snapshot` — verify a `.agent-row` exists with:
   - `.agent-row__label` containing the prompt preview
   - `.agent-dot--running`, `--queued`, `--waiting`, or `--paused` class
   - A meta line including `Scheduled · every 2m` (and `next in …` once
     the first run completes)
4. Verify a `data-action="cancel"` button is present on the row

### Phase M3: Pause / Resume / Cancel actions

1. With the scheduled task from M2 visible in the Monitor list, wait for
   its first run to complete (status reaches `waiting`)
2. `click` the `Pause` button on its row
3. `take_snapshot` — verify the dot becomes `.agent-dot--paused` and the
   `Resume` button replaces `Pause`
4. `evaluate_script` — verify task `status: 'paused'` in IndexedDB
5. `click` `Resume` — verify dot returns to `.agent-dot--waiting` and
   `nextRunAt` is set
6. `click` the `✕` cancel button — verify the row disappears within 3s
   (the panel polls every 3s) and IndexedDB shows `status: 'failed'`,
   `lastError: 'Cancelled by user'`

### Phase M4: Create a watch on a live page

1. `new_page` to `https://example.com` — keep this tab open
2. `evaluate_script` on the bot page to read the example.com tab id from
   `chrome.tabs.query` is not available; instead use the chat to instruct
   the bot. Switch to the bot page and send via local chat:
   `watch this tab and tell me if anything changes` (the planner picks
   the active extension tab — example.com)
3. Wait for the bot to acknowledge with a `Watching …` reply
4. `click` `#monitorPanelBtn` on the bot page
5. `take_snapshot` — verify a row exists with:
   - `.agent-dot--watching` class (purple, animated)
   - Meta line beginning with `Watch · polls every …`
6. `evaluate_script` IndexedDB — verify task has `type: 'monitor'`,
   `status: 'waiting'`, and `config.tabId` set

### Phase M5: Watch fires on DOM change

1. With the example.com watch from M4 active, switch to the example.com
   tab and `evaluate_script`:
   ```js
   () => { document.querySelector('h1').textContent = 'Changed Heading'; return true; }
   ```
2. Switch to the bot page; wait ~10s for two more poll cycles to clear
   warm-up and detect the change
3. `list_console_messages` — confirm a `[planner]` log fired for the
   monitor task (planner invoked because diff was non-empty)
4. Verify a bot reply appears in the chat feed mentioning the change
5. `evaluate_script` — verify the monitor task `runCount` incremented and
   `lastRunAt` is recent

### Phase M6: Cancel the watch

1. In the Monitor panel, click `✕` on the watch row
2. `take_snapshot` — verify the row is gone
3. `evaluate_script` — verify monitor task `status: 'failed'`,
   `lastError: 'Cancelled by user'`
4. Confirm no further poll log lines for this task id

## Cleanup

After testing, cancel/remove any remaining scheduled tasks:
1. Send `!tasks` to list all
2. `!cancel <id>` for any active/waiting tasks
3. Optionally `!remove <id>` to delete from IndexedDB

## Quick Smoke Test (minimal)

If time is limited, run just these:

1. Load bot page — check console for `[cron] scheduler started` and `[app] task rehydration complete`
2. Send `!help` from Discord — verify new commands listed
3. Send a free-form message — verify bot executes and replies
4. Send `!schedule 1m <prompt>` — verify first run is immediate, cron fires after 1m
5. Send `!cancel <id>` — verify task stops
