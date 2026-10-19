/** Offline verification: node --test test/usage.mjs (no credentials or inference). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  agyQuotas, claudeQuotas, codexQuotas, collectUsage, formatUsage,
  readAgyUsage, readClaudeUsage, readCodexUsage,
} from "../src/usage.mjs";
import { handleUsagePrompt } from "../scripts/usage-hook.mjs";

const json = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const reset = "2026-10-16T01:00:00Z";

test("Codex reads account limits only, includes every quota pool and closes its client", async () => {
  const methods = [];
  let closed = false;
  const limit = { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792112400 } };
  const client = {
    async connect(opts) { assert.equal(opts.reconnect, false); },
    async request(method) {
      methods.push(method);
      if (method === "initialize") return {};
      assert.equal(method, "account/rateLimits/read");
      return { rateLimits: { limitId: "codex", ...limit }, rateLimitsByLimitId: {
        codex: limit, review: { secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } },
      } };
    },
    notify(method) { methods.push(method); },
    close() { closed = true; },
  };
  const result = await readCodexUsage({ client, run: async (bin, args, opts) => {
    assert.deepEqual(args, ["app-server", "daemon", "start"]);
    assert.ok(opts.timeout <= 6000);
    return { stdout: '{"socketPath":"/fake.sock"}' };
  } });
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].remainingPercent, 75);
  assert.equal(result.windows[1].remainingPercent, 100);
  assert.equal(result.windows[1].resetsAt, null);
  assert.ok(closed);
  await assert.rejects(readCodexUsage({ client, run: async () => { throw new Error("secret stderr"); } }), /daemon unavailable/);
  assert.ok(closed);
});

test("Claude queries its usage endpoint and preserves zero and unknown quotas", async () => {
  const result = await readClaudeUsage({ credentials: { claudeAiOauth: { accessToken: "fake-secret" } },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer fake-secret");
      assert.equal(options.redirect, "error");
      return json({ five_hour: { utilization: 0, resets_at: reset },
        seven_day: { utilization: 100, resets_at: null }, seven_day_opus: null,
        future_pool: { utilization: null }, extra_usage: { is_enabled: false } });
    } });
  assert.deepEqual(result.windows.map((w) => w.remainingPercent), [100, 0, null]);
  assert.equal(result.windows[0].resetsAt, "2026-10-16T01:00:00.000Z");
  assert.ok(!JSON.stringify(result).includes("fake-secret"));
  const fallback = claudeQuotas({ limits: [{ kind: "session", percent: 30, resets_at: reset }] });
  assert.equal(fallback.windows[0].remainingPercent, 70);
});

test("Antigravity resolves its account project before requesting model and shared quotas", async () => {
  const seen = [];
  const result = await readAgyUsage({ credentials: { token: { access_token: "fake-secret" }, auth_method: "consumer" },
    fetchImpl: async (url, options) => {
      const method = url.split(":").pop();
      seen.push(method);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer fake-secret");
      if (method === "loadCodeAssist") return json({ cloudaicompanionProject: "quota-project", paidTier: { id: "free-tier" } });
      assert.deepEqual(JSON.parse(options.body), { project: "quota-project" });
      if (method === "retrieveUserQuotaSummary") return json({ groups: [{ displayName: "Shared Claude/GPT", buckets: [
        { displayName: "Weekly", remainingFraction: 0, resetTime: reset },
      ] }] });
      assert.equal(method, "fetchAvailableModels");
      return json({ models: {
        gemini: { displayName: "Gemini", quotaInfo: { remainingFraction: 0.8, resetTime: reset } },
        alias: { displayName: "Gemini", quotaInfo: { remainingFraction: 0.8, resetTime: reset } },
        hidden: { isInternal: true, displayName: "Internal", quotaInfo: { remainingFraction: 1 } },
        unknown: { displayName: "Unknown", quotaInfo: {} },
      } });
    } });
  assert.deepEqual(seen.sort(), ["fetchAvailableModels", "loadCodeAssist", "retrieveUserQuotaSummary"]);
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[0].remainingPercent, 80);
  assert.equal(result.windows[0].windowMinutes, 10080);
  assert.equal(result.windows[0].family, "gemini");
  assert.equal(result.windows[1].remainingPercent, null);
  assert.equal(result.windows[2].remainingPercent, 0);
});

test("partial provider failures retain available quotas; API errors cannot expose credentials", async () => {
  const report = await collectUsage({ providers: [
    ["Claude", () => readClaudeUsage({ credentials: { claudeAiOauth: { accessToken: "do-not-print" } },
      fetchImpl: async () => ({ ok: false, status: 401, json() { throw new Error("body must not be read"); } }) })],
    ["Codex", () => codexQuotas({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })],
    ["Antigravity", () => { throw new Error("do-not-print"); }],
  ] });
  assert.deepEqual(report.providers.map((p) => p.status), ["unavailable", "ok", "unavailable"]);
  const output = formatUsage(report);
  assert.match(output, /claude unavailable/);
  assert.match(output, /5h:100%/);
  assert.match(report.providers[0].error, /Session expired/);
  assert.ok(!output.includes("do-not-print"));
  assert.ok(!JSON.stringify(report).includes("do-not-print"));
});

test("Antigravity can report per-model quotas when its shared summary is unsupported", async () => {
  const result = await readAgyUsage({ credentials: { token: { access_token: "fake" } },
    fetchImpl: async (url) => url.endsWith("loadCodeAssist") ? json({ cloudaicompanionProject: "p" })
      : url.endsWith("fetchAvailableModels") ? json({ models: { a: { displayName: "A", quotaInfo: { remainingFraction: 1 } } } })
      : json({}, 404) });
  assert.equal(result.windows[0].remainingPercent, 100);
  assert.match(result.notes.join(" "), /Shared quota summary unavailable/);
});

test("missing values stay unknown and malformed percentages never render NaN or negative", () => {
  const result = agyQuotas({ models: {
    a: { displayName: "A", quotaInfo: { remainingFraction: null, resetTime: "invalid" } },
    b: { displayName: "B", quotaInfo: { remainingFraction: 1.5 } },
  } });
  assert.equal(result.windows[0].usedPercent, null);
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.windows[1].remainingPercent, 100);
});

test("usage hook blocks model processing and displays its result, also when collection fails", async () => {
  let reads = 0;
  const collect = async () => { reads++; return { checkedAt: reset, providers: [] }; };
  for (const input of [
    { hook_event_name: "UserPromptSubmit", prompt: "/connect:usage" },
    { hook_event_name: "UserPromptExpansion", command_name: "connect:usage", command_args: "" },
  ]) {
    const output = await handleUsagePrompt(input, collect);
    assert.equal(output.decision, "block");
    assert.equal(output.reason, "claude unavailable\ncodex unavailable\nagy-gemini unavailable\nagy-other unavailable");
    assert.equal(output.hookSpecificOutput.hookEventName, input.hook_event_name);
    assert.equal(output.hookSpecificOutput.additionalContext, undefined);
  }
  assert.equal(reads, 2);
  const data = await handleUsagePrompt({ prompt: "/connect:usage --json" }, collect);
  assert.equal(JSON.parse(data.reason).checkedAt, reset);
  const failed = await handleUsagePrompt({ prompt: "/connect:usage" }, async () => { throw new Error("secret"); });
  assert.equal(failed.decision, "block");
  assert.ok(!failed.reason.includes("secret"));
});

test("compact rows show remaining quotas with matching countdowns, excluding unrelated windows", () => {
  const now = Date.parse("2026-10-15T18:00:00Z");
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const claude = claudeQuotas({ five_hour: { utilization: 78, resets_at: at(93) },
    seven_day: { utilization: 20, resets_at: at(6000) },
    iguana_necktie: { utilization: 0, resets_at: at(10000) }, extra_usage: { is_enabled: false } });
  const codex = codexQuotas({ rateLimitsByLimitId: {
    review: { primary: { usedPercent: 99, windowDurationMins: 300 } },
    codex: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: Date.parse(at(120)) / 1000 },
      secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Date.parse(at(9000)) / 1000 } },
  } });
  const agy = agyQuotas({ models: {
    gemini: { displayName: "Gemini", quotaInfo: { remainingFraction: 0.8, resetTime: at(6000) } },
    alias: { displayName: "Gemini High", quotaInfo: { remainingFraction: 0.9, resetTime: at(6000) } },
    claude: { displayName: "Claude", quotaInfo: { remainingFraction: 1, resetTime: at(6000) } },
  } }, { groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: 0.6, resetTime: at(7200) },
    { window: "five_hour", remainingFraction: 0.22, resetTime: at(130) },
  ] }] }, { defaultWindowMinutes: 10080 });
  const report = { providers: [["Claude", claude], ["Codex", codex], ["Antigravity", agy]]
    .map(([name, data]) => ({ name, status: "ok", ...data })) };
  assert.equal(formatUsage(report, { color: false, now }), [
    "claude 5h:22% 7d:80% [1:33|100:00]",
    "codex 5h:67% 7d:95% [2:00|150:00]",
    "agy-gemini 7d:80% [100:00]",
    "agy-other 5h:22% 7d:60% [2:10|120:00]",
  ].join("\n"));
});

test("missing 5h quotas are omitted, weekly resets stay weekly even when imminent", () => {
  const now = Date.parse(reset);
  const report = { providers: [
    { name: "Claude", status: "ok", ...claudeQuotas({ five_hour: { utilization: 100, resets_at: reset },
      seven_day: { utilization: 20, resets_at: "invalid" } }) },
    { name: "Codex", status: "ok", ...codexQuotas({ rateLimits: {
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: now / 1000 + 10 * 60 },
    } }) },
    { name: "Antigravity", status: "ok", ...agyQuotas({ models: {
      gemini: { displayName: "Gemini", quotaInfo: { remainingFraction: 0.8, resetTime: reset } },
      gpt: { displayName: "GPT", quotaInfo: { remainingFraction: 0, resetTime: reset } },
    } }, {}, { defaultWindowMinutes: 10080 }) },
  ] };
  assert.equal(formatUsage(report, { color: false, now }), [
    "claude 5h:0% 7d:80% [0:00|—]",
    "codex 7d:80% [0:10]",
    "agy-gemini 7d:80% [0:00]",
    "agy-other 7d:0% [0:00]",
  ].join("\n"));
});

test("5h values use green, yellow and red; weekly values stay plain and JSON has no colors", () => {
  const report = { providers: ["Claude", "Codex", "Antigravity"].map((name) => ({ name, status: "ok", windows: [
    { windowMinutes: 300, remainingPercent: name === "Claude" ? 51 : name === "Codex" ? 22 : 20, family: "gemini" },
    { windowMinutes: 10080, remainingPercent: 80, family: "gemini" },
  ] })) };
  const output = formatUsage(report, { color: true });
  assert.match(output, /\x1b\[32m5h:51%\x1b\[39m 7d:80%/);
  assert.match(output, /\x1b\[33m5h:22%\x1b\[39m 7d:80%/);
  assert.match(output, /\x1b\[31m5h:20%\x1b\[39m 7d:80%/);
  assert.ok(!formatUsage(report, { color: false }).includes("\x1b"));
  assert.ok(!JSON.stringify(report).includes("\\u001b"));
});

test("hook ignores other prompts, rejects arguments as data and never executes them", async () => {
  const noRead = () => { throw new Error("must not collect"); };
  for (const prompt of ["hello", "/connect:ask usage", "explain /connect:usage", "/connect:usage-other", "/usage"]) {
    assert.equal(await handleUsagePrompt({ prompt }, noRead), null);
  }
  for (const prompt of ["/connect:usage --other", "/connect:usage $(touch /tmp/never)", "/connect:usage\nask a model"]) {
    const result = await handleUsagePrompt({ prompt }, noRead);
    assert.equal(result.decision, "block");
    assert.equal(result.reason, "Usage: /connect:usage [--json]");
  }
  const output = execFileSync(process.execPath, [new URL("../scripts/usage-hook.mjs", import.meta.url).pathname], {
    input: '{"hook_event_name":"UserPromptSubmit","prompt":"unrelated"}', encoding: "utf8",
  });
  assert.equal(output, "");
});

test("plugin registers usage and both interception paths; expansion errors fail closed", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url)));
  const { hooks } = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  assert.ok(manifest.commands.includes("./commands/usage.md"));
  assert.ok(hooks.UserPromptSubmit.length);
  assert.equal(hooks.UserPromptExpansion[0].matcher, "^connect:usage$");
  assert.equal(hooks.UserPromptExpansion[0].hooks[0].onFailure, "block");
});
