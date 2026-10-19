---
description: Ask Codex and agy the same question at once and compare their answers
argument-hint: [question]
---

Compare Codex and Antigravity (agy) on: $ARGUMENTS

Use the `peers_compare` MCP tool. It is read-only and costs both peers' tokens, so pick the
`intent` from the question's weight: `quick_answer` for a fact, `second_opinion` for a judgement
call, `code_review` for a diff, `deep_reasoning` only for genuinely hard design questions.

Report each answer as that peer's view, not as fact. Lead with where the two disagree, then say
which side you find more convincing and why, including where you disagree with both. If either
section says INTERRUPTED, TURN FAILED or connect error, say that answer is partial or missing.
Include the thread id and conversation id from the result so either can be continued.
