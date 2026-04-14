# Group DM Message Handling Design

## Overview

Expand the bot from 1:1 DMs to group DMs where multiple humans and bots can
interact. The bot operates in two modes based on channel participant count,
keeping 1:1 behavior unchanged while adding intelligent triage for group
conversations.

## Operating modes

| Mode | Condition | Behavior |
|------|-----------|----------|
| **1:1 DM** | 2 participants (1 human + bot) | Existing logic, unchanged |
| **Group DM** | 3+ participants | New routing described below |

Mode is detected via `GET /channels/{channel_id}` which returns a `recipients`
array. For group DMs (type 3), `recipients.length >= 2` (bot is implicit).
Adding someone to a DM creates a **new channel ID**, so the mode never changes
for a given channel — check once, cache forever.

A **"Force group DM mode"** checkbox in the bot page configuration overrides
detection and treats all channels as group DMs. This is useful for testing
the triage flow in a 1:1 DM setting, and also for users who prefer AI-triaged
message handling even in 1:1 conversations.

## Concepts

### Channel buffer

A per-channel rolling buffer of the last 50 messages, kept in memory. Every
incoming message (from humans and bots) is appended regardless of whether the
bot acts on it. When the bot creates a task, the buffer is injected as
`context.history` so the LLM has full conversational context.

Buffer entries: `{ author, authorId, isBot, content, timestamp, messageId }`

On page refresh the buffer is lost, but **lazy backfill** restores it: on the
first message received in a channel after connect, if the buffer is empty,
fetch the last 50 messages via `GET /channels/{channel_id}/messages?limit=50`
and populate the buffer before running the triager.

### Triager

A lightweight LLM call that receives the channel buffer, the latest message,
and a list of active tasks for the channel. Uses **function calling** (tool
use) to return structured actions. The triager is intentionally simple — no
access to SOUL.md, MEMORY.md, or workspace context. Heavy lifting is left to
the planner which has full workspace context.

Available tools:

```json
[
  {
    "name": "skip",
    "description": "This message doesn't need action from this bot",
    "parameters": {
      "properties": {
        "reason": { "type": "string" }
      },
      "required": ["reason"]
    }
  },
  {
    "name": "add_task",
    "description": "Create a new task",
    "parameters": {
      "properties": {
        "reason": { "type": "string" },
        "prompt": {
          "type": "string",
          "description": "Self-contained task prompt (executor has no chat access)"
        },
        "label": {
          "type": "string",
          "description": "Short label (2-5 words) shown when the task reports results"
        }
      },
      "required": ["reason", "prompt", "label"]
    }
  },
  {
    "name": "remove_task",
    "description": "Cancel an existing task",
    "parameters": {
      "properties": {
        "reason": { "type": "string" },
        "taskId": { "type": "string" }
      },
      "required": ["reason", "taskId"]
    }
  },
  {
    "name": "reply",
    "description": "Send a short text response without creating a task",
    "parameters": {
      "properties": {
        "reason": { "type": "string" },
        "message": { "type": "string" }
      },
      "required": ["reason", "message"]
    }
  }
]
```

The model can emit multiple tool calls in one response (e.g. reply with status
and add a new task, or remove a task and add a replacement). The handler
iterates `response.tool_calls` and executes each in order.

System prompt includes active tasks (id + label + prompt summary) so the
triager can reference task IDs for removal and avoid creating duplicates. The
channel buffer is formatted as a simple chat log with timestamps and usernames
in the user message.

There is no "update_task" action. To modify a task, the triager removes the old
one and adds a new one with a merged prompt. This avoids state management
complexity and the triager has full buffer context to construct a good
replacement prompt.

### Task labels

Each task created by the triager has a short `label` (2-5 words). When the task
delivers results to the channel, the delivery handler prefixes the message:

```
**[craigslist search]** Found 3 listings under $10k:
1. 2019 Civic LX — $8,500...
```

Labels are also shown in the triager's active task list so it can reference
tasks meaningfully in replies and avoid duplicates.

### Triager prompt guidelines

The triager system prompt includes rules for smart behavior:

- **Duplicate avoidance** — don't create a task if an active task already
  covers the same work; use `reply` to say it's in progress
- **Multi-bot awareness** — skip if another bot already handled the request,
  or if the message targets another bot
- **Reply guidelines** — keep replies short, only when directly addressed,
  use for status checks and acknowledgments
- **Task creation** — write self-contained prompts with all details from the
  conversation; handle vague requests with reasonable assumptions

### Front-mention parsing

When a message arrives in group mode, leading mentions are parsed:

1. Strip all leading `<@...>` mentions from the message
2. Save them as "front mentions"
3. The remaining text is the "body"

