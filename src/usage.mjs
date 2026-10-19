/** Account quotas only: no prompts, threads, turns, or model inference. */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexClient, resolveCodexBin } from "./codex-client.mjs";

const exec = promisify(execFile);
const TIMEOUT = 6_000;
const AGY_API = "https://daily-cloudcode-pa.googleapis.com/v1internal:";

// Never return subprocess stderr, response bodies, or JSON parse errors: auth
// helpers can include credentials in those. Only normalized quota data escapes.
async function readJson(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw new Error("Cannot read credentials file"); }
  return parseCredentials(raw);
}

function parseCredentials(raw) {
  const value = raw.trim();
  try {
    return JSON.parse(value.startsWith("go-keyring-base64:")
      ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8") : value);
  } catch { throw new Error("Cannot parse stored credentials; open the provider CLI to sign in again"); }
}

async function keychain(service, account) {
  let result;
  try {
    if (process.platform === "darwin") {
      result = await exec("/usr/bin/security", ["find-generic-password", "-s", service,
        ...(account ? ["-a", account] : []), "-w"], { timeout: TIMEOUT });
    } else if (process.platform === "linux" && account) {
      result = await exec("secret-tool", ["lookup", "service", service, "username", account], { timeout: TIMEOUT });
    } else return null;
  } catch { return null; }
  return result.stdout.trim() ? parseCredentials(result.stdout) : null;
}

async function quotaJson(url, { token, body, headers = {}, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: "error",
    });
  } catch { throw new Error("Quota request failed or timed out"); }
  if (response.status === 401) throw new Error("Session expired; open the provider CLI to refresh your sign-in");
  if (!response.ok) throw new Error(`Quota endpoint returned HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error("Quota endpoint returned invalid JSON"); }
}

const percent = (v) => typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
const isoTime = (v) => {
  if (v == null) return null;
  const d = new Date(typeof v === "number" ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const quota = (label, used, reset, details = {}) => {
  const usedPercent = percent(used);
  return { label, usedPercent, remainingPercent: usedPercent == null ? null : 100 - usedPercent, resetsAt: isoTime(reset), ...details };
};
const remaining = (label, fraction, reset, details) => quota(label,
  typeof fraction === "number" && Number.isFinite(fraction) ? 100 - fraction * 100 : null, reset, details);

function windowLabel(minutes, fallback) {
  if (!minutes) return fallback;
  if (minutes === 10080) return "weekly";
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function codexQuotas(data) {
  const limits = { ...(data.rateLimitsByLimitId ?? {}) };
  if (data.rateLimits) {
    const id = data.rateLimits.limitId ?? "codex";
    limits[id] ??= data.rateLimits;
  }
  const windows = [], notes = [];
  for (const [id, limit] of Object.entries(limits)) {
    const name = limit.limitName ?? id;
    for (const [key, fallback] of [["primary", "primary"], ["secondary", "secondary"]]) {
      const w = limit[key];
      if (w) windows.push(quota(`${name} · ${windowLabel(w.windowDurationMins, fallback)}`, w.usedPercent, w.resetsAt,
        { windowMinutes: w.windowDurationMins ?? null, limitId: id }));
    }
    if (limit.credits?.unlimited) notes.push(`${name}: unlimited credits`);
    else if (limit.credits?.balance != null) notes.push(`${name}: credit balance ${limit.credits.balance}`);
    if (limit.spendControlReached) notes.push(`${name}: spend control reached`);
  }
  if (data.ordinaryUsageAllowed === false) notes.push("Ordinary usage is currently blocked");
  if (!windows.length) notes.push("No subscription quota windows reported (API-key accounts may not have these limits)");
  return { windows, notes };
}

export async function readCodexUsage({ client = new CodexClient(), run = exec, bin = resolveCodexBin() } = {}) {
  try {
    let status;
    try {
      const result = await run(bin, ["app-server", "daemon", "start"], { timeout: TIMEOUT });
      status = JSON.parse(result.stdout);
    } catch { throw new Error("Codex daemon unavailable; run /connect:doctor or sign in to Codex"); }
    if (!status.socketPath) throw new Error("Codex daemon did not report its socket");
    await client.connect({ socketPath: status.socketPath, reconnect: false });
    // A bounded initialize, rather than the interactive client's long timeout.
    await client.request("initialize", {
      clientInfo: { name: "connect-usage", version: "0.7.1" },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: TIMEOUT });
    client.notify("initialized");
    let data;
    try { data = await client.request("account/rateLimits/read", {}, { timeoutMs: TIMEOUT }); }
    catch { throw new Error("Cannot read Codex quotas; check your sign-in and /connect:doctor"); }
    return codexQuotas(data);
  } finally { client.close(); }
}

export function claudeQuotas(data) {
  const windows = [], notes = [];
  const labels = { five_hour: "5h", seven_day: "weekly", seven_day_opus: "weekly · Opus", seven_day_sonnet: "weekly · Sonnet" };
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("utilization" in value) || key === "extra_usage") continue;
    windows.push(quota(labels[key] ?? key.replaceAll("_", " "), value.utilization, value.resets_at,
      { windowMinutes: key === "five_hour" ? 300 : key === "seven_day" ? 10080 : null }));
  }
  if (!windows.length) {
    for (const limit of data.limits ?? []) windows.push(quota(limit.kind ?? limit.group ?? "limit", limit.percent, limit.resets_at,
      { windowMinutes: limit.kind === "session" ? 300 : limit.kind === "weekly_all" ? 10080 : null }));
  }
  if (data.extra_usage) notes.push(`Extra usage: ${data.extra_usage.is_enabled ? "enabled" : "disabled"}`);
  if (!windows.length) notes.push("No subscription quota windows reported");
  return { windows, notes };
}

export async function readClaudeUsage({ credentials, fetchImpl = fetch } = {}) {
  if (!credentials) {
    // Claude uses Keychain on macOS and this file on Linux. Honor custom homes.
    credentials = process.platform === "darwin" ? await keychain("Claude Code-credentials") : null;
    credentials ??= await readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"));
  }
  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("No Claude subscription sign-in found; open Claude Code and sign in (API keys have no subscription quota)");
  return claudeQuotas(await quotaJson("https://api.anthropic.com/api/oauth/usage", {
    token, headers: { "anthropic-beta": "oauth-2025-04-20" }, fetchImpl,
  }));
}

const agyFamily = (name) => /gemini/i.test(name) ? "gemini" : /claude|gpt|\b3p\b/i.test(name) ? "other" : null;
function agyWindow(bucket) {
  const name = `${bucket.window ?? ""} ${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`;
  if (/weekly|seven[ _-]?day|7d/i.test(name)) return 10080;
  if (/five[ _-]?hour|5[ _-]?(?:h|hour)/i.test(name)) return 300;
  return null;
}

export function agyQuotas(models, summary = {}, { defaultWindowMinutes = null } = {}) {
  const windows = [], notes = [], seen = new Set();
  for (const [id, model] of Object.entries(models.models ?? {})) {
    if (!model.displayName || model.isInternal || !model.quotaInfo) continue;
    const w = remaining(model.displayName, model.quotaInfo.remainingFraction, model.quotaInfo.resetTime,
      { family: agyFamily(`${id} ${model.displayName}`), windowMinutes: agyWindow(model.quotaInfo) ?? defaultWindowMinutes, source: "model" });
    const key = JSON.stringify(w);
    if (!seen.has(key)) { seen.add(key); windows.push(w); }
  }
  windows.sort((a, b) => a.label.localeCompare(b.label));
  // Summary buckets describe shared limits; never sum per-model percentages.
  for (const group of summary.groups ?? []) {
    for (const bucket of group.buckets ?? []) windows.push(remaining(
      `${group.displayName ?? "Shared quota"} · ${bucket.displayName ?? bucket.window ?? bucket.bucketId ?? "limit"}`,
      bucket.remainingFraction, bucket.resetTime,
      { family: agyFamily(`${group.displayName ?? ""} ${group.description ?? ""} ${bucket.bucketId ?? ""}`),
        windowMinutes: agyWindow(bucket), source: "summary" }));
  }
  for (const bucket of summary.buckets ?? []) windows.push(remaining(
    bucket.displayName ?? bucket.bucketId ?? "Shared quota", bucket.remainingFraction, bucket.resetTime,
    { family: agyFamily(`${bucket.displayName ?? ""} ${bucket.bucketId ?? ""}`), windowMinutes: agyWindow(bucket), source: "summary" }));
  if (!windows.length) notes.push("No model quota data reported");
  return { windows, notes };
}

export async function readAgyUsage({ credentials, fetchImpl = fetch } = {}) {
  credentials ??= process.env.CONNECT_AGY_CREDENTIALS
    ? await readJson(process.env.CONNECT_AGY_CREDENTIALS) : await keychain("gemini", "antigravity");
  const token = credentials?.token?.access_token;
  if (!token) throw new Error("No Antigravity sign-in found; open agy and sign in, or set CONNECT_AGY_CREDENTIALS to its token profile");
  if (credentials.auth_method && credentials.auth_method !== "consumer")
    throw new Error("Antigravity enterprise/API-key quotas are not supported; check /usage inside agy");
  const read = (method, body) => quotaJson(AGY_API + method, {
    token, body, fetchImpl, headers: { "User-Agent": `antigravity/1.3.2 ${process.platform}/${process.arch}` },
  });
  const account = await read("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
  const project = typeof account.cloudaicompanionProject === "string"
    ? account.cloudaicompanionProject : account.cloudaicompanionProject?.id;
  if (!project) throw new Error("Antigravity did not report a quota project; open agy to finish signing in");
  const [models, summary] = await Promise.allSettled([
    read("fetchAvailableModels", { project }), read("retrieveUserQuotaSummary", { project }),
  ]);
  if (models.status === "rejected" && summary.status === "rejected") throw models.reason;
  // Starter accounts have weekly quotas. Do not guess a period from how soon
  // a reset happens: a weekly limit can be minutes away from resetting.
  // https://antigravity.google/docs/plans#baseline-quota
  const tier = account.paidTier?.id ?? account.currentTier?.id;
  const result = agyQuotas(models.status === "fulfilled" ? models.value : {}, summary.status === "fulfilled" ? summary.value : {},
    { defaultWindowMinutes: tier === "free-tier" ? 10080 : null });
  if (models.status === "rejected") result.notes.push("Per-model quotas unavailable");
  if (summary.status === "rejected") result.notes.push("Shared quota summary unavailable; per-model quotas shown above may share a limit");
  return result;
}

export async function collectUsage({ providers = [
  ["Claude", readClaudeUsage], ["Codex", readCodexUsage], ["Antigravity", readAgyUsage],
] } = {}) {
  const results = await Promise.allSettled(providers.map(([, read]) => Promise.resolve().then(read)));
  return {
    checkedAt: new Date().toISOString(),
    providers: results.map((result, i) => result.status === "fulfilled"
      ? { name: providers[i][0], status: "ok", ...result.value }
      : { name: providers[i][0], status: "unavailable", error: safeError(result.reason), windows: [], notes: [] }),
  };
}

function safeError(e) {
  // All provider errors above are controlled messages. Transport errors from
  // the Codex connection are reduced to a fixed message too.
  return e?.message && /^(Cannot |No |Quota |Session expired|Codex daemon |Antigravity |Per-model )/.test(e.message)
    ? e.message : "Usage check failed; check the provider CLI and your network connection";
}

function countdown(reset, now) {
  const end = reset == null ? NaN : Date.parse(reset);
  if (!Number.isFinite(end)) return "—";
  const minutes = Math.max(0, Math.ceil((end - now) / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function tightest(windows) {
  // Shared summaries are authoritative. When several models have separate
  // limits, show the least remaining quota, never a sum or an average.
  const known = windows.filter((w) => w.remainingPercent != null);
  const summaries = known.filter((w) => w.source === "summary");
  return [...(summaries.length ? summaries : known.length ? known : windows)].sort((a, b) =>
    (a.remainingPercent ?? Infinity) - (b.remainingPercent ?? Infinity) ||
    (Date.parse(b.resetsAt) || 0) - (Date.parse(a.resetsAt) || 0))[0];
}

export function formatUsage(report, {
  color = !Object.hasOwn(process.env, "NO_COLOR") && process.env.FORCE_COLOR !== "0" &&
    (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)),
  now = Date.now(),
} = {}) {
  const row = (name, provider, filter = () => true) => {
    if (!provider || provider.status !== "ok") return `${name} unavailable`;
    const windows = provider.windows.filter(filter);
    const slots = [300, 10080].map((minutes) => tightest(windows.filter((w) => w.windowMinutes === minutes)));
    const parts = [], times = [];
    for (const [i, window] of slots.entries()) {
      if (!window) continue;
      const left = window.remainingPercent;
      let text = `${i === 0 ? "5h" : "7d"}:${left == null ? "—" : `${Number(left.toFixed(1))}%`}`;
      if (color && i === 0 && left != null) {
        const code = left <= 20 ? 31 : left <= 50 ? 33 : 32;
        text = `\x1b[${code}m${text}\x1b[39m`;
      }
      parts.push(text);
      times.push(countdown(window.resetsAt, now));
    }
    return parts.length ? `${name} ${parts.join(" ")} [${times.join("|")}]` : `${name} unavailable`;
  };
  const find = (name) => report.providers.find((p) => p.name === name);
  return [
    row("claude", find("Claude")),
    row("codex", find("Codex"), (w) => w.limitId === "codex" || !w.limitId),
    row("agy-gemini", find("Antigravity"), (w) => w.family === "gemini"),
    row("agy-other", find("Antigravity"), (w) => w.family === "other"),
  ].join("\n");
}
