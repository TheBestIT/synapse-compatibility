// Coordination of many agents.
// Each answer goes to a file in the run directory. The caller gets the path and a short preview.
import fs from 'node:fs';
import path from 'node:path';
import * as client from './client.mjs';
import * as telemetry from './telemetry.mjs';
import { config, engine as engineConf, engineOf, effortOf } from './config.mjs';
import { SPECIALISTS, SUPERS, SUBCATEGORY, MODELS, MODEL_SUBCATEGORY, DESIGN_GUIDELINES } from './roster.mjs';

export const RUNS = path.join(client.HOME, 'runs');
// A prompt above this size goes through the summarizer first.
const MAX_PROMPT_CHARS = config.defaults.maxPromptChars;
const CHUNK_CHARS = 60000;
const DEFAULT_PREVIEW = config.defaults.previewChars;

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defOf = (agent) => SPECIALISTS[agent] ?? SUPERS[agent] ?? MODELS[agent] ?? {};

// ---- Engine load and quota ---------------------------------------------------

// Each engine has its own quota and its own load limit. The "engines" section of the configuration gives them:
// the parallel call limit, the maximum number of calls in one run, and the time without calls after a quota error.
const ENGINE_FILE = path.join(client.STATE, 'engines.json');
const QUOTA = /quota|limit|rate|resets|overloaded/i;
// An agent that is not on the service also sends its role to the next agent of the route.
const RETRY = /quota|limit|rate|resets|overloaded|unavailable|non ha risposto|timeout|non trovato|not found|not in the registry/i;

const gates = {};
// Run a call when its engine has a free slot.
async function slot(engine, fn) {
  const g = (gates[engine] ??= { free: Math.max(1, engineConf(engine).parallel ?? 2), queue: [] });
  if (g.free > 0) g.free -= 1;
  else await new Promise((r) => g.queue.push(r));
  try {
    return await fn();
  } finally {
    const next = g.queue.shift();
    if (next) next();
    else g.free += 1;
  }
}

