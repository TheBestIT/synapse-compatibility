#!/usr/bin/env node
// Model benchmark.
// Each model of the pool gets the same tasks. A local program grades each answer.
// Usage: node bench/bench.mjs [key,key,...]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as client from '../src/client.mjs';
import { MODELS } from '../src/roster.mjs';

const OUT = path.join(client.HOME, 'bench', 'results');
fs.mkdirSync(OUT, { recursive: true });

// ---- Reference answers ------------------------------------------------------

function latticePaths() {
  const blocked = new Set(['3,4', '6,6', '8,9']);
  const g = Array.from({ length: 11 }, () => new Array(11).fill(0n));
  for (let x = 0; x <= 10; x++)
    for (let y = 0; y <= 10; y++) {
      if (blocked.has(`${x},${y}`)) continue;
      g[x][y] = x === 0 && y === 0 ? 1n : (x ? g[x - 1][y] : 0n) + (y ? g[x][y - 1] : 0n);
    }
  return Number(g[10][10]);
}

const RECIPES = {
  ingot: { out: 30, in: { ore: 30 } },
  plate: { out: 20, in: { ingot: 30 } },
  rod: { out: 15, in: { ingot: 15 } },
  screw: { out: 40, in: { rod: 10 } },
  reinforced_plate: { out: 5, in: { plate: 30, screw: 60 } },
  rotor: { out: 4, in: { rod: 20, screw: 100 } },
  frame: { out: 2, in: { reinforced_plate: 3, rod: 12 } },
  core: { out: 1, in: { rotor: 4, frame: 2 } },
};

function factory(target, rate) {
  const need = {};
  const add = (item, r) => {
    need[item] = (need[item] ?? 0) + r;
    const rec = RECIPES[item];
    if (rec) for (const [i, q] of Object.entries(rec.in)) add(i, (r / rec.out) * q);
  };
  add(target, rate);
  const machines = Object.fromEntries(Object.keys(RECIPES).map((k) => [k, need[k] / RECIPES[k].out]));
  return { machines, ore: need.ore };
}

const FACTORY = factory('core', 7.5);

const NOTES_IT = `riunione lun 12/10 con Giulia e Marco x il modpack
- Marco deve sistemare la linea del platino entro venerdì 16 ott, budget max 250 euro per il server nuovo (forse)
- io: scrivere guida quest capitolo 3, scadenza fine mese!! (31/10)
- Giulia -> texture nuove x i macchinari, consegna il 20 ottobre. Le paghiamo 120€
- rimandato: migrazione a NeoForge, se ne riparla a novembre, nessuno assegnato
- Marco anche: backup settimanale, parte da subito, niente scadenza
nb: l'anno è il 2026. "io" = Luca`;

const NOTES_EXPECTED = [
  { owner: 'Marco', deadline: '2026-10-16', amount_eur: 250, key: 'platino' },
  { owner: 'Luca', deadline: '2026-10-31', amount_eur: null, key: 'quest' },
  { owner: 'Giulia', deadline: '2026-10-20', amount_eur: 120, key: 'texture' },
  { owner: null, deadline: null, amount_eur: null, key: 'neoforge' },
  { owner: 'Marco', deadline: null, amount_eur: null, key: 'backup' },
];

const EVAL_TESTS = [
  ['1 + 2 * 3', {}, 7],
  ['(1 + 2) * 3', {}, 9],
  ['2 ^ 3 ^ 2', {}, 512],
  ['-2 ^ 2', {}, -4],
  ['2 * -3', {}, -6],
  ['10 / 4', {}, 2.5],
  ['x * (y + 1.5)', { x: 4, y: 0.5 }, 8],
  ['max(1, min(8, 5), 3)', {}, 5],
  ['sqrt(abs(-16)) + 1', {}, 5],
  ['  7  ', {}, 7],
  ['-(-(3))', {}, 3],
  ['a_b - 1', { a_b: 1 }, 0],
  ['2 +', {}, Error],
  ['(1 + 2', {}, Error],
  ['1 2', {}, Error],
  ['q + 1', {}, Error],
  ['2 * * 3', {}, Error],
];

