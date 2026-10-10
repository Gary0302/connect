---
description: Ask the Antigravity CLI (agy) a question, or have it edit files
argument-hint: [question]
---

Ask Antigravity (agy): $ARGUMENTS

Use the `agy_ask` MCP tool. Pick the `intent` from the question's weight — `quick_answer` for a
fact, `second_opinion` for a judgement call, `code_review` for a diff, `deep_reasoning` only for
genuinely hard design questions. Use `implement` only when the request is for agy to change files:
it can then edit inside the working directory, but still cannot run commands, so read its edits
before calling the work done.

Report agy's answer back as agy's view, not as fact. Say where you agree or disagree and why.
Include the conversation id from the result so the conversation can be continued.