Mentions in the middle and end of the body are always preserved as-is. Multiple
front mentions mean the command is intended for multiple bots — each bot
handles the command if its own ID is among the front mentions.

### Message threading in group mode

All bot messages in group mode are **flat** (no `message_reference`), **except**
command responses which reply-link to the command message. This keeps the
channel readable and avoids threading confusion with multiple bots/humans.

The delivery handler in app.js checks `task.channelMode` to decide:
- `channelMode === 'group'` → send flat, no `replyToId`, no `__lastReplyToId` tracking
- `channelMode` is absent or `'dm'` → existing reply-chain behavior

### Bot-to-bot communication

Bots mention each other using `<@botUserId>` in message text. The planner
(which has access to SOUL.md, MEMORY.md, and the channel buffer via
`context.history`) can compose messages that delegate work to other bots. The
triager does not route work to other bots — it only manages this bot's tasks.

Other bots' user IDs are discoverable from:
- The channel buffer (every message has `authorId` and `isBot`)
- The `GET /channels/{id}` response (all participants with IDs)
- SOUL.md / workspace config (user-configured known bots)

### Bot-to-bot loop prevention

The triager LLM naturally avoids redundant responses since it sees the full
buffer and can tell if the conversation has been adequately addressed. No
hard rate limiter — it was removed because any fixed threshold either hurts
legitimate tasks (too strict) or doesn't prevent loops (too loose). The
triager's awareness of the full conversation is a better mechanism.

## Message handling flow

```
1. Self message → skip

2. Detect channel mode (cached after first check via Discord API)

3. 1:1 DM mode (existing logic, unchanged)
   - Not allowed user → skip
   - !command → run command
   - Reply to bot → continue task
   - Otherwise → create task

4. Group DM mode
   - If message has message_reference (is a reply) → ignore
   - Parse front mentions and body
   - Then:

   a) Body starts with "!" (command)
      - No front mentions → this bot handles it
      - Front mentions include this bot's ID → this bot handles it
      - Front mentions do NOT include this bot's ID → ignore
      - Command response is reply-linked to command message

   b) Body does not start with "!" (non-command)
      - Lazy backfill buffer from Discord API if empty (first message after refresh)
      - Append message to channel buffer (always)
      - Call triager with buffer + active tasks
      - Execute returned tool calls:
        - skip → do nothing
        - add_task → createAndEnqueue with prompt + label, channelMode: 'group'
        - remove_task → cancelTask by ID
        - reply → sendDiscordMessage (flat, no reply link)
```

## Task record changes

Add fields to task records:

```js
{
  channelMode: 'dm' | 'group',  // set at creation time
  label: 'craigslist search',   // short label for group mode output (triager-provided)
  // ... existing fields
}
```

- `channelMode` — used by the delivery handler in app.js to decide whether
  to reply-link or send flat
- `label` — prefixed to task output in group mode so channel participants
  know which task is reporting

Both are stored in IndexedDB and synced to GitHub with existing task sync.
No IndexedDB schema version bump needed — they are optional fields.

## Changes required

| File | Change |
|------|--------|
| `message-handler.js` | Remove `if (msg.author?.bot) return` gate |
| `message-handler.js` | Remove `if (msg.guild_id) return` gate |
| `message-handler.js` | Add channel mode cache + detection via Discord API (respects `forceGroupMode` setting) |
| `message-handler.js` | Add channel buffer with lazy backfill on first message |
| `message-handler.js` | Add front-mention parser |
| `message-handler.js` | Route group messages: command path vs triage path |
| `message-handler.js` | Ignore reply-linked messages in group mode |
| `message-handler.js` | Pass buffer as `context.history` on task creation |
| `message-handler.js` | Set `channelMode` and `label` on new tasks |
| `app.js` | Update delivery handler: send flat in group mode, prefix with `**[label]**` |
| `app.js` | Add `forceGroupMode` checkbox wiring |
| `bot/index.html` | Add "Force group DM mode" checkbox in configuration card |
| `discord.js` | Add `fetchChannel(channelId, token)` for participant detection |
| `discord.js` | Add `fetchChannelMessages(channelId, token, limit)` for buffer backfill |
| `task-manager.js` | Accept `channelMode` and `label` in `createAndEnqueue` |
| New: `triage.js` | Triager LLM call with function calling tools (skip, add_task, remove_task, reply) |
| New: `extension.js` | Extract `extensionCall` from planner.js (shared by triage + planner) |
| `planner.js` | Import `extensionCall` from `extension.js` instead of local definition |
| `gateway.js` | Store `botUsername`, pass to message handler |

## Open questions

- Should triager calls be debounced if multiple messages arrive quickly?
- How should the bot handle being removed from a group DM?
