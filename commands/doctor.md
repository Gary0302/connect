---
description: Check the health of the Codex integration
---

Run the `codex_doctor` MCP tool and report what it says.

Pay attention to two things:

- **Version mismatch** between the CLI and the running app-server. The fix is
  `codex app-server daemon restart`, which drops every attached Codex session — including any
  Codex TUI the user has open, mid-turn. Report it and let the user choose the moment. Do not run
  it for them.
- **Remote control errored.** Enrollment requires MFA on the ChatGPT account.

If the daemon cannot start at all, the usual cause is a missing standalone Codex install:
`curl -fsSL https://chatgpt.com/codex/install.sh | sh`.
