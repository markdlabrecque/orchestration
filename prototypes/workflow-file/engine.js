// PROTOTYPE (#128): the logic under test. Pure module: no DOM, no I/O, no clock.
// The page and check.ts are throwaway shells around it; this is the liftable part.
//
// Two jobs:
//   1. resolve(global, override, registry): apply a project override to the global
//      workflow and validate the result. Any problem rejects the whole override.
//   2. start(workflow, ...) / reduce(state, action): walk the effective workflow one
//      step run at a time, taking repair edges and spending budgets.

// ---------- step kinds ------------------------------------------------------

export function defineStepKind(def) {
  if (!def || !def.name) throw new Error("a step kind needs a name");
  const outcomes = def.outcomes ?? ["pass", "failed"];
  if (outcomes[0] !== "pass") {
    throw new Error(`step kind "${def.name}": the first outcome must be "pass"; it falls through to the next step`);
  }
  return { name: def.name, outcomes, options: def.options ?? {}, run: def.run ?? null };
}

export const builtinKinds = [
  defineStepKind({ name: "agent", outcomes: ["pass", "findings", "failed"] }),
  defineStepKind({ name: "shell", outcomes: ["pass", "failed"] }),
  defineStepKind({ name: "mr", outcomes: ["pass", "failed"] }),
  defineStepKind({ name: "ci", outcomes: ["pass", "failed"] }),
  defineStepKind({ name: "merge", outcomes: ["pass", "failed"] }),
];

export function createRegistry(kinds = builtinKinds) {
  const map = new Map();
  const registry = {
    register(kind) {
      if (map.has(kind.name)) throw new Error(`step kind "${kind.name}" is already registered`);
      map.set(kind.name, kind);
      return registry;
    },
    has: (name) => map.has(name),
    get: (name) => map.get(name),
    names: () => [...map.keys()],
  };
  for (const kind of kinds) registry.register(kind);
  return registry;
}

// ---------- when expressions -----------------------------------------------
// Grammar, on purpose tiny:  <path> == <word> | <path> != <word>
//                            <path> in [a, b] | <path> not in [a, b]

const WHEN = /^\s*([A-Za-z_][\w.]*)\s+(==|!=|not in|in)\s+(.+?)\s*$/;

export function parseWhen(text) {
  const m = WHEN.exec(String(text));
  if (!m) throw new Error(`cannot read when: "${text}"`);
  const [, path, op, rhs] = m;
  const isList = rhs.startsWith("[") && rhs.endsWith("]");
  if ((op === "in" || op === "not in") && !isList) throw new Error(`when "${text}": "${op}" needs a [list]`);
  if ((op === "==" || op === "!=") && isList) throw new Error(`when "${text}": "${op}" takes one value, not a list`);
  const values = isList ? rhs.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : [rhs.trim()];
  return { path, op, values };
}

export function evalWhen(expr, context) {
  const value = expr.path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), context);
  const hit = expr.values.includes(String(value));
  return expr.op === "==" || expr.op === "in" ? hit : !hit;
}

// ---------- resolve: global + override -> effective workflow ----------------

