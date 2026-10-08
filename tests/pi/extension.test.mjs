// Tests for pi/extension.ts (the Pi side of the plugin). Run through
// tests/test_pi_extension.py, or: node --test tests/pi/extension.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = process.env.PI_PACKAGE_ROOT || path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const ext = await jiti.import(path.join(root, "pi", "extension.ts"));

function fakePi() {
  const handlers = {};
  return { handlers, on(name, fn) { (handlers[name] ??= []).push(fn); }, async emit(name, event, ctx) {
    let out;
    for (const fn of handlers[name] ?? []) out = (await fn(event, ctx)) ?? out;
    return out;
  } };
}

function recorder(reply = "") {
  const calls = [];
  const hook = async (payload) => { calls.push(payload); return payload.hook_event_name === "SessionStart" ? reply : ""; };
  return { calls, hook };
}

const ctx = (cwd, sid) => ({ cwd, sessionManager: { getSessionId: () => sid } });

test("stage agents become orchestration:<name> profiles with Pi tools, no model and no thinking", () => {
  const agents = ext.loadStageAgents();
  assert.deepEqual(agents.map((a) => a.name), ["orchestration:implementor", "orchestration:reporter",
    "orchestration:reviewer", "orchestration:test-writer", "orchestration:verifier"]);
  const by = Object.fromEntries(agents.map((a) => [a.name, a]));
  assert.deepEqual(by["orchestration:implementor"].tools, ["read", "grep", "find", "ls", "bash", "write", "edit"]);
  assert.deepEqual(by["orchestration:reviewer"].tools, ["read", "grep", "find", "ls", "bash"]);
  for (const a of agents) {
    // The dispatcher passes model and thinking per call, from `orch route`.
    assert.equal(a.model, undefined, a.name);
    assert.equal(a.thinking, undefined, a.name);
    assert.ok(a.systemPrompt.length > 100, a.name);
    assert.ok(!a.systemPrompt.startsWith("---"), a.name);
  }
});

