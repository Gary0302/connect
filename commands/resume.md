---
description: Resume an earlier Codex thread and continue it
argument-hint: [threadId] [question]
---

Resume a Codex conversation: $ARGUMENTS

If a thread id was given, read it back with `codex_history` first so you know what was discussed,
then continue it with `codex_ask` passing that `threadId`.

If no thread id was given, run `codex_threads`, show the user the recent threads, and ask which one
they mean rather than guessing.
