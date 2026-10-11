// Configuration of the layer.
// The defaults are below. The file synapse.config.json in the data directory changes them.
import fs from 'node:fs';
import path from 'node:path';

// Directory of the program.
export const ROOT = path.resolve(import.meta.dirname, '..');
// Data directory: credentials, session, registry, configuration and runs.
export const HOME = path.resolve(process.env.SYNAPSE_HOME || ROOT);
export const CONFIG_FILE = path.join(HOME, 'synapse.config.json');

export const DEFAULTS = {
  // Default depth of the operations. One of the keys of "efforts".
  effort: 'medium',
  efforts: {
    low: { askEnsemble: 0, ensemble: 0, rounds: 0, maxTasks: 6 },
    medium: { askEnsemble: 0, ensemble: 1, rounds: 2, maxTasks: 16 },
    high: { askEnsemble: 1, ensemble: 2, rounds: 3, maxTasks: 20 },
    max: { askEnsemble: 2, ensemble: 3, rounds: 4, maxTasks: 24 },
  },
  // One entry for each model engine of the service. "match" is a regular expression for the model name.
  // The first entry that matches a model is its engine. The entry with an empty "match" gets all other models.
  engines: {
    claude: { match: '^claude-code', enabled: true, parallel: 2, callsPerRun: null, blockMinutes: 60, web: true },
    gpt: { match: '^chatgpt', enabled: true, parallel: 6, callsPerRun: null, blockMinutes: 10, web: false },
    gemini: { match: '^antigravity', enabled: true, parallel: 1, callsPerRun: null, blockMinutes: 360, web: false },
    deep: { match: '^dev-deep$', enabled: true, parallel: 2, callsPerRun: null, blockMinutes: 10, web: true },
    dev: { match: '^dev$', enabled: true, parallel: 4, callsPerRun: null, blockMinutes: 10, web: true },
    other: { match: '', enabled: true, parallel: 2, callsPerRun: null, blockMinutes: 10, web: false },
  },
  // Model for a role: { "<agent key>": "<model name>" }. An entry replaces the model in src/roster.mjs.
  models: {},
  // Agents that take a role when its first agent fails, in order.
  fallbacks: {
    default: ['m-gpt61-sol', 'm-gpt6-sol', 'm-dev-deep', 'm-sonnet'],
    web: ['m-dev-deep', 'm-dev', 'm-sonnet'],
  },
  // Pool agents for ensembles, in order of preference.
  ensemble: ['m-gpt61-sol', 'm-gpt6-sol', 'm-dev-deep', 'm-gpt56-sol', 'm-gpt6-astra', 'm-gpt56-luna', 'm-dev'],
  // Service settings that "provision" sends for each agent, for example { "max_searches": 8 }.
  agentSettings: {},
  // Model of the learning loops. null keeps the model that the service selects.
  loopModel: null,
  defaults: { concurrency: 8, previewChars: 1200, timeoutMinutes: 30, maxPromptChars: 450000, councilAgents: ['reasoner', 'planner', 'critic', 'researcher', 'debugger', 'ideas'], councilJudge: 'planner' },
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Put the values of the user on top of the defaults. An array replaces the default array.
function merge(base, over) {
  if (!isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

function load() {
  if (!fs.existsSync(CONFIG_FILE)) return DEFAULTS;
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
}

export const config = load();

// Engines with a "match" first, then the engine that gets all other models.
const ordered = Object.entries(config.engines).sort(([, a], [, b]) => (a.match ? 0 : 1) - (b.match ? 0 : 1));

export function engineOf(model = '') {
  return ordered.find(([, e]) => (e.match ? new RegExp(e.match).test(model) : true))?.[0] ?? 'other';
}

export const engine = (name) => config.engines[name] ?? {};
export const hasWeb = (model) => !!engine(engineOf(model)).web;

// Give the depth values for an effort name.
export function effortOf(name) {
  const preset = config.efforts[name ?? config.effort];
  if (!preset) throw new Error(`Unknown effort "${name}". Use one of: ${Object.keys(config.efforts).join(', ')}.`);
  return preset;
}

// Write the default configuration file when the data directory has none.
export function init() {
  if (fs.existsSync(CONFIG_FILE)) return { file: CONFIG_FILE, created: false };
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2));
  return { file: CONFIG_FILE, created: true };
}