function blocks() {
  try {
    return JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Stop the calls to an engine for some time. The file is common to the MCP server and the CLI.
function block(engine, reason) {
  const until = Date.now() + (engineConf(engine).blockMinutes ?? 10) * 60000;
  fs.mkdirSync(client.STATE, { recursive: true });
  fs.writeFileSync(ENGINE_FILE, JSON.stringify({ ...blocks(), [engine]: { until, reason: reason.slice(0, 200) } }, null, 2));
}

// Call budget of each run: { engine: maximum calls }. The configuration gives the default.
const budgets = new Map();
const used = new Map();
const setBudget = (dir, budget) => budgets.set(dir, budget ?? {});
const limitOf = (dir, engine) => budgets.get(dir)?.[engine] ?? engineConf(engine).callsPerRun ?? null;
const count = (dir, engine) => used.set(dir, { ...used.get(dir), [engine]: (used.get(dir)?.[engine] ?? 0) + 1 });

// Give the reason when an engine must not get a call now.
function unavailable(dir, engine) {
  if (engineConf(engine).enabled === false) return `the ${engine} engine is disabled in the configuration`;
  const b = blocks()[engine];
  if (b && b.until > Date.now()) return `${engine} has no quota until ${new Date(b.until).toISOString().slice(11, 16)} UTC`;
  const max = limitOf(dir, engine);
  if (max !== null && (used.get(dir)?.[engine] ?? 0) >= max) return `the ${engine} call budget of the run (${max}) is used`;
  return null;
}

// State of the engines for the caller.
export function engines({ clear } = {}) {
  if (clear) fs.rmSync(ENGINE_FILE, { force: true });
  const now = Date.now();
  const roles = {};
  for (const [key, d] of [...Object.entries(SPECIALISTS), ...Object.entries(SUPERS)]) (roles[engineOf(d.model)] ??= []).push(key);
  return Object.entries(config.engines).map(([name, e]) => {
    const b = blocks()[name];
    const blocked = b && b.until > now;
    return { engine: name, enabled: e.enabled !== false, parallel: e.parallel, callsPerRun: e.callsPerRun ?? 'no limit', web: !!e.web, blockedUntil: blocked ? new Date(b.until).toISOString() : null, reason: blocked ? b.reason : undefined, roles: (roles[name] ?? []).join(', ') };
  });
}

// List the agents that can take a role when its first agent fails.
// The "fallbacks" section of the configuration gives the order.
function fallbacksOf(agent) {
  const def = defOf(agent);
  const chain = def.fallback ? [def.fallback].flat() : (config.fallbacks[def.web ? 'web' : 'default'] ?? []);
  return chain.filter((k) => k !== agent && MODELS[k] && MODELS[k].model !== def.model && client.registry().agents[k]);
}

export function newRun(label = 'run') {
  const dir = path.join(RUNS, `${stamp()}-${slugify(label)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setStatus(dir, patch) {
  const file = path.join(dir, 'status.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const next = { ...current, ...patch, updated: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

const runDir = (run) => (path.isAbsolute(run) ? run : path.join(RUNS, run));

export function readStatus(run) {
  const dir = runDir(run);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const live = telemetry.events(dir).map((e) => `${(e.from ?? ['master']).join('+')} → ${e.agent}: ${e.purpose ?? e.name} (${e.seconds}s${e.ok ? '' : ', failed'})`);
  return { dir, ...status, calls: live };
}

// Build the usage report of a run again and return it.
export function usage(run) {
  const dir = runDir(run);
  return { dir, ...telemetry.report(dir) };
}

// Run the jobs with a limit on parallel calls.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Put the content of local files into the prompt. The orchestrator model does not read them.
export function withFiles(prompt, files = []) {
  if (!files.length) return prompt;
  const parts = files.map((f) => `### FILE: ${f}\n\`\`\`\n${fs.readFileSync(path.resolve(f), 'utf8')}\n\`\`\``);
  return `${prompt}\n\n## Attached files\n\n${parts.join('\n\n')}`;
}

function preview(text, n = DEFAULT_PREVIEW) {
  return text.length <= n ? text : `${text.slice(0, n)}\n… [${text.length - n} more characters in the file]`;
}

function chunk(text, size = CHUNK_CHARS) {
  const chunks = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const cut = text.lastIndexOf('\n', end);
      if (cut > i + size / 2) end = cut;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

// Ask one agent, write the answer to a file and record the call.
// `from` lists the calls that gave input to this call. The default is the master.
// When the agent fails or its engine has no quota, the next agent of the route takes the role.
export async function askToFile(dir, name, agent, prompt, opts = {}) {
  const def = defOf(agent);
  const file = path.join(dir, `${name}.md`);
  const role = def.system_prompt ? `For this task, act in this role:\n${def.system_prompt}\n\n# Task\n` : '';
  const route = [agent, ...(opts.noFallback ? [] : fallbacksOf(agent))];
  const notes = [];
  let seconds = 0;
  for (const key of route) {
    const model = defOf(key).model;
    const engine = engineOf(model);
    const why = unavailable(dir, engine);
    if (why) {
      notes.push(`${key} skipped: ${why}`);
      continue;
    }
    count(dir, engine);
    let t0 = Date.now();
    const base = { name, agent: key, model, purpose: opts.purpose ?? name, from: opts.from ?? ['master'], file, promptChars: prompt.length, t0 };
    try {
      const full = key === agent ? prompt : role + prompt;
      const sendPrompt = full.length > MAX_PROMPT_CHARS ? await fit(dir, name, full, opts.goal ?? '') : full;
      const r = await slot(engine, () => {
        // The time in the queue is not part of the call time.
        t0 = Date.now();
        return client.ask(key, sendPrompt, { thread: opts.thread, web: opts.web ?? def.web ?? false, timeoutMs: opts.timeoutMs ?? config.defaults.timeoutMinutes * 60000 });
      });
      const sources = r.sources?.length ? `\n\n## Sources\n${r.sources.map((s) => `- ${s.title ?? ''} ${s.url ?? ''}`.trim()).join('\n')}` : '';
      fs.writeFileSync(file, r.text + sources);
      seconds = Math.round((Date.now() - t0) / 1000);
      telemetry.record(dir, { ...base, t0, promptChars: sendPrompt.length, answerChars: r.text.length, t1: Date.now(), seconds, ok: true, tools: r.tools, steps: r.steps, parts: r.parts, conversationId: r.conversationId });
      const out = { name, agent, ok: true, file, chars: r.text.length, seconds, text: r.text };
      return key === agent ? out : { ...out, via: key, note: `${notes.join('. ')}. ${key} did the task.` };
    } catch (e) {
      seconds = Math.round((Date.now() - t0) / 1000);
      telemetry.record(dir, { ...base, t0, name: route.length > 1 ? `${name}!` : name, answerChars: 0, t1: Date.now(), seconds, ok: false, error: e.message.slice(0, 200) });
      notes.push(`${key} failed: ${e.message.slice(0, 120)}`);
      // An engine with an empty quota gets no more calls for some time.
      if (QUOTA.test(e.message)) block(engine, e.message);
      // Only a quota, load, timeout or missing-agent failure sends the task to a different model.
      if (!RETRY.test(e.message)) break;
    }
  }
  const error = notes.join('. ') || 'No agent is available.';
  fs.writeFileSync(file, `ERROR: ${error}`);
  return { name, agent, ok: false, file, error, seconds, text: '' };
}

// Compress a large text with the summarizer in a map step and a reduce step.
export async function compress(dir, name, text, question = '', { concurrency = config.defaults.concurrency, target = 20000 } = {}) {
  if (text.length <= target) return text;
  const focus = question ? `Keep only the content that helps with this question or goal:\n${question}\n\n` : '';
  const parts = chunk(text);
  const notes = await pool(parts, concurrency, async (part, i) => {
    const r = await askToFile(
      dir,
      `${name}-part${String(i + 1).padStart(3, '0')}`,
      'summarizer',
      `${focus}Summarise part ${i + 1} of ${parts.length}. Keep names, paths, identifiers, numbers and decisions. Maximum ${Math.ceil(target / parts.length / 4) + 300} words.\n\n---\n${part}`,
      { purpose: `compress ${i + 1}/${parts.length}` },
    );
    return `## Part ${i + 1}\n${r.text}`;
  });
  const joined = notes.join('\n\n');
  return joined.length > target * 2 ? compress(dir, `${name}-r`, joined, question, { concurrency, target }) : joined;
}

async function fit(dir, name, prompt, question) {
  const head = prompt.slice(0, 4000);
  return `${head}\n\n## Compressed context\n\n${await compress(dir, `${name}-ctx`, prompt.slice(4000), question, { target: 60000 })}`;
}

const brief = ({ text, ...r }, n) => ({ ...r, preview: r.ok ? preview(text, n) : undefined });

// Measure the real token use of an operation and write the usage report.
async function tracked(dir, fn) {
  const before = await telemetry.snapshot();
  try {
    return { ...(await fn()), ...(await closeRun(dir, before)) };
  } catch (e) {
    await closeRun(dir, before);
    setStatus(dir, { state: 'failed', error: e.message });
    throw e;
  }
}

async function closeRun(dir, before) {
  // The service counters need a short time to include the last call.
  await sleep(3000);
  const after = await telemetry.snapshot();
  const d = telemetry.delta(before, after);
  if (d) fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(d, null, 2));
  const rep = telemetry.report(dir);
  // Number of calls that the layer made on each engine in this run.
  const engineCalls = used.get(dir) ?? {};
  return rep ? { usage: rep.summary, usageTable: rep.table, report: rep.reportHtml, engineCalls } : { engineCalls };
}

// Select other models for the same task. They must be different from the model of the specialist.
function alternates(agent, n) {
  const own = defOf(agent).model;
  // An ensemble uses only the engines that have quota now.
  const state = blocks();
  const open = (k) => !((state[engineOf(MODELS[k].model)]?.until ?? 0) > Date.now());
  return config.ensemble.filter((k) => MODELS[k] && engineConf(engineOf(MODELS[k].model)).enabled !== false && MODELS[k].model !== own && client.registry().agents[k] && open(k)).slice(0, n);
}

// One task with depth: the specialist and other models answer, then the specialist merges the answers.
async function deepAsk(dir, name, agent, prompt, { ensemble = 0, ...opts } = {}) {
  const alts = alternates(agent, ensemble);
  if (!alts.length) return askToFile(dir, name, agent, prompt, opts);
  const role = `For this task, act in this role:\n${defOf(agent).system_prompt ?? ''}\n\n# Task\n`;
  const drafts = await Promise.all([
    askToFile(dir, `${name}.draft-${agent}`, agent, prompt, { ...opts, purpose: `${opts.purpose ?? name} · draft` }),
    ...alts.map((k) => askToFile(dir, `${name}.draft-${k}`, k, role + prompt, { ...opts, purpose: `${opts.purpose ?? name} · draft` })),
  ]);
  const good = drafts.filter((d) => d.ok);
  if (good.length < 2) return good[0] ? { ...good[0], name } : askToFile(dir, name, agent, prompt, opts);
  const merged = await askToFile(
    dir,
    name,
    agent,
    `${good.length} experts on different models did the same task. Their answers follow. Check each answer. Keep what is correct and best, correct what is wrong, and write one final answer that is more complete and more correct than each of them. Give the full final answer, not a comparison.\n\n# Task\n${prompt}\n\n# Answers\n\n${good.map((d, i) => `## Answer ${i + 1} (${d.agent})\n\n${d.text}`).join('\n\n---\n\n')}`,
    { ...opts, from: good.map((d) => d.name), purpose: `${opts.purpose ?? name} · merge` },
  );
  return merged.ok ? merged : { ...good[0], name };
}

// ---- Public operations ------------------------------------------------------

export async function ask({ agent, prompt, files, thread, web, effort, ensemble, budget, label, previewChars, dir }) {
  ensemble ??= effortOf(effort).askEnsemble;
  dir ??= newRun(label ?? agent);
  setBudget(dir, budget);
  setStatus(dir, { kind: 'ask', state: 'running', agent });
  return tracked(dir, async () => {
    const r = await deepAsk(dir, agent, agent, withFiles(prompt, files), { thread, web, ensemble, purpose: 'ask' });
    setStatus(dir, { state: r.ok ? 'done' : 'failed', result: r.file, error: r.error });
    return { dir, ...brief(r, previewChars) };
  });
}

// Send many independent tasks at the same time.
export async function fanout({ tasks, concurrency = config.defaults.concurrency, effort, ensemble, budget, label, previewChars = 500, dir }) {
  ensemble ??= effortOf(effort).askEnsemble;
  dir ??= newRun(label ?? 'fanout');
  setBudget(dir, budget);
  setStatus(dir, { kind: 'fanout', state: 'running', total: tasks.length, done: 0 });
  return tracked(dir, async () => {
    let done = 0;
    const results = await pool(tasks, concurrency, async (t, i) => {
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(t.name ?? t.agent)}`;
      const r = await deepAsk(dir, name, t.agent, withFiles(t.prompt, t.files), { thread: t.thread, web: t.web, ensemble, purpose: t.name ?? t.agent });
      setStatus(dir, { done: ++done });
      return r;
    });
    setStatus(dir, { state: results.every((r) => r.ok) ? 'done' : 'partial' });
    return { dir, results: results.map((r) => brief(r, previewChars)) };
  });
}

// Ask the same question to many agents, then one agent merges the answers.
export async function council({ prompt, files, agents = config.defaults.councilAgents, judge = config.defaults.councilJudge, budget, label, previewChars, dir }) {
  dir ??= newRun(label ?? 'council');
  setBudget(dir, budget);
  setStatus(dir, { kind: 'council', state: 'running' });
  return tracked(dir, async () => {
    const full = withFiles(prompt, files);
    const answers = await pool(agents, agents.length, (a) => askToFile(dir, `answer-${a}`, a, full, { purpose: `answer ${a}` }));
    const good = answers.filter((a) => a.ok);
    const final = await askToFile(
      dir,
      'final',
      judge,
      `Several specialists answered the same task. Compare the answers. Keep what is correct, reject what is wrong, and write one final answer that is better than each of them.\n\n# Task\n${prompt}\n\n# Answers\n\n${good.map((a) => `## Answer from ${a.agent}\n\n${a.text}`).join('\n\n---\n\n')}`,
      { goal: prompt, from: good.map((a) => a.name), purpose: 'judge and merge' },
    );
    setStatus(dir, { state: final.ok ? 'done' : 'failed', result: final.file });
    return { dir, answers: answers.map((a) => brief(a, 0)), final: brief(final, previewChars) };
  });
}

// Summarise or query files that are too large for one context.
export async function digest({ files, question = '', budget, label, previewChars, dir }) {
  dir ??= newRun(label ?? 'digest');
  setBudget(dir, budget);
  setStatus(dir, { kind: 'digest', state: 'running' });
  return tracked(dir, async () => {
    const text = files.map((f) => `### FILE: ${f}\n${fs.readFileSync(path.resolve(f), 'utf8')}`).join('\n\n');
    const compact = await compress(dir, 'map', text, question);
    fs.writeFileSync(path.join(dir, 'compressed.md'), compact);
    const parts = telemetry.events(dir).map((e) => e.name);
    const final = await askToFile(
      dir,
      'final',
      question ? 'reasoner' : 'summarizer',
      question
        ? `Answer the question from the context. Cite the file names.\n\n# Question\n${question}\n\n# Context\n${compact}`
        : `Write one structured summary of this material. Keep names, paths, numbers and decisions.\n\n${compact}`,
      { from: parts.length ? parts : ['master'], purpose: question ? 'answer' : 'summary' },
    );
    setStatus(dir, { state: final.ok ? 'done' : 'failed', result: final.file });
    return { dir, sourceChars: text.length, final: brief(final, previewChars) };
  });
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

const PLAN_SCHEMA = `{
  "summary": "one line",
  "tasks": [
    { "id": "t1", "agent": "<specialist key>", "title": "short title", "prompt": "full self-contained instruction", "depends_on": [] }
  ],
  "synthesis_agent": "<specialist key>",
  "synthesis_instruction": "how to build the final deliverable from the task outputs"
}`;

// Plan, execute in dependency order, review, then build one final result.
// `ensemble` is the number of other models that also do each task. `rounds` is the maximum number of critic passes.
// `effort` gives the default of `maxTasks`, `ensemble` and `rounds`.
export async function pipeline({ goal, files, effort, maxTasks, concurrency = config.defaults.concurrency, ensemble, rounds, review = true, budget, label, previewChars, dir, resume }) {
  const depth = effortOf(effort);
  maxTasks ??= depth.maxTasks;
  ensemble ??= depth.ensemble;
  rounds ??= depth.rounds;
  // `resume` is the directory of an earlier run. Its plan and its completed tasks stay.
  if (resume) {
    dir = runDir(resume);
    goal ??= JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')).goal;
  }
  dir ??= newRun(label ?? goal);
  setBudget(dir, budget);
  const log = (state, extra = {}) => setStatus(dir, { kind: 'pipeline', state, goal: goal.slice(0, 300), ...extra });
  log('planning');
  return tracked(dir, async () => {
    const context = withFiles('', files).trim();
    const roster = Object.entries(SPECIALISTS).map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
    const planPrompt = `Make a machine plan for the goal. Answer with JSON only, in this schema:\n${PLAN_SCHEMA}\n\nRules:\n- Use ${maxTasks} tasks maximum. Use only these specialist keys:\n${roster}\n- Each task prompt must be complete without the other prompts. The layer adds the goal and the outputs of the tasks in "depends_on".\n- Ask each task for depth: full detail, numbers, tables, diagrams (Mermaid) and complete files where they apply. Length is not a limit.\n- Make tasks parallel where possible. Use "depends_on" only for a real dependency.\n- Use the researcher or the docs specialist first when the goal depends on current versions or documentation.\n- Do not make a review task. The layer adds the review.\n\n# Goal\n${goal}${context ? `\n\n# Context\n${context}` : ''}`;
    let plan;
    const planFile = path.join(dir, 'plan.json');
    if (fs.existsSync(planFile)) {
      // A run that resumes keeps its plan.
      plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    } else {
      let planRun = await askToFile(dir, '00-plan', 'planner', planPrompt, { goal, purpose: 'plan' });
      try {
        plan = parseJson(planRun.text);
      } catch {
        planRun = await askToFile(dir, '00-plan', 'planner', `${planPrompt}\n\nYour last answer was not valid JSON. Answer with one JSON object only.`, { goal, purpose: 'plan (retry)' });
        plan = parseJson(planRun.text);
      }
      plan.tasks = plan.tasks.filter((t) => SPECIALISTS[t.agent]).slice(0, maxTasks);
      plan.goal = goal;
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    }

    const outputs = new Map();
    const fileName = (t) => `${String(plan.tasks.indexOf(t) + 1).padStart(2, '0')}-${t.id}-${t.agent}`;
    const pending = new Map(plan.tasks.map((t) => [t.id, t]));
    let wave = 0;
    while (pending.size) {
      let ready = [...pending.values()].filter((t) => (t.depends_on ?? []).every((d) => outputs.has(d) || !plan.tasks.some((x) => x.id === d)));
      // A cycle in the plan must not stop the run.
      if (!ready.length) ready = [...pending.values()];
      wave += 1;
      log('executing', { wave, done: outputs.size, total: plan.tasks.length });
      const results = await pool(ready, concurrency, async (t) => {
        const deps = (t.depends_on ?? []).filter((d) => outputs.get(d)?.ok);
        const inputs = deps.map((d) => `## Output of task ${d} (${outputs.get(d).agent})\n\n${outputs.get(d).text}`);
        const prompt = `# Overall goal\n${goal}\n\n# Your task: ${t.title}\n${t.prompt}${inputs.length ? `\n\n# Inputs from earlier tasks\n\n${inputs.join('\n\n---\n\n')}` : ''}${context ? `\n\n# Context\n${context}` : ''}`;
        // A run that resumes uses the answers that it has.
        const stored = path.join(dir, `${fileName(t)}.md`);
        if (fs.existsSync(stored)) {
          const text = fs.readFileSync(stored, 'utf8');
          if (text.length > 200 && !text.startsWith('ERROR:')) return [t.id, { name: fileName(t), agent: t.agent, ok: true, file: stored, chars: text.length, seconds: 0, text, resumed: true }];
        }
        const r = await deepAsk(dir, fileName(t), t.agent, prompt, { goal, ensemble, purpose: t.title, from: deps.length ? deps.map((d) => outputs.get(d).name) : ['00-plan'] });
        return [t.id, { ...r, name: fileName(t) }];
      });
      for (const [id, r] of results) {
        outputs.set(id, r);
        pending.delete(id);
      }
    }

    const done = plan.tasks.filter((t) => outputs.get(t.id).ok);
    const material = done.map((t) => `## Task ${t.id}: ${t.title} (${t.agent})\n\n${outputs.get(t.id).text}`).join('\n\n---\n\n');
    const taskNames = done.map((t) => fileName(t));
    const synthAgent = SPECIALISTS[plan.synthesis_agent] ? plan.synthesis_agent : 'planner';

    log('synthesis');
    // A run that resumes keeps its first synthesis.
    const storedV1 = path.join(dir, 'final-v1.md');
    const keepV1 = fs.existsSync(storedV1) && fs.statSync(storedV1).size > 500 && !fs.readFileSync(storedV1, 'utf8').startsWith('ERROR:');
    let final = keepV1
      ? { name: 'final-v1', agent: synthAgent, ok: true, file: storedV1, text: fs.readFileSync(storedV1, 'utf8'), seconds: 0 }
      : await askToFile(
      dir,
      'final-v1',
      synthAgent,
      `Build the final deliverable for the goal from the work of the specialists. Give the complete result, not a description of it. Keep all the detail, the numbers, the tables, the diagrams and the files. Do not shorten.\n\n# Goal\n${goal}\n\n# Instruction\n${plan.synthesis_instruction ?? ''}\n\n# Work of the specialists\n\n${material}`,
      { goal, from: taskNames, purpose: 'synthesis v1' },
    );
    let verdict;
    for (let round = 1; review && final.ok && round <= rounds; round++) {
      log('reviewing', { round });
      const critique = await askToFile(dir, `review-${round}`, 'critic', `# Goal\n${goal}\n\n# Deliverable to review\n\n${final.text}`, { goal, from: [final.name], purpose: `review ${round}` });
      verdict = critique.text.match(/VERDICT:\s*\w+/i)?.[0];
      if (!critique.ok || /pass/i.test(verdict ?? '')) break;
      log('revising', { round });
      const next = await askToFile(
        dir,
        `final-v${round + 1}`,
        synthAgent,
        `Correct the deliverable. Apply each correction of the critic that is right. Give the complete corrected deliverable again, with all its content. Do not shorten.\n\n# Goal\n${goal}\n\n# Corrections from the critic\n\n${critique.text}\n\n# Current deliverable\n\n${final.text}\n\n# Work of the specialists (reference)\n\n${material}`,
        { goal, from: [final.name, critique.name], purpose: `revision ${round}` },
      );
      if (!next.ok) break;
      final = next;
    }
    fs.copyFileSync(final.file, path.join(dir, 'final.md'));
    log(final.ok ? 'done' : 'failed', { result: path.join(dir, 'final.md') });
    return {
      dir,
      summary: plan.summary,
      tasks: plan.tasks.map((t) => brief({ ...outputs.get(t.id), title: t.title }, 0)),
      verdict,
      final: { ...brief(final, previewChars), file: path.join(dir, 'final.md') },
    };
  });
}

// Start an operation and return at once. The status file shows the progress.
export function background(op, args) {
  const dir = newRun(args.label ?? args.goal ?? args.agent ?? op.name);
  setStatus(dir, { state: 'queued' });
  op({ ...args, dir }).catch((e) => setStatus(dir, { state: 'failed', error: e.message }));
  return { dir, state: 'started', hint: 'Call synapse_status with this run directory to read the progress and the calls. Call synapse_usage for the token report.' };
}

// ---- Provisioning and training ---------------------------------------------

async function subcategoryId(name = SUBCATEGORY, description = 'Private specialists for the Claude Code layer') {
  const data = await client.api.get('subcategories');
  const list = data.subcategories ?? data;
  const found = list.find((s) => s.name === name && s.parent === 'personal') ?? list.find((s) => s.name === name && s.can_manage);
  if (found) return found.id;
  return (await client.api.post('subcategories', { name, description, parent: 'personal', visibility: 'private' })).id;
}

// Create the agents of the roster that are not in the registry. All agents are private.
export async function provision({ sync = false } = {}) {
  const sub = await subcategoryId();
  const report = [];
  const remote = Object.fromEntries((await client.listAgents()).map((a) => [a.slug, a]));
  // An agent that a person deleted on the service leaves the registry. The steps below create it again when the roster has it.
  for (const [key, a] of Object.entries(client.registry().agents)) {
    if (remote[a.slug]) continue;
    client.forgetAgent(key);
    report.push({ key, action: 'not on the service: removed from the registry' });
  }
  // Send the model only when it is different. One agent that fails does not stop the others.
  const update = async (key, { model, ...patch }) => {
    // The service settings of the configuration go to each agent.
    try {
      await client.updateAgent(key, { ...config.agentSettings, ...(remote[client.registry().agents[key].slug]?.model === model ? patch : { ...patch, model }) });
      return 'updated';
    } catch (e) {
      return `failed: ${e.message.slice(0, 120)}`;
    }
  };
  for (const [key, def] of Object.entries(SPECIALISTS)) {
    if (client.registry().agents[key]) {
      report.push({ key, action: sync ? await update(key, { name: def.name, description: def.description, system_prompt: def.system_prompt, model: def.model, icon: def.icon }) : 'exists' });
    } else {
      const a = await client.createAgent(key, { ...def, subcategory: sub, settings: config.agentSettings });
      report.push({ key, action: 'created', slug: a.slug });
    }
  }
  const modelSub = await subcategoryId(MODEL_SUBCATEGORY, 'One plain private agent for each model');
  for (const [key, def] of Object.entries(MODELS)) {
    if (client.registry().agents[key]) {
      report.push({ key, action: sync ? await update(key, { name: def.name, description: def.description, system_prompt: def.system_prompt, model: def.model, icon: def.icon }) : 'exists' });
    } else {
      const a = await client.createAgent(key, { ...def, subcategory: modelSub, settings: config.agentSettings });
      report.push({ key, action: 'created', slug: a.slug });
    }
  }
  for (const [key, def] of Object.entries(SUPERS)) {
    const members = def.members.map((m) => client.resolveAgent(m).id);
    if (client.registry().agents[key]) {
      report.push({ key, action: sync ? await update(key, { name: def.name, description: def.description, system_prompt: def.system_prompt, model: def.model, icon: def.icon, members }) : 'exists' });
    } else {
      const a = await client.createAgent(key, { ...def, kind: 'super', members, subcategory: sub, settings: config.agentSettings });
      report.push({ key, action: 'created', slug: a.slug });
    }
  }
  // The layer does not publish an agent and does not change the publish state. The owner controls that state on the service.
  return report;
}

const note = (title, description, tags, body) => `---\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(', ')}]\n---\n\n${body.trim()}\n`;

// Give a specialist data, examples and a research topic.
// A strong model writes the playbook and the examples. The layer stores them in the memory of the specialist.
export async function train({ agent, notes = [], topic, selfStudy = true, loop = true }) {
  const def = SPECIALISTS[agent];
  const out = { agent, notes: [], loop: null };
  for (const n of notes) {
    await client.memoryPut(agent, n.path, n.content);
    out.notes.push(n.path);
  }
  if (agent === 'designer') {
    await client.memoryPut(agent, 'knowledge/owner-design-guidelines.md', note('Owner design guidelines', 'The design rules that the owner gave. Apply them to each design.', ['design', 'rules'], DESIGN_GUIDELINES));
    out.notes.push('knowledge/owner-design-guidelines.md');
  }
  if (selfStudy && def) {
    const author = agent === 'planner' ? 'architect' : 'planner';
    const [playbook, examples] = await Promise.all([
      client.ask(author, `Write the operating playbook for an AI specialist with this role. The specialist reads the playbook before each task.\n\nRole: ${def.name} — ${def.description}\nRole prompt:\n${def.system_prompt}\n\nGive: the method in numbered steps, the quality checklist, the 15 most common errors with their corrections, and the output templates for the 4 most frequent task types. Be specific and dense. Do not write an introduction.`),
      client.ask('critic', `Write 3 worked examples for an AI specialist with this role. Each example has: a realistic task, an ideal answer in full, and 3 lines that say why the answer is good.\n\nRole: ${def.name} — ${def.description}\nRole prompt:\n${def.system_prompt}\n\nMake the tasks different from each other and difficult. Do not write an introduction.`),
    ]);
    await client.memoryPut(agent, 'knowledge/playbook.md', note(`${def.name} playbook`, 'Method, checklist, common errors and output templates', ['playbook', 'method'], playbook.text));
    await client.memoryPut(agent, 'knowledge/worked-examples.md', note(`${def.name} worked examples`, 'Ideal answers for difficult tasks', ['examples'], examples.text));
    out.notes.push('knowledge/playbook.md', 'knowledge/worked-examples.md');
  }
  if (loop && (topic ?? def?.topic)) {
    const started = await client.loopStart(agent, topic ?? def.topic);
    // The learning loop uses the model of the configuration, when the configuration gives one.
    if (config.loopModel) await client.loopPatch(agent, { model: config.loopModel });
    out.loop = { status: started.loop?.status, topic: started.loop?.topic };
  }
  return out;
}

export function roster() {
  const reg = client.registry().agents;
  return [...Object.entries(SPECIALISTS), ...Object.entries(SUPERS), ...Object.entries(MODELS)].map(([key, d]) => ({
    key,
    name: d.name,
    model: d.model,
    kind: d.members ? 'super' : 'agent',
    members: d.members,
    description: d.description,
    slug: reg[key]?.slug ?? null,
  }));
}
