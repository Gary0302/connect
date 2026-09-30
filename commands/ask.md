---
description: Ask Codex a question in a persistent thread
argument-hint: [question]
---

Ask OpenAI Codex: $ARGUMENTS

Use the `codex_ask` MCP tool. Pick the `intent` deliberately from the question's weight —
`quick_answer` for a fact, `second_opinion` for a judgement call, `code_review` for a diff,
`deep_reasoning` only for genuinely hard design questions. Never leave a trivial question on the
default, which is expensive.

Report Codex's answer back as Codex's view, not as fact. Say where you agree or disagree and why.
Include the thread id from the result so the conversation can be continued.
