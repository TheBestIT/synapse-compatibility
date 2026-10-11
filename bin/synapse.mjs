#!/usr/bin/env node
// Command line interface of the Synapse layer.
import fs from 'node:fs';
import * as client from '../src/client.mjs';
import * as orch from '../src/orchestrator.mjs';
import { config, init, CONFIG_FILE, HOME } from '../src/config.mjs';
import { SPECIALISTS } from '../src/roster.mjs';

const HELP = `Usage: node bin/synapse.mjs <command> [options]

  login [--force]                         Log in and keep the session
  models                                  List the models of the service
  roster                                  List the specialists of this layer
  provision [--sync]                      Create the missing private agents (--sync also updates them)
  ask <agent> <prompt>                    Ask one specialist
  council <prompt>                        Ask many specialists, then merge the answers
  pipeline <goal>                         Plan, execute, review and build one result
  pipeline [goal] --resume <run>          Continue a run from its completed tasks
  fanout <tasks.json>                     Run many tasks in parallel: [{agent, prompt, files?, name?}]
  digest <question> --files a,b           Query or summarise large files
  train <agent|all> [--topic t] [--no-loop] [--no-study]
  loop <agent|all> <start|pause|stop|status>
  status <run>                            Show the state of a run and its calls
  engines [--clear]                       Show the load limits, budgets and quota blocks of the engines
  config [--init]                         Show the configuration (--init writes the default file)
  usage <run>                             Show the token report of a run and the path of report.html

Options: --files a,b  --thread name  --web  --agents a,b  --judge a  --label name
         --preview n  --concurrency n  --max-tasks n  --no-review  --stdin  --json
         --ensemble n (other models for each task)  --rounds n (critic passes)
         --effort low|medium|high|max (depth of the work)
         --budget engine=n,engine=n (maximum calls for an engine in the run)
The prompt can come from a file with "@path" or from standard input with --stdin.`;

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (a.startsWith('--no-')) opt[a.slice(5)] = false;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i];
    else opt[a.slice(2)] = true;
  }
  return { pos, opt };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v) => (v === undefined ? undefined : Number(v));
// Read a budget of the form "claude=4,gpt=20".
const budget = (v) => (v ? Object.fromEntries(list(v).map((s) => [s.split('=')[0], Number(s.split('=')[1])])) : undefined);

function text(parts, opt) {
  if (opt.stdin) return fs.readFileSync(0, 'utf8');
  const s = parts.join(' ');
  return s.startsWith('@') ? fs.readFileSync(s.slice(1), 'utf8') : s;
}

function print(result, opt) {
  if (opt.json || typeof result !== 'object') return console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
  const { final, preview, usageTable, ...rest } = result;
  console.log(JSON.stringify(rest, null, 2));
  const body = final?.preview ?? preview;
  if (body) console.log(`\n----- ${final?.file ?? result.file} -----\n${body}`);
  if (usageTable) console.log(`\n${usageTable}`);
}

const allKeys = () => Object.keys(SPECIALISTS).filter((k) => client.registry().agents[k]);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  const common = { files: list(opt.files), label: opt.label, previewChars: num(opt.preview), ensemble: num(opt.ensemble), effort: opt.effort, budget: budget(opt.budget) };
  switch (cmd) {
    case 'login':
      await client.login({ force: !!opt.force });
      return console.log('Login is correct. The session is on disk.');
    case 'models':
      return console.log((await client.listModels()).join('\n'));
    case 'roster':
      return console.table(orch.roster().map(({ description, members, ...r }) => r));
    case 'provision':
      return console.table(await orch.provision({ sync: !!opt.sync }));
    case 'ask':
      return print(await orch.ask({ agent: pos[0], prompt: text(pos.slice(1), opt), thread: opt.thread, web: opt.web, ...common }), opt);
    case 'council':
      return print(await orch.council({ prompt: text(pos, opt), agents: list(opt.agents), judge: opt.judge, ...common }), opt);
    case 'pipeline':
      return print(await orch.pipeline({ goal: pos.length || opt.stdin ? text(pos, opt) : undefined, resume: opt.resume, maxTasks: num(opt['max-tasks']), concurrency: num(opt.concurrency), rounds: num(opt.rounds), review: opt.review !== false, ...common }), opt);
    case 'fanout':
      return print(await orch.fanout({ tasks: JSON.parse(fs.readFileSync(pos[0], 'utf8')), concurrency: num(opt.concurrency), ...common }), opt);
    case 'digest':
      return print(await orch.digest({ question: text(pos, opt), ...common }), opt);
    case 'train': {
      const keys = pos[0] === 'all' ? allKeys() : [pos[0]];
      // Train a small number of specialists at the same time.
      const queue = [...keys];
      await Promise.all(
        Array.from({ length: Math.min(num(opt.concurrency) ?? 4, queue.length) }, async () => {
          while (queue.length) {
            const agent = queue.shift();
            try {
              console.log(JSON.stringify(await orch.train({ agent, topic: opt.topic, selfStudy: opt.study !== false, loop: opt.loop !== false })));
            } catch (e) {
              console.log(JSON.stringify({ agent, error: e.message }));
            }
          }
        }),
      );
      return;
    }
    case 'loop': {
      const keys = pos[0] === 'all' ? allKeys() : [pos[0]];
      for (const agent of keys) {
        if (pos[1] !== 'status') await client.loopAction(agent, pos[1]);
        const { loop } = await client.loopGet(agent);
        console.log(agent.padEnd(12), loop.status.padEnd(8), `cycles=${loop.cycles}`, `concepts=${loop.concepts}`, loop.topic.slice(0, 70));
      }
      return;
    }
    case 'usage': {
      const u = orch.usage(pos[0]);
      return console.log(`${u.summary}\n\n${u.table}\n\nReport: ${u.reportHtml}`);
    }
    case 'config': {
      if (opt.init) {
        const made = init();
        return console.log(made.created ? `The default configuration is in ${made.file}.` : `${made.file} is there already. The command did not change it.`);
      }
      return console.log(JSON.stringify({ file: CONFIG_FILE, dataDirectory: HOME, ...config }, null, 2));
    }
    case 'engines':
      return console.table(orch.engines({ clear: !!opt.clear }));
    case 'status':
      return print(orch.readStatus(pos[0]), { json: true });
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
