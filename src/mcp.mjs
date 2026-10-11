#!/usr/bin/env node
// MCP server on standard input and output.
// The server has no dependencies. It speaks JSON-RPC 2.0 with one message in each line.
import readline from 'node:readline';
import * as client from './client.mjs';
import * as orch from './orchestrator.mjs';
import { config, CONFIG_FILE, HOME } from './config.mjs';
import { SPECIALISTS, SUPERS } from './roster.mjs';

const KEYS = Object.keys(SPECIALISTS).join(', ');
const SUPER_KEYS = Object.keys(SUPERS).join(', ');
const ensembleProp = { type: 'number', description: 'Number of other models that also do each task. The specialist then merges the answers. More models give more quality and use more tokens.' };
const str = (description) => ({ type: 'string', description });
const EFFORTS = Object.keys(config.efforts);
const effortProp = { type: 'string', enum: EFFORTS, description: `Depth of the work: ${EFFORTS.join(', ')}. More effort uses more models for each task and more review rounds. The default is "${config.effort}" (from the configuration of the user). The ensemble, rounds and maxTasks parameters replace the values of the effort.` };
const budgetProp = { type: 'object', additionalProperties: { type: 'number' }, description: 'Maximum number of calls for an engine in this run, for example {"claude": 4}. 0 gives no call. When a budget is used, the next agent of the fallback route takes the role. The default comes from the configuration of the user: do not increase it unless the user asks.' };
const filesProp = { type: 'array', items: { type: 'string' }, description: 'Local file paths. The layer puts their content into the prompt. The content does not go through the caller.' };
const bg = { type: 'boolean', description: 'Return at once and run in the background. Use synapse_status to read the progress.' };
const previewProp = { type: 'number', description: 'Number of answer characters to return. The full answer is always in the file. Default 1200.' };

