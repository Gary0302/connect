---
description: Show Claude, Codex and Antigravity account quotas without a model call
argument-hint: "[--json]"
disable-model-invocation: true
---

This command is handled by Connect's usage hook before model processing.
If you see this text, the hook did not run. Tell the user to enable the Connect
plugin's hooks and restart Claude Code, or run the script directly in Claude
Code's Bash mode:

`!node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs" usage`

Do not call a model or an MCP tool to check usage.
