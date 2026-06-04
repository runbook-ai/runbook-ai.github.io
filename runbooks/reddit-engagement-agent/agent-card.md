# Reddit Engagement Agent

**Slug:** reddit-engagement-agent
**Status:** dev
**Owner:** Runbook AI team
**One-liner:** Posts substantive technical comments on new posts in a curated set of subreddits, monitors for mod actions/replies, and pages on anomalies.

## Persona overlay (additive to SOUL.md)
Engineer answering a colleague — short, concrete, ends with a question when uncertain. Never invents model/library/version names. Never argues. Never claims to be human (answers "automated account" if asked). See full text in `persona.md` (runbook-owned; re-run runbook to reset).

## Topology
```
discover (every 4h)
  ──emit──▶ post.discovered
            ──▶ picker-and-poster (subscription, mode=batch)
                  ──emit──▶ comment.posted          (durable audit in comments-posted.csv)
                  ──emit──▶ post.skipped            (audit)
                  ──emit──▶ comment.verify.failed   (when uncertain)
                  ──emit──▶ anomaly.flagged         (on browser/captcha/ban)

comment-health (every 4h, walks comments-posted.csv last-7-days)
  ──emit──▶ comment.checked   (visibility + points)
  ──emit──▶ reply.received    (when a reply appears)
  ──emit──▶ comment.removed   (mod removal)
  ──emit──▶ anomaly.flagged   (shadowban, page-error, unusual engagement)

inbox-monitor (every 2h, polls Gmail for noreply@redditmail.com mail)
  ──emit──▶ anomaly.flagged severity=CRITICAL kind=account-banned (real bans go via email, not Reddit's web inbox — we missed r/ML permaban without this on 2026-06-02)
  ──emit──▶ anomaly.flagged severity=CRITICAL kind=mod-message-direct
  ──emit──▶ anomaly.flagged severity=WARN     kind=comment-removed-by-mod

any task ──emit──▶ anomaly.flagged ──▶ escalator (subscription)
                                          ──cancel-upstream + page user on CRITICAL
                                          ──batch into anomaly-queue.json on WARN
                                          ──log only on INFO
                                          ──emit human.attention.requested on CRITICAL
```

## Configuration files (runbook-installed; user-editable but ephemeral)
- `persona.md` — voice, hard rules, what-to-skip, daily floor
- `posting-limits.json` — per-sub/per-account caps + min-spacing (runbook params set defaults)
- `subreddit-allowlist.json` — hardcoded safety net
- `discover-config.json` — subreddits, interest keywords
- `prompts/discover.md`, `prompts/picker.md`, `prompts/escalator.md`, `prompts/comment-health.md` — subordinate task instructions (read at every fire; hot-patchable)

## KPIs
| Metric | Definition | Source | Target |
|---|---|---|---|
| Posts discovered/day | events on post.discovered | events/post.discovered.jsonl | 20-80 |
| Comments posted/day | rows in comments-posted.csv | file store | 3-6 |
| Engagement rate | replies / comments_posted last 7d | events/reply.received.jsonl vs CSV | ≥15% |
| Mod removal rate | comment.removed / comment.posted | events | ≤5% |
| Avg karma per comment | (sum points) / count, from comment-health checks | events/comment.checked.jsonl | ≥1 |
| Verify-uncertain rate | verify-uncertain anomalies / submit attempts | events | ≤10% |

## Cost budget (Gemini 3 Flash @ $0.50/M)
- Planner LLM: ≤500K tokens/day (~$0.25)
- Worker LLM (browse cycles): ≤20M tokens/day (~$10)
- **Daily target: ≤$10**. Alarm if >$15 for 2 consecutive days.

## Escalation policy
- CRITICAL → escalator cancels source subordinate + writes attention.md + emits human.attention.requested:
  - `login-required`, `captcha-blocked`, `account-suspended`
  - `rate-limit-platform`
  - `verify-uncertain` / `browser-error` / `debugger-not-attached` (per ops doc — CDP attach failures are fatal)
- WARN → batched into anomaly-queue.json for the daily/weekly review:
  - `comment-removed-by-mod`, `comment-vanished` (shadowban)
  - `subreddit-unavailable` (browse failed)
  - `csv-write-failed`
  - `verify-uncertain` repeated outside the 4h dedup window
- INFO → log only:
  - `unusual-engagement` (≥5 replies on one comment)
  - one-off skips / persona judgments

## Known limits (the agent will NOT)
- Comment in subreddits outside `subreddit-allowlist.json`
- Exceed `posting-limits.json` caps (1 per sub per 24h default, 6 per account per 24h default)
- Auto-reply to received replies (replies go to events for human review only)
- Engage on politics, current events, medical/legal/financial topics, or arguments
- Promote Runbook AI by name
- Invent model/library/version names (the hallucination guard)
- Claim to be human (will say "automated account" if asked)