// ---- Tasks ------------------------------------------------------------------

const jsonOf = (text) => {
  let best = null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const raw of fenced.reverse()) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  // The answer can have other braces, for example in LaTeX. Try each start position from the end.
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1;
  for (let i = end - 1; i >= 0; i--) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    try {
      const v = JSON.parse(text.slice(i, end));
      if (typeof v === 'object') best = v;
    } catch {}
  }
  return best;
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 0.002 * Math.max(1, Math.abs(b));

const TASKS = [
  {
    id: 'reason',
    prompt: `Solve both problems. Show short reasoning, then end with one JSON object {"paths": <integer>, "flips": <number>}.
1. A path goes from (0,0) to (10,10) on the integer grid. Each step is +1 in x or +1 in y. The path must not visit the points (3,4), (6,6) and (8,9). How many paths are there?
2. A fair coin is flipped until the pattern HTHH appears for the first time as consecutive flips. What is the expected number of flips?`,
    grade: (t) => {
      const j = jsonOf(t) ?? {};
      return (j.paths === latticePaths() ? 0.5 : 0) + (near(j.flips, 18) ? 0.5 : 0);
    },
  },
  {
    id: 'factory',
    prompt: `A factory game has these recipes. Each line is one machine at 100 % speed, with rates in items per minute.
${Object.entries(RECIPES).map(([k, r]) => `- ${k}: ${Object.entries(r.in).map(([i, q]) => `${q} ${i}`).join(' + ')} -> ${r.out} ${k}`).join('\n')}
Machines can run at a fractional count (for example 2.5 machines). "ore" is the only raw resource.
Target: 7.5 core per minute. Give the exact number of machines for each recipe and the ore per minute.
End with one JSON object: {"machines": {"ingot": n, "plate": n, "rod": n, "screw": n, "reinforced_plate": n, "rotor": n, "frame": n, "core": n}, "ore": n}. Use decimals with 3 places.`,
    grade: (t) => {
      const j = jsonOf(t) ?? {};
      const keys = Object.keys(FACTORY.machines);
      const hits = keys.filter((k) => near(j.machines?.[k], FACTORY.machines[k])).length + (near(j.ore, FACTORY.ore) ? 1 : 0);
      return hits / (keys.length + 1);
    },
  },
  {
    id: 'code',
    prompt: `Write a JavaScript function evaluate(expr, vars) with no dependencies. Answer with one fenced javascript code block that defines the function at top level. Do not use eval or the Function constructor.
Grammar: decimal numbers; binary + - * / and ^; unary minus; parentheses; variables with the characters a-z and _ (their values come from the vars object); the functions min(...), max(...) with one or more arguments, sqrt(x) and abs(x); spaces between tokens.
Precedence from low to high: + and -, then * and /, then unary minus, then ^. The ^ operator is right-associative, thus "2 ^ 3 ^ 2" is 512 and "-2 ^ 2" is -4. A unary minus is permitted after a binary operator, thus "2 * -3" is -6.
The function must throw an Error for each invalid input: a syntax error, text that remains after the expression, or a variable that is not in vars.`,
    grade: (t) => {
      const code = [...t.matchAll(/```(?:javascript|js)?\s*([\s\S]*?)```/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
      if (!code) return 0;
      let pass = 0;
      for (const [expr, vars, want] of EVAL_TESTS) {
        try {
          const ctx = vm.createContext({ Math, Number, String, Error, isNaN, isFinite, parseFloat });
          const got = vm.runInContext(`${code}\n;evaluate(${JSON.stringify(expr)}, ${JSON.stringify(vars)})`, ctx, { timeout: 2000 });
          if (want !== Error && near(got, want)) pass++;
        } catch {
          if (want === Error) pass++;
        }
      }
      return pass / EVAL_TESTS.length;
    },
  },
  {
    id: 'notes_it',
    prompt: `Parse these Italian notes. Answer with one JSON array only. Each item is one action: {"task": "<short Italian description>", "owner": "<first name or null>", "deadline": "<YYYY-MM-DD or null>", "amount_eur": <number or null>}. Keep the order of the notes. Resolve "io" and the relative dates from the notes.

${NOTES_IT}`,
    grade: (t) => {
      const j = jsonOf(t);
      if (!Array.isArray(j)) return 0;
      let hits = 0;
      for (const want of NOTES_EXPECTED) {
        const got = j.find((x) => String(x.task ?? '').toLowerCase().includes(want.key)) ?? {};
        for (const f of ['owner', 'deadline', 'amount_eur']) if ((got[f] ?? null) === want[f]) hits++;
      }
      return Math.max(0, hits / (NOTES_EXPECTED.length * 3) - (j.length > NOTES_EXPECTED.length ? 0.1 : 0));
    },
  },
  {
    id: 'stamina',
    prompt: `Write the complete technical design document for a fully automatic ore processing plant in a GregTech-style Minecraft modpack: ore intake, sorting, crushing, washing, centrifuging, thermal steps, byproduct routing, fluid and power distribution, buffering, overflow protection, monitoring and maintenance. Include numbered sections, tables with example throughput numbers, a failure mode table, and one Mermaid flowchart. The document must have 3500 words minimum. Write all of it in this one answer.`,
    grade: (t) => Math.min(1, t.split(/\s+/).length / 3500) * (/```mermaid/.test(t) ? 1 : 0.8),
  },
];

// ---- Run --------------------------------------------------------------------

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keys = args[0] ? args[0].split(',') : Object.keys(MODELS);
const only = args[1] ? args[1].split(',') : TASKS.map((t) => t.id);
const metaFile = (key, id) => path.join(OUT, `${key}--${id}.json`);

// "--regrade" grades the stored answers again and asks no model.
if (process.argv.includes('--regrade')) {
  const rows = Object.keys(MODELS).map((key) => {
    const row = { key, model: MODELS[key].model, scores: {}, seconds: {}, chars: {} };
    for (const task of TASKS) {
      const file = path.join(OUT, `${key}--${task.id}.md`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      row.scores[task.id] = Number(task.grade(text).toFixed(2));
      row.chars[task.id] = text.length;
      row.seconds[task.id] = fs.existsSync(metaFile(key, task.id)) ? JSON.parse(fs.readFileSync(metaFile(key, task.id), 'utf8')).seconds : 0;
    }
    return row;
  });
  print(rows);
  process.exit(0);
}

const rows = await Promise.all(
  keys.map(async (key) => {
    const row = { key, model: MODELS[key].model, scores: {}, seconds: {}, chars: {}, errors: {} };
    for (const task of TASKS.filter((t) => only.includes(t.id))) {
      const t0 = Date.now();
      try {
        const r = await client.ask(key, task.prompt, { timeoutMs: 20 * 60 * 1000 });
        fs.writeFileSync(path.join(OUT, `${key}--${task.id}.md`), r.text);
        row.scores[task.id] = Number(task.grade(r.text).toFixed(2));
        row.chars[task.id] = r.text.length;
      } catch (e) {
        row.scores[task.id] = 0;
        row.errors[task.id] = e.message.slice(0, 100);
      }
      row.seconds[task.id] = Math.round((Date.now() - t0) / 1000);
      fs.writeFileSync(metaFile(key, task.id), JSON.stringify({ seconds: row.seconds[task.id], error: row.errors[task.id] }));
      console.error(`${key} ${task.id} ${row.scores[task.id]} ${row.seconds[task.id]}s`);
    }
    return row;
  }),
);

print(rows);

function print(rows) {
  for (const r of rows) {
    r.total = Number(Object.values(r.scores).reduce((a, b) => a + b, 0).toFixed(2));
    r.time = Object.values(r.seconds).reduce((a, b) => a + b, 0);
  }
  rows.sort((a, b) => b.total - a.total || a.time - b.time);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  console.table(
    rows.map((r) => ({
      model: r.model,
      ...r.scores,
      total: r.total,
      seconds: r.time,
      'stamina words': r.chars.stamina ? Math.round(r.chars.stamina / 6.5) : 0,
    })),
  );
}
