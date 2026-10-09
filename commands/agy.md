---
description: Ask the Antigravity CLI (agy) a question, read-only
argument-hint: [question]
---

Ask Antigravity (agy): $ARGUMENTS

Use the `agy_ask` MCP tool. Pick the `intent` from the question's weight — `quick_answer` for a
fact, `second_opinion` for a judgement call, `code_review` for a diff, `deep_reasoning` only for
genuinely hard design questions. agy is read-only; there is no `implement` for it.

Report agy's answer back as agy's view, not as fact. Say where you agree or disagree and why.
Include the conversation id from the result so the conversation can be continued.