const TOOLS = {
  synapse_roster: {
    description: 'List the private Synapse specialists of this layer, with their models.',
    properties: {},
    run: () => orch.roster(),
  },
  synapse_ask: {
    description: `Ask one Synapse specialist. The full answer goes to a file and a preview comes back. Specialists: ${KEYS}. Super-Agents (server-side teams of 5): ${SUPER_KEYS}. Plain models: keys that start with "m-" (see synapse_roster). Use "thread" to continue a conversation with context.`,
    properties: { agent: str('Specialist key'), prompt: str('Full instruction'), files: filesProp, thread: str('Conversation name to keep the context between calls'), web: { type: 'boolean' }, effort: effortProp, ensemble: ensembleProp, budget: budgetProp, previewChars: previewProp, background: bg },
    required: ['agent', 'prompt'],
    run: (a) => (a.background ? orch.background(orch.ask, a) : orch.ask(a)),
  },
  synapse_fanout: {
    description: 'Run many independent tasks on many specialists in parallel. Each answer goes to its own file.',
    properties: {
      tasks: { type: 'array', items: { type: 'object', properties: { agent: str('Specialist key'), prompt: str('Full instruction'), name: str('Short file name'), files: filesProp, thread: str('Conversation name'), web: { type: 'boolean' } }, required: ['agent', 'prompt'] } },
      concurrency: { type: 'number' },
      effort: effortProp,
      ensemble: ensembleProp,
      budget: budgetProp,
      label: str('Run label'),
      previewChars: previewProp,
      background: bg,
    },
    required: ['tasks'],
    run: (a) => (a.background ? orch.background(orch.fanout, a) : orch.fanout(a)),
  },
  synapse_council: {
    description: 'Ask the same task to many specialists on different models, then a judge merges the answers into one better answer.',
    properties: { prompt: str('Full task'), files: filesProp, agents: { type: 'array', items: { type: 'string' } }, judge: str('Specialist key of the judge'), budget: budgetProp, label: str('Run label'), previewChars: previewProp, background: bg },
    required: ['prompt'],
    run: (a) => (a.background ? orch.background(orch.council, a) : orch.council(a)),
  },
  synapse_pipeline: {
    description: 'Full coordinated operation for a large goal (project, repository, plan, modpack, render brief). The planner makes tasks, the specialists run them in parallel (each task also goes to other models when ensemble is above 0), one specialist builds the final result, and the critic and the builder repeat review and revision for a maximum of `rounds`. The result includes the token use and the path of the HTML report with the message flow graph. This can take many minutes: prefer background true.',
    properties: { goal: str('The goal with all requirements'), resume: str('Run directory or name of an earlier pipeline to continue from its completed tasks'), files: filesProp, effort: effortProp, maxTasks: { type: 'number', description: 'Maximum number of tasks in the plan. The effort gives the default.' }, concurrency: { type: 'number' }, ensemble: ensembleProp, rounds: { type: 'number', description: 'Maximum number of critic passes with revision. The effort gives the default.' }, review: { type: 'boolean' }, budget: budgetProp, label: str('Run label'), previewChars: previewProp, background: bg },
    required: [],
    run: (a) => (a.background ? orch.background(orch.pipeline, a) : orch.pipeline(a)),
  },
  synapse_digest: {
    description: 'Summarise or query local files that are too large for one context. The summarizer compresses the parts in parallel.',
    properties: { files: filesProp, question: str('Question to answer. Empty gives a summary.'), budget: budgetProp, label: str('Run label'), previewChars: previewProp, background: bg },
    required: ['files'],
    run: (a) => (a.background ? orch.background(orch.digest, a) : orch.digest(a)),
  },
  synapse_engines: {
    description: 'Load and quota state of the model engines: the parallel call limit and the call budget of each engine, the engines that have no quota now, and the roles on each engine. Set clear to true to remove the quota blocks.',
    properties: { clear: { type: 'boolean' } },
    run: (a) => orch.engines(a),
  },
  synapse_config: {
    description: 'Read the preferences of the user for this layer: the default effort, the effort levels, the engine limits and budgets, the model of each role, the fallback routes. Read it before a large task.',
    properties: {},
    run: () => ({ file: CONFIG_FILE, dataDirectory: HOME, ...config }),
  },
  synapse_status: {
    description: 'Read the state of a run. Give the run directory or its name.',
    properties: { run: str('Run directory or name') },
    required: ['run'],
    run: (a) => orch.readStatus(a.run),
  },
  synapse_usage: {
    description: 'Token and coordination report of a run: tokens for each agent (real service counters and message estimates), who sent work to whom, the time of each call, and the path of the HTML report with the flow graph.',
    properties: { run: str('Run directory or name') },
    required: ['run'],
    run: (a) => orch.usage(a.run),
  },
  synapse_train: {
    description: 'Train one specialist: store notes in its memory, let strong models write its playbook and worked examples, and start its 24/7 learning loop on a topic.',
    properties: {
      agent: str('Specialist key'),
      notes: { type: 'array', items: { type: 'object', properties: { path: str('Note path, for example knowledge/project-x.md'), content: str('Markdown content') }, required: ['path', 'content'] } },
      topic: str('Research topic for the learning loop'),
      selfStudy: { type: 'boolean', description: 'Write the playbook and the examples. Default true.' },
      loop: { type: 'boolean', description: 'Start the learning loop. Default true.' },
    },
    required: ['agent'],
    run: (a) => orch.train(a),
  },
  synapse_memory: {
    description: 'Read the memory of a specialist: the note tree, one note, or a search.',
    properties: { agent: str('Specialist key'), path: str('Note path to read'), query: str('Text to search') },
    required: ['agent'],
    run: (a) => (a.path ? client.memoryGet(a.agent, a.path) : a.query ? client.memorySearch(a.agent, a.query) : client.memoryTree(a.agent)),
  },
  synapse_loop: {
    description: 'Control or read the 24/7 learning loop of a specialist.',
    properties: { agent: str('Specialist key'), action: { type: 'string', enum: ['status', 'start', 'pause', 'stop'] } },
    required: ['agent', 'action'],
    run: async (a) => {
      if (a.action !== 'status') await client.loopAction(a.agent, a.action);
      return (await client.loopGet(a.agent)).loop;
    },
  },
};

// Instructions for the model that uses the tools.
const INSTRUCTIONS = `These tools send work to private agents on a Synapse service. Let the agents do the heavy work: each full answer goes to a file and you get a short preview.
- One expert: synapse_ask. Best answer to a hard question: synapse_council. Large goal: synapse_pipeline with background true, then synapse_status. Many independent tasks: synapse_fanout. Large files: synapse_digest with the file paths.
- Use the "files" parameter for file content. Do not paste file content into a prompt.
- The user sets the effort, the engine budgets and the model of each role in the configuration (synapse_config). Use the default effort unless the user asks for a different depth. Do not increase a budget unless the user asks.
- When calls fail or are slow, read synapse_engines.
- After a task, show the user: the result or the path of final.md, the usage line and table, the engineCalls, and the path of report.html.
- Never publish an agent. The layer changes only the agents that it created.`;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle({ id, method, params }) {
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synapse', version: '0.3.0' }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    return {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required ?? [] } })),
    };
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params.name];
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { rpc: -32602 });
    try {
      const result = await tool.run(params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // A message without an id is a notification. It gets no answer.
  if (msg.id === undefined) return;
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (e) {
    send({ id: msg.id, error: { code: e.rpc ?? -32603, message: e.message } });
  }
});
