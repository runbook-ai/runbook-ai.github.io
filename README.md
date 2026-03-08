# Runbook AI

**The AI that acts on your behalf in the browser.**

Runbook AI is an autonomous, local-first AI agent that lives in your browser. Tell it what you need — it figures out the steps, navigates pages, fills forms, and gets things done on its own. No scripting, no hand-holding.


https://github.com/user-attachments/assets/d20b3f4e-c1ba-4ca5-9e60-73d497710c81


## What's Included

- **Chrome Extension** — The core autonomous agent. Describe what you need in plain English and it handles the rest — navigating, clicking, filling forms, and extracting data. Zero data leaves your machine except to your LLM. [Install](https://chromewebstore.google.com/detail/runbook-ai/kjbhngehjkiiecaflccjenmoccielojj)

- **Runbook Share & Run** — Discover community-contributed runbooks for common tasks. Each runbook is a reusable, shareable prompt + config pair. Run them with one click directly from your browser. [Browse runbooks](https://runbookai.net/runbooks/)

- **Bot** — Delegate tasks to Runbook AI from anywhere — just send a message to your bot and it acts on your behalf. Currently supports Discord, with more platforms coming. [Set up the bot](https://runbookai.net/bot/)

- **MCP Server** — Invoke Runbook AI from Claude Code, Gemini CLI, and other MCP-compatible clients. See [runbook-ai-mcp](https://github.com/runbook-ai/runbook-ai-mcp).

- **Browser Agent LLM** *(coming soon)* — A custom LLM fine-tuned specifically for autonomous browser tasks — faster, cheaper, and more reliable than general-purpose models.

## Why Runbook AI?

Other browser-based MCP tools (like `chrome-devtools-mcp`) usually blow up your LLM context window by sending the entire DOM after every browser action.

Runbook AI generates a **highly optimized, simplified version of the HTML** — it strips the junk but keeps the essential text and interaction elements. Condensed, fast, and token-efficient. The simplified HTML also goes beyond the viewport, so scrolling is far more efficient.

### Key Features

- **The Ultimate Catch-all** — If a site doesn't have a dedicated MCP server, Runbook AI fills the gap perfectly — any page, any task.
- **Privacy First** — Runs entirely in your browser. No remote calls except to your chosen LLM provider. No `eval()` or shady scripts — enforced by the Chrome extension sandbox.
- **Zero Install, Just a Browser** — No local servers, no software to install, no complicated setup. Install the Chrome extension and you're ready to go.

## Contributing

Contributions are welcome! Feel free to send out a PR.

## Links

- [Install Chrome Extension](https://chromewebstore.google.com/detail/runbook-ai/kjbhngehjkiiecaflccjenmoccielojj)
- [Discord](https://discord.gg/SDtXkAKK2B)
- [GitHub](https://github.com/runbook-ai)