const OPS = ["insert_before", "insert_after", "drop", "replace", "set", "move"];

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export function resolve(global, override, registry = createRegistry()) {
  try {
    return { ok: true, workflow: resolveOrThrow(global, override, registry) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resolveOrThrow(global, override, registry) {
  const fromScratch = override?.from === "scratch";
  if (override && !fromScratch && override.extends !== "global") {
    throw new Error('override: say "extends: global" (then patch it) or "from: scratch" (then list every step)');
  }
  const steps = clone(fromScratch ? override.steps ?? [] : global.steps ?? []);
  const budgets = { ...clone(global.budgets ?? {}), ...clone(override?.budgets ?? {}) };
  const settings = { ...clone(global.settings ?? {}), ...clone(override?.settings ?? {}) };

  const ids = () => steps.map((s) => s.id).join(", ");
  const find = (where, id) => {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`${where}: there is no step "${id}" (steps: ${ids()})`);
    return i;
  };
  const freshId = (where, step) => {
    if (!step || !step.id) throw new Error(`${where}: the inserted step needs an id`);
    if (steps.some((s) => s.id === step.id)) {
      throw new Error(`${where}: a step "${step.id}" already exists; pick a new id (steps: ${ids()})`);
    }
  };

  (override?.patch ?? []).forEach((op, n) => {
    const keys = Object.keys(op).filter((k) => OPS.includes(k));
    if (keys.length !== 1) throw new Error(`patch[${n}]: needs exactly one of ${OPS.join(", ")}`);
    const name = keys[0];
    const target = op[name];
    const where = `patch[${n}] ${name} "${target}"`;
    switch (name) {
      case "insert_before": { const i = find(where, target); freshId(where, op.step); steps.splice(i, 0, op.step); break; }
      case "insert_after": { const i = find(where, target); freshId(where, op.step); steps.splice(i + 1, 0, op.step); break; }
      case "drop": { steps.splice(find(where, target), 1); break; }
      case "replace": {
        const i = find(where, target);
        if (!op.step || !op.step.id) throw new Error(`${where}: the replacement step needs an id`);
        if (op.step.id !== target && steps.some((s) => s.id === op.step.id)) throw new Error(`${where}: a step "${op.step.id}" already exists`);
        steps[i] = op.step;
        break;
      }
      case "set": {
        const i = find(where, target);
        if (!op.with || typeof op.with !== "object") throw new Error(`${where}: needs "with: { fields to merge }" (null deletes a field)`);
        if ("id" in op.with) throw new Error(`${where}: "set" cannot change the id; use "replace"`);
        steps[i] = merge(steps[i], op.with);
        break;
      }
      case "move": {
        const i = find(where, target);
        const anchor = op.before ?? op.after;
        if (!anchor || (op.before && op.after)) throw new Error(`${where}: needs "before: <id>" or "after: <id>"`);
        const [moved] = steps.splice(i, 1);
        const j = find(where, anchor);
        steps.splice(op.before ? j : j + 1, 0, moved);
        break;
      }
    }
  });

  validate(steps, budgets, registry);
  const outcomes = Object.fromEntries(steps.map((s) => [s.id, registry.get(s.kind).outcomes]));
  return { version: global.version ?? 1, budgets, settings, steps, outcomes };
}

// RFC 7396 style: objects merge, null deletes, anything else replaces.
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function validate(steps, budgets, registry) {
  const seen = new Set();
  for (const s of steps) {
    if (!s || !s.id) throw new Error("every step needs an id");
    if (seen.has(s.id)) throw new Error(`step id "${s.id}" appears twice`);
    seen.add(s.id);
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) {
    const kind = registry.get(s.kind);
    if (!kind) {
      throw new Error(`step "${s.id}": kind "${s.kind}" is not registered (registered: ${registry.names().join(", ")}). A project module listed under "uses:" can register it.`);
    }
    if (s.when !== undefined) parseWhen(s.when);
    if (s.else !== undefined && s.when === undefined) throw new Error(`step "${s.id}": "else" needs a "when"`);
    if (s.else !== undefined && typeof s.else?.block !== "string") throw new Error(`step "${s.id}": "else" must be { block: <reason> }`);
    for (const [outcome, edge] of Object.entries(s.on ?? {})) {
      const at = `step "${s.id}": on.${outcome}`;
      if (outcome === "pass") throw new Error(`${at}: "pass" always falls through; map the other outcomes only`);
      if (!kind.outcomes.includes(outcome)) throw new Error(`${at}: kind "${s.kind}" has no such outcome (outcomes: ${kind.outcomes.join(", ")})`);
      if (!edge || typeof edge.repair !== "string") throw new Error(`${at}: needs "repair: <step id>"`);
      const target = byId.get(edge.repair);
      if (!target) throw new Error(`${at}: repair "${edge.repair}" names no step (steps: ${[...byId.keys()].join(", ")})`);
      if (target.trigger !== "repair") throw new Error(`${at}: repair "${edge.repair}": that step must carry "trigger: repair"`);
      if (typeof edge.budget !== "string") throw new Error(`${at}: needs "budget: <name>" so the loop ends`);
      const b = budgets[edge.budget];
      if (!b || !Number.isInteger(b.max) || b.max < 0) {
        throw new Error(`${at}: budget "${edge.budget}" is not declared with a whole-number max (budgets: ${Object.keys(budgets).join(", ") || "none"})`);
      }
    }
  }
  for (const s of steps) {
    if (s.trigger === "repair" && !steps.some((t) => Object.values(t.on ?? {}).some((e) => e && e.repair === s.id))) {
      throw new Error(`step "${s.id}" has "trigger: repair" but no step repairs through it`);
    }
  }
}

// ---------- engine: walk the effective workflow -----------------------------
//
// State is plain data. One "step run" is one dispatch of a step; its key is
// "<id>#<n>", the n-th run of that step on this ticket. In v2 proper each step
// run is one Pi Durable task owned by the ticket task.

export function start(workflow, { project = "global", lane = "standard" } = {}) {
  const budgets = Object.fromEntries(Object.entries(workflow.budgets).map(([k, v]) => [k, { used: 0, max: v.max }]));
  const state = {
    project, lane, workflow, settings: workflow.settings,
    cursor: -1, current: null, returnTo: null,
    budgets, runs: [], status: "running", reason: null,
    lastChange: `Ticket picked up on the ${lane} lane.`,
  };
  return advance(state, 0, state.lastChange);
}

export function reduce(state, action) {
  switch (action.type) {
    case "start": return start(action.workflow, action);
    case "outcome": return applyOutcome(state, action.outcome);
    case "restart": {
      if (!state.current) return { ...state, lastChange: "Process restarted. Nothing was in flight, so nothing changes." };
      return { ...state, lastChange: `Process restarted. The ticket task was waiting on ${state.current.key}; it re-attaches to that same step run. Nothing is dispatched twice.` };
    }
    default: throw new Error(`unknown action ${action.type}`);
  }
}

export function currentStep(state) {
  return state.current ? state.workflow.steps.find((s) => s.id === state.current.id) : null;
}

export function currentOutcomes(state) {
  return state.current ? state.workflow.outcomes[state.current.id] : [];
}

const context = (state) => ({ lane: state.lane, settings: state.settings });
const nextKey = (state, id) => `${id}#${state.runs.filter((r) => r.id === id && !r.skipped).length + 1}`;

function dispatch(state, id, note) {
  const key = nextKey(state, id);
  return { ...state, current: { id, key }, lastChange: `${note} Now running ${key}.`.trim() };
}

function advance(state, from, note) {
  const s = { ...state, runs: [...state.runs] };
  for (let i = from; i < s.workflow.steps.length; i++) {
    const step = s.workflow.steps[i];
    if (step.trigger === "repair") continue; // reachable only through a repair edge
    if (step.when !== undefined && !evalWhen(parseWhen(step.when), context(s))) {
      if (step.else) {
        return { ...s, cursor: i, current: null, status: "blocked", reason: step.else.block, lastChange: `${note} "${step.when}" is false, so ${step.id} stops for a human: ${step.else.block}.`.trim() };
      }
      s.runs.push({ id: step.id, key: step.id, skipped: true, note: `skipped: "${step.when}" is false` });
      continue;
    }
    return dispatch({ ...s, cursor: i }, step.id, note);
  }
  return { ...s, cursor: s.workflow.steps.length, current: null, status: "done", lastChange: `${note} No steps left. Ticket done.`.trim() };
}

function applyOutcome(state, outcome) {
  if (state.status !== "running" || !state.current) return { ...state, lastChange: `Nothing to do: the ticket is ${state.status}.` };
  const { id, key } = state.current;
  const step = state.workflow.steps.find((x) => x.id === id);
  const s = { ...state, runs: [...state.runs, { id, key, outcome }], current: null };

  if (outcome === "pass") {
    if (s.returnTo) {
      const back = s.returnTo;
      return dispatch({ ...s, returnTo: null }, back, `${key} passed its gate, so ${back} runs again.`);
    }
    return advance(s, s.cursor + 1, `${key} passed.`);
  }

  const edge = step.on?.[outcome];
  if (!edge) {
    return { ...s, returnTo: null, status: "blocked", reason: `${key} ended with "${outcome}"; the workflow maps nothing for it`, lastChange: `${key} ended with "${outcome}" and no on: mapping says what to do. Fail closed: blocked for a human.` };
  }
  const b = s.budgets[edge.budget];
  if (b.used >= b.max) {
    return { ...s, returnTo: null, status: "blocked", reason: `${edge.budget} budget spent (${b.used}/${b.max}) at ${key}`, lastChange: `${key}: "${outcome}" again, but ${edge.budget} is spent (${b.used}/${b.max}). Blocked for a human; nothing refills a budget.` };
  }
  const budgets = { ...s.budgets, [edge.budget]: { ...b, used: b.used + 1 } };
  return dispatch({ ...s, budgets, returnTo: id }, edge.repair, `${key}: "${outcome}". Repair edge to ${edge.repair}; ${edge.budget} now ${b.used + 1}/${b.max}.`);
}