function withXdg(config, fn) {
  const saved = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-xdg-"));
  if (config) {
    mkdirSync(path.join(dir, "orchestration"));
    writeFileSync(path.join(dir, "orchestration", "config.json"), JSON.stringify(config));
  }
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const byName = (agents) => Object.fromEntries(agents.map((a) => [a.name.replace("orchestration:", ""), a]));

test("piModels maps the routing tiers, with the old Claude names as aliases", () => {
  withXdg(null, () => {
    const m = ext.piModels();
    assert.equal(m.light, "openai-codex/gpt-6-luna");
    assert.equal(m.standard, "openai-codex/gpt-6.1-sol");
    assert.equal(m.heavy, "openai-codex/gpt-6-astra");
    assert.equal(m.frontier, "openai-codex/gpt-6-astra");
    assert.equal(m.haiku, m.light);
    assert.equal(m.sonnet, m.standard);
    assert.equal(m.opus, m.heavy);
  });
});

test("the machine config's pi_models overrides the tier map, by tier or by old name", () => {
  withXdg({ platform: "headless", pi_models: { light: "venice/small", sonnet: "venice/mid" } }, () => {
    const m = ext.piModels();
    assert.equal(m.light, "venice/small");
    assert.equal(m.standard, "venice/mid");
    assert.equal(m.heavy, "openai-codex/gpt-6-astra");
  });
  // opus sets heavy and frontier (both run on one model); a tier key wins.
  withXdg({ platform: "headless", pi_models: { opus: "venice/big", frontier: "venice/top" } }, () => {
    const m = ext.piModels();
    assert.equal(m.heavy, "venice/big");
    assert.equal(m.frontier, "venice/top");
    assert.equal(m.opus, "venice/big");
  });
});

test("the factory registers the agent provider for the subagents extension", () => {
  delete globalThis[ext.AGENT_PROVIDERS];
  ext.default(fakePi(), recorder().hook);
  const providers = globalThis[ext.AGENT_PROVIDERS];
  assert.ok(providers instanceof Map);
  const agents = providers.get("orchestration")();
  assert.equal(agents.length, 5);
  for (const a of agents) assert.equal(a.model, undefined, a.name);
});

test("a ticket session reports start, tool use, stop and end to orch", async () => {
  const saved = { ...process.env };
  process.env.ORCH_HOME = "/nonexistent-orch-home";
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env[ext.PARENT_ENV];
  try {
    const pi = fakePi();
    const r = recorder("You are the ticket orchestrator for t1. Run `orch show t1` before anything else.\n");
    ext.default(pi, r.hook);
    await pi.emit("session_start", { reason: "startup" }, ctx("/wt", "s1"));
    assert.deepEqual(r.calls[0], { hook_event_name: "SessionStart", session_id: "s1", cwd: "/wt", source: "startup" });
    assert.equal(process.env[ext.PARENT_ENV], "s1");
    const res = await pi.emit("before_agent_start", { prompt: "x" }, ctx("/wt", "s1"));
    assert.equal(res.message.customType, "orchestration");
    assert.match(res.message.content, /ticket orchestrator for t1/);
    assert.equal(await pi.emit("before_agent_start", { prompt: "y" }, ctx("/wt", "s1")), undefined, "context is sent once");
    await pi.emit("tool_result", { toolName: "bash" }, ctx("/wt", "s1"));
    await pi.emit("tool_result", { toolName: "read" }, ctx("/wt", "s1"));
    assert.equal(r.calls.filter((c) => c.hook_event_name === "PostToolUse").length, 1, "throttled");
    await pi.emit("agent_settled", {}, ctx("/wt", "s1"));
    await pi.emit("session_shutdown", { reason: "quit" }, ctx("/wt", "s1"));
    assert.deepEqual(r.calls.map((c) => c.hook_event_name), ["SessionStart", "PostToolUse", "Stop", "SessionEnd"]);
    assert.equal(r.calls[3].reason, "quit");
  } finally {
    process.env = saved;
  }
});

test("a subagent child keeps its parent session working and reports nothing else", async () => {
  const saved = { ...process.env };
  process.env.ORCH_HOME = "/nonexistent-orch-home";
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env[ext.PARENT_ENV] = "parent-1";
  try {
    const pi = fakePi();
    const r = recorder();
    ext.default(pi, r.hook);
    await pi.emit("session_start", { reason: "startup" }, ctx("/wt", "child-1"));
    await pi.emit("tool_result", { toolName: "edit" }, ctx("/wt", "child-1"));
    await pi.emit("agent_settled", {}, ctx("/wt", "child-1"));
    await pi.emit("session_shutdown", { reason: "quit" }, ctx("/wt", "child-1"));
    assert.deepEqual(r.calls, [{ hook_event_name: "PostToolUse", session_id: "parent-1", cwd: "/wt", tool_name: "edit" }]);
  } finally {
    process.env = saved;
  }
});

test("outside an orch repo nothing is reported", async () => {
  const saved = { ...process.env };
  delete process.env.ORCH_HOME;
  delete process.env.PI_SUBAGENT_CHILD;
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-pi-"));
  try {
    const pi = fakePi();
    const r = recorder();
    ext.default(pi, r.hook);
    await pi.emit("session_start", { reason: "startup" }, ctx(dir, "s1"));
    await pi.emit("tool_result", { toolName: "bash" }, ctx(dir, "s1"));
    await pi.emit("agent_settled", {}, ctx(dir, "s1"));
    assert.deepEqual(r.calls, []);
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHook runs the real orch hook and never fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-pi-"));
  try {
    const out = await ext.runHook({ hook_event_name: "SessionStart", session_id: "s", cwd: dir });
    assert.equal(out, "");
    assert.equal(await ext.runHook({ hook_event_name: "Stop" }, 5000, path.join(dir, "missing")), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
