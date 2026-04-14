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
