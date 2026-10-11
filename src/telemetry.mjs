// Run telemetry: who sent what to whom, how long it took and how many tokens it used.
// The layer writes events.jsonl during a run, then builds report.html and report.md.
import fs from 'node:fs';
import path from 'node:path';
import * as client from './client.mjs';
import { SUPERS } from './roster.mjs';

// The service gives no token count for one message. The layer estimates it from the text size.
const estimate = (chars) => Math.round(chars / 3.6);
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function record(dir, event) {
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

export function events(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const ENGINES = ['claude', 'google', 'openai', 'litellm'];
const pick = (v = {}) => ({ calls: v.calls ?? 0, input: v.input_tokens ?? 0, output: v.output_tokens ?? 0, cache: (v.cache_read_tokens ?? 0) + (v.cache_write_tokens ?? 0) });

// Read the real token counters that the service keeps for each agent and engine.
export async function snapshot() {
  try {
    const data = await client.api.get('admin/tokens?days=1');
    const out = {};
    for (const a of data.agents ?? []) out[a.slug] = Object.fromEntries(ENGINES.map((e) => [e, pick(a[e])]));
    return out;
  } catch {
    return null;
  }
}

// Subtract two snapshots. The result has the tokens of the time between them.
export function delta(before, after) {
  if (!before || !after) return null;
  const out = {};
  for (const [slug, now] of Object.entries(after)) {
    const d = { calls: 0, input: 0, output: 0, cache: 0, engines: {} };
    for (const e of ENGINES) {
      const was = before[slug]?.[e] ?? pick();
      const x = { calls: Math.max(0, now[e].calls - was.calls), input: Math.max(0, now[e].input - was.input), output: Math.max(0, now[e].output - was.output), cache: Math.max(0, now[e].cache - was.cache) };
      if (x.calls + x.input + x.output + x.cache === 0) continue;
      d.engines[e] = x;
      for (const k of ['calls', 'input', 'output', 'cache']) d[k] += x[k];
    }
    if (d.calls + d.input + d.output + d.cache > 0) out[slug] = d;
  }
  return out;
}

// Build the summary for each agent from the events and the real token totals.
export function summarise(dir) {
  const ev = events(dir);
  const usage = JSON.parse(fs.existsSync(path.join(dir, 'usage.json')) ? fs.readFileSync(path.join(dir, 'usage.json'), 'utf8') : 'null');
  const reg = client.registry().agents;
  const agents = {};
  for (const e of ev) {
    const key = e.via ?? e.agent;
    const a = (agents[key] ??= { key, model: reg[key]?.model ?? '', calls: 0, failed: 0, estIn: 0, estOut: 0, seconds: 0, tools: 0, real: null });
    a.calls += 1;
    a.failed += e.ok ? 0 : 1;
    a.estIn += estimate(e.promptChars ?? 0);
    a.estOut += estimate(e.answerChars ?? 0);
    a.seconds += e.seconds ?? 0;
    a.tools += (e.tools ?? []).length;
  }
  let realTotal = null;
  let realCache = 0;
  if (usage) {
    realTotal = 0;
    // The counters are global. Keep only the agents of this run and the members of its Super-Agents.
    const involved = new Set(Object.keys(agents));
    for (const key of Object.keys(agents)) for (const member of SUPERS[key]?.members ?? []) involved.add(member);
    for (const [slug, d] of Object.entries(usage)) {
      const key = Object.values(reg).find((r) => r.slug === slug)?.key;
      // A report of an earlier layer version has a different format. Ignore it.
      if (!key || !involved.has(key) || d.input === undefined) continue;
      (agents[key] ??= { key, model: reg[key].model, calls: 0, failed: 0, estIn: 0, estOut: 0, seconds: 0, tools: 0 }).real = d;
      realTotal += d.input + d.output;
      realCache += d.cache;
    }
  }
  const weight = (r) => (r.real ? r.real.input + r.real.output : r.estIn + r.estOut);
  const rows = Object.values(agents).sort((a, b) => weight(b) - weight(a));
  const start = Math.min(...ev.map((e) => e.t0));
  const end = Math.max(...ev.map((e) => e.t1));
  return {
    rows,
    events: ev,
    totals: {
      calls: ev.length,
      failed: ev.filter((e) => !e.ok).length,
      estIn: rows.reduce((s, r) => s + r.estIn, 0),
      estOut: rows.reduce((s, r) => s + r.estOut, 0),
      real: realTotal,
      cache: realCache,
      wallSeconds: ev.length ? Math.round((end - start) / 1000) : 0,
      agentSeconds: rows.reduce((s, r) => s + r.seconds, 0),
    },
    start,
    end,
  };
}

function mermaid(ev) {
  const id = (n) => `n${String(n).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const lines = ['flowchart LR', '  master([Master: Claude Code])'];
  for (const e of ev) {
    lines.push(`  ${id(e.name)}["${e.purpose ?? e.name}<br/>${e.via ? `${e.agent} via ${e.via}` : e.agent} · ${fmt(estimate((e.promptChars ?? 0) + (e.answerChars ?? 0)))} tok"]`);
    for (const f of e.from ?? ['master']) lines.push(`  ${f === 'master' ? 'master' : id(f)} --> ${id(e.name)}`);
    for (const s of e.steps ?? []) lines.push(`  ${id(e.name)} -.-> ${id(`${e.name}_${s.name}`)}(["${s.name}${s.ok === false ? ' ✗' : ''}"])`);
  }
  return lines.join('\n');
}

function svgGraph(ev) {
  const nodes = [{ id: 'master', label: 'Master', sub: 'Claude Code', level: 0, ok: true }];
  const level = { master: 0 };
  for (const e of ev) {
    const from = (e.from ?? ['master']).filter((f) => level[f] !== undefined);
    level[e.name] = 1 + Math.max(0, ...from.map((f) => level[f]));
    nodes.push({ id: e.name, label: e.purpose ?? e.name, sub: `${e.via ? `${e.agent}→${e.via}` : e.agent} · ${fmt(estimate((e.promptChars ?? 0) + (e.answerChars ?? 0)))} tok · ${e.seconds}s`, level: level[e.name], ok: e.ok, from });
  }
  const cols = [];
  for (const n of nodes) (cols[n.level] ??= []).push(n);
  const W = 230;
  const H = 46;
  const GX = 70;
  const GY = 14;
  const rowsMax = Math.max(...cols.map((c) => c.length));
  const height = rowsMax * (H + GY) + GY;
  const width = cols.length * (W + GX) + 10;
  cols.forEach((c, i) => c.forEach((n, j) => Object.assign(n, { x: 5 + i * (W + GX), y: GY + j * (H + GY) + ((rowsMax - c.length) * (H + GY)) / 2 })));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = nodes
    .flatMap((n) => (n.from ?? []).map((f) => [byId[f], n]))
    .map(([a, b]) => `<path class="edge" d="M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}"/>`);
  const boxes = nodes.map(
    (n) =>
      `<g><rect class="node${n.ok ? '' : ' bad'}${n.id === 'master' ? ' master' : ''}" x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="8"/><text class="t1" x="${n.x + 10}" y="${n.y + 19}">${esc(n.label.slice(0, 32))}</text><text class="t2" x="${n.x + 10}" y="${n.y + 35}">${esc(n.sub.slice(0, 40))}</text></g>`,
  );
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Message flow">${edges.join('')}${boxes.join('')}</svg>`;
}

function svgTimeline(s) {
  const span = Math.max(1, s.end - s.start);
  const W = 900;
  const R = 20;
  const bars = s.events.map((e, i) => {
    const x = 190 + ((e.t0 - s.start) / span) * (W - 200);
    const w = Math.max(2, ((e.t1 - e.t0) / span) * (W - 200));
    return `<text class="t2" x="0" y="${i * R + 14}">${esc((e.purpose ?? e.name).slice(0, 28))}</text><rect class="bar${e.ok ? '' : ' bad'}" x="${x}" y="${i * R + 4}" width="${w}" height="12" rx="3"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${s.events.length * R + 6}" width="100%" role="img" aria-label="Timeline">${bars.join('')}</svg>`;
}

const engines = (r) => (r.real ? Object.entries(r.real.engines).map(([k, v]) => `${k} ${v.calls}`).join(', ') : '');

// Write report.md and report.html in the run directory. Return a short text summary.
export function report(dir) {
  const s = summarise(dir);
  if (!s.events.length) return null;
  const t = s.totals;
  const head = `calls ${t.calls}${t.failed ? ` (${t.failed} failed)` : ''} · tokens ${t.real !== null ? `${fmt(t.real)} real (input + output) + ${fmt(t.cache)} cache` : 'real n/a'} · messages ${fmt(t.estIn)} in / ${fmt(t.estOut)} out (estimate) · wall ${t.wallSeconds}s · agent time ${t.agentSeconds}s`;
  const table = [
    '| agent | model | layer calls | msg in | msg out | real in | real out | cache | engine calls | time |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---:|',
    ...s.rows.map((r) => `| ${r.key} | ${r.model} | ${r.calls} | ${fmt(r.estIn)} | ${fmt(r.estOut)} | ${r.real ? fmt(r.real.input) : '-'} | ${r.real ? fmt(r.real.output) : '-'} | ${r.real ? fmt(r.real.cache) : '-'} | ${engines(r)} | ${r.seconds}s |`),
  ].join('\n');
  const flow = mermaid(s.events);
  fs.writeFileSync(
    path.join(dir, 'report.md'),
    `# Run report\n\n${head}\n\nThe real tokens come from the service counters. They include the system prompt, the memory, the tools and the internal steps of each agent. "msg in" and "msg out" are estimates of the message text only. "cache" is the tokens that the engine read from or wrote to its prompt cache. "engine calls" is the number of model calls that the agent made inside the service.\n\n## Agents\n\n${table}\n\n## Message flow\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n## Calls\n\n${s.events.map((e) => `- ${new Date(e.t0).toISOString().slice(11, 19)} ${(e.from ?? ['master']).join('+')} → **${e.agent}**${e.via ? ` (via ${e.via})` : ''}: ${e.purpose ?? e.name}, ${e.seconds}s, ${fmt(estimate(e.promptChars))} in / ${fmt(estimate(e.answerChars))} out${e.tools?.length ? `, tools: ${e.tools.map((x) => x.name).join(', ')}` : ''}${e.steps?.length ? `, members: ${e.steps.map((x) => x.name).join(' → ')}` : ''}${e.ok ? '' : ` — FAILED: ${e.error}`} → \`${path.basename(e.file)}\``).join('\n')}\n`,
  );
  const weight = (r) => (r.real ? r.real.input + r.real.output : r.estIn + r.estOut);
  const max = Math.max(1, ...s.rows.map(weight));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synapse run report</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--ink:#16161a;--mute:#6b6b76;--line:#dcdce3;--acc:#5b4bd6;--bad:#c0392b}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e11;--card:#18181d;--ink:#ececf1;--mute:#9a9aa6;--line:#2c2c35;--acc:#8f82ff;--bad:#ff6b5e}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,Segoe UI,sans-serif;padding:20px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px}p{color:var(--mute);margin:4px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px}
.tile,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile b{display:block;font-size:22px}.tile span{color:var(--mute);font-size:12px}
.card{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.meter{height:8px;background:var(--acc);border-radius:4px;min-width:2px}
.node{fill:var(--card);stroke:var(--line)}.node.master{stroke:var(--acc);stroke-width:2}.node.bad,.bar.bad{stroke:var(--bad);fill:var(--bad);fill-opacity:.25}
.edge{fill:none;stroke:var(--acc);stroke-opacity:.55;stroke-width:1.5}.t1{fill:var(--ink);font:600 12px system-ui}.t2{fill:var(--mute);font:11px system-ui}.bar{fill:var(--acc)}
</style>
<h1>Synapse run report</h1><p>${esc(path.basename(dir))}</p>
<div class="tiles">
<div class="tile"><b>${t.calls}</b><span>agent calls${t.failed ? `, ${t.failed} failed` : ''}</span></div>
<div class="tile"><b>${t.real !== null ? fmt(t.real) : 'n/a'}</b><span>real tokens, input + output</span></div>
<div class="tile"><b>${fmt(t.cache)}</b><span>cache tokens</span></div>
<div class="tile"><b>${fmt(t.estIn)} / ${fmt(t.estOut)}</b><span>message tokens in / out (estimate)</span></div>
<div class="tile"><b>${t.wallSeconds}s</b><span>wall time</span></div>
<div class="tile"><b>${t.agentSeconds}s</b><span>total agent time</span></div>
</div>
<h2>Message flow: who sent work to whom</h2><div class="card">${svgGraph(s.events)}</div>
<h2>Tokens for each agent</h2><div class="card"><table><tr><th>Agent</th><th>Model</th><th class="n">Layer calls</th><th class="n">Msg in</th><th class="n">Msg out</th><th class="n">Real in</th><th class="n">Real out</th><th class="n">Cache</th><th>Engine calls</th><th class="n">Time</th><th style="width:22%">Share</th></tr>
${s.rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${esc(r.model)}</td><td class="n">${r.calls}</td><td class="n">${fmt(r.estIn)}</td><td class="n">${fmt(r.estOut)}</td><td class="n">${r.real ? fmt(r.real.input) : '-'}</td><td class="n">${r.real ? fmt(r.real.output) : '-'}</td><td class="n">${r.real ? fmt(r.real.cache) : '-'}</td><td>${esc(engines(r))}</td><td class="n">${r.seconds}s</td><td><div class="meter" style="width:${((weight(r) / max) * 100).toFixed(1)}%"></div></td></tr>`).join('\n')}
</table></div>
<p>The real tokens include the system prompt, the memory, the tools and the internal steps of each agent. The estimates count only the message text.</p>
<h2>Timeline</h2><div class="card">${svgTimeline(s)}</div>
<h2>Calls</h2><div class="card"><table><tr><th>Time</th><th>From</th><th>To</th><th>Purpose</th><th class="n">In</th><th class="n">Out</th><th class="n">Seconds</th><th>Tools and members</th><th>File</th></tr>
${s.events.map((e) => `<tr><td>${new Date(e.t0).toISOString().slice(11, 19)}</td><td>${esc((e.from ?? ['master']).join(' + '))}</td><td>${esc(e.agent)}${e.via ? ` → ${esc(e.via)}` : ''}</td><td>${esc(e.purpose ?? e.name)}</td><td class="n">${fmt(estimate(e.promptChars))}</td><td class="n">${fmt(estimate(e.answerChars))}</td><td class="n">${e.seconds}</td><td>${esc([...(e.tools ?? []).map((x) => x.name), ...(e.steps ?? []).map((x) => `member:${x.name}`)].join(', '))}</td><td><a href="${esc(path.basename(e.file))}">${esc(path.basename(e.file))}</a></td></tr>`).join('\n')}
</table></div></html>`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);
  return { summary: head, table, reportHtml: path.join(dir, 'report.html'), reportMd: path.join(dir, 'report.md') };
}
