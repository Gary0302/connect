/** The HUD under Claude Code's own engine: claude plugin test . (no sign-in, no inference). */
import { test, expect, mock } from "claude-code/testing";

const CODEX = "mcp__plugin_connect_connect__codex_ask";

function world(on, env = {}) {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, env);
  const runs: string[][] = [];
  const statuses: (string | undefined)[] = [];
  on("process.run", ($, e) => {
    runs.push([...e.argv]);
    return { value: { exitCode: 0, stdout: "", stderr: "" } };
  });
  on("ui.status", ($, e) => { statuses.push(e.text); return { value: undefined }; });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  return { clock, runs, statuses };
}

test("session start refreshes the status line's quota file with the usage script, never a model", async ($, on) => {
  const { clock, runs } = world(on);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(runs.length).toBe(1);
  expect(runs[0][0]).toBe("node");
  expect(runs[0][1].endsWith("/bin/connect.mjs")).toBe(true);
  expect(runs[0].slice(2)).toEqual(["usage", "refresh"]);
  await clock.advance(5 * 60_000);
  expect(runs.length).toBe(2);
});

test("a running Codex ask is pinned with its intent and elapsed time, then cleared", async ($, on) => {
  const { clock, runs, statuses } = world(on);
  on("tool.call", { tool: CODEX }, async () => {
    await clock.sleep(65_000);
    return { result: { content: [{ type: "text", text: "answer" }] } };
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.settle();
  const call = $.tool.call({ tool: CODEX, prompt: "is this racy?", intent: "second_opinion" } as never);
  await clock.settle();
  expect(statuses.at(-1)).toBe("codex ▸ second_opinion 0:00");
  await clock.advance(2_000);
  expect(statuses.at(-1)).toBe("codex ▸ second_opinion 0:02");
  await clock.advance(63_000);
  await call;
  await clock.settle();
  expect(statuses.at(-1)).toBe(undefined);
  // Over a minute since the start's refresh, so the finished ask refreshed the quotas.
  expect(runs.length).toBe(2);
});

test("CONNECT_HUD=0 runs nothing and pins nothing", async ($, on) => {
  const { clock, runs, statuses } = world(on, { CONNECT_HUD: "0" });
  on("tool.call", { tool: CODEX }, () => ({ result: { content: [] } }));
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await $.tool.call({ tool: CODEX, prompt: "x", intent: "quick_answer" } as never);
  await clock.advance(10 * 60_000);
  expect(runs.length).toBe(0);
  expect(statuses.length).toBe(0);
});
