# Synapse compatibility layer

This project connects Claude Code to a Synapse agent service.
It is an MCP server and a command line interface (CLI) with no dependencies.

Claude Code is the master. The Synapse agents do the heavy work with their tokens.
Each answer goes to a file. The master reads only a short preview, thus its token use stays low.

## Functions

- A roster of private specialists: reasoning, plans, code, review, research, game factories, modpacks, design, 3D models, notes.
- Operations for many agents: one question, parallel tasks, a council of models, a full pipeline with review.
- Effort levels that set the depth of the work.
- Load control: a parallel call limit and a call budget for each model engine.
- Automatic fallback: a different model takes a role when a model fails or has no quota.
- Large contexts: long messages go in parts, and large files go through a map step and a reduce step.
- A usage report for each run: the tokens of each agent and the message flow between the agents.
- Training of a specialist: memory notes, a playbook, worked examples and a learning loop.

## Requirements

- Node.js 22 or newer.
- An account on a Synapse service that can create agents.
- Claude Code, or a different MCP client.

## Setup

1. Clone the repository.
2. Copy `.env.example` to `.env`. Put the address of the service, your user name and your password in it.
3. Run `node bin/synapse.mjs login`. The layer keeps the session on disk.
4. Run `node bin/synapse.mjs models`. The command lists the models that your account can use.
5. Run `node bin/synapse.mjs config --init`. Then set your preferences in `synapse.config.json`. Refer to [docs/configuration.md](docs/configuration.md).
6. Run `node bin/synapse.mjs provision`. The command creates the private agents on the service.
7. Connect the MCP server to Claude Code. Use one of the two procedures below.

### Connect as an MCP server

Run this command with the full path of the repository:

```
claude mcp add synapse -- node /full/path/synapse-compatibility/src/mcp.mjs
```

### Connect as a Claude Code plugin

```
/plugin marketplace add TheBestIT/synapse-compatibility
/plugin install synapse@synapse-compatibility
```

A plugin update replaces the plugin directory. Thus set the `SYNAPSE_HOME` environment variable to a directory of yours, and put `.env` and `synapse.config.json` there.

## Data directory

The layer keeps all its data in one directory. The default is the repository directory. The `SYNAPSE_HOME` environment variable selects a different one.

| Path | Content |
|---|---|
| `.env` | Address of the service and credentials |
| `synapse.config.json` | Your preferences |
| `.synapse/` | Session, agent registry, conversation threads, quota blocks |
| `runs/` | One directory for each operation |

Git ignores all these paths.

## Agents

Run `node bin/synapse.mjs roster` to see the full list with the models.

| Group | Keys |
|---|---|
| Thinking | `reasoner`, `planner`, `critic`, `ideas`, `scout`, `generalist` |
| Software | `architect`, `coder`, `reviewer`, `debugger`, `tester`, `writer`, `worker`, `extractor`, `summarizer` |
| Research | `researcher`, `docs` |
| Games | `modpack`, `factory`, `moddev` |
| Models and simulations | `simulator` |
| Visual | `designer`, `render`, `modeler3d`, `assets`, `grapher` |
| Notes (Italian and English) | `notes` |
| Super-Agents (teams of 5 on the service) | `super-build`, `super-think`, `super-factory`, `super-create`, `super-mod` |
| Model pool (one plain agent for each model) | keys that start with `m-` |

The role prompts and the default models are in `src/roster.mjs`.
The `models` section of the configuration changes the model of a role.
After a change, run `node bin/synapse.mjs provision --sync`.

Your service can have different models. Run `models` to see them, then set a model for each role that needs one.
An agent on a model that your account cannot use fails. The fallback route then gives its role to a different agent.

## Operations

| MCP tool | CLI command | Function |
|---|---|---|
| `synapse_ask` | `ask <agent> <prompt>` | One specialist answers. A `thread` name keeps the conversation. |
| `synapse_fanout` | `fanout <tasks.json>` | Many tasks run in parallel on many specialists. |
| `synapse_council` | `council <prompt>` | Many models answer the same task. A judge merges the answers. |
| `synapse_pipeline` | `pipeline <goal>` | Plan, parallel execution, synthesis, review and revision. |
| `synapse_digest` | `digest <question> --files a,b` | Query or summarise files that are too large for one context. |
| `synapse_status` | `status <run>` | State of a run and the list of its calls. |
| `synapse_usage` | `usage <run>` | Token report and path of the HTML report. |
| `synapse_engines` | `engines [--clear]` | Limits, budgets and quota blocks of each engine. |
| `synapse_config` | `config [--init]` | The configuration that applies. |
| `synapse_roster` | `roster` | The agents and their models. |
| `synapse_train` | `train <agent\|all>` | Memory notes, playbook, worked examples and learning loop. |
| `synapse_memory` | | Read the memory of a specialist. |
| `synapse_loop` | `loop <agent\|all> <start\|pause\|stop\|status>` | Control the learning loop. |

Examples:

```
node bin/synapse.mjs ask coder "Write a function that parses ISO 8601 durations in TypeScript." --effort high
node bin/synapse.mjs pipeline "Design a REST API for a library system" --effort max --budget claude=0
node bin/synapse.mjs digest "Which errors repeat?" --files server.log
```

Common parameters:

- `files`: the layer puts the file content into the prompt. The content does not go through the master.
- `thread`: a conversation name. The agent keeps its context between calls.
- `background`: the tool returns at once. Use `synapse_status` to follow the run.
- `resume <run>`: a pipeline continues from the plan and the completed tasks of an earlier run.

## Effort

The effort sets the depth of an operation. More effort gives more quality and uses more tokens.

| Effort | Other models for `ask` and `fanout` | Other models for each pipeline task | Review rounds | Maximum tasks |
|---|---:|---:|---:|---:|
| `low` | 0 | 0 | 0 | 6 |
| `medium` | 0 | 1 | 2 | 16 |
| `high` | 1 | 2 | 3 | 20 |
| `max` | 2 | 3 | 4 | 24 |

- The `effort` value in the configuration is the default.
- The `effort` parameter of a tool, or `--effort` on the CLI, sets the effort of one operation.
- The `ensemble`, `rounds` and `maxTasks` parameters replace one value of the effort.
- You can change the levels and add new ones in the `efforts` section of the configuration.

When an operation uses other models, each of them does the task. Then the specialist merges the answers into one answer.

## Engines, budgets and fallback

An engine is a group of models with the same quota, for example all Claude models.
The `engines` section of the configuration has these settings for each engine:

- `enabled`: `false` stops all calls to the engine.
- `parallel`: the maximum number of calls at the same time. The other calls wait in a queue.
- `callsPerRun`: the maximum number of calls in one operation. `null` means no limit.
- `blockMinutes`: the time without calls to the engine after a quota error.
- `web`: `true` when the models of the engine have the web search tool.

The `budget` parameter of a tool, or `--budget engine=n` on the CLI, sets `callsPerRun` for one operation.

When a call fails because of quota, load, a timeout or a missing agent, the next agent of the fallback route takes the role.
That agent gets the role prompt of the first agent. The result shows it in the `via` field.
The layer also uses the route when an engine is disabled, has a quota block or has no budget.
The `fallbacks` section of the configuration gives the routes.

Each result has an `engineCalls` field: the number of calls that the layer made on each engine.

## Large contexts

- The service accepts 100,000 characters in one message. The layer sends a longer message in parts in the same conversation.
- A prompt above `defaults.maxPromptChars` goes through the summarizer first.
- `digest` reads files of any size with a map step and a reduce step.

## Run directory

Each operation writes a directory in `runs/`:

- `NN-<task>-<agent>.md`: the full answer of each call. `*.draft-*.md` files are the drafts of the other models.
- `final.md`: the final result.
- `plan.json`: the plan of a pipeline.
- `events.jsonl`: one line for each call, with the sender, the receiver, the time and the sizes.
- `usage.json`: real tokens for each agent, from the service counters, for the time of the run.
- `report.html` and `report.md`: the message flow graph, the tokens for each agent, the timeline and the call list.

The real tokens include the system prompt, the memory, the tools and the internal steps of an agent.
The counters come from an administrator route of the service. An account without access to it gets the estimates only.
The estimates count the message text. Two runs at the same time share the same counters.

## Training

`train` does three things for a specialist:

1. It stores the notes that you give in the memory of the specialist.
2. Two other specialists write a playbook and worked examples. The layer stores them in the memory.
3. It starts the learning loop on the topic of the specialist. The loop does research and builds a concept graph.

The `loopModel` value in the configuration sets the model of the learning loops.

## Safety rules of the layer

- The layer creates each agent with `published: false`. No code path sets this field to true.
- The layer does not change the publish state of an agent. You control that state on the service.
- The layer changes only the agents that it created. Their list is in `.synapse/registry.json`.
- The layer logs in one time and keeps the session in `.synapse/session.json`.
- A failed login starts a cooldown of 30 minutes. This prevents a rate limit on the account.
- The password stays in `.env` as plain text. Keep that file private.

## Benchmark

`node bench/bench.mjs` gives the same five tasks to each model of the pool and grades the answers with a local program.
The tasks are: reasoning, factory ratios, code, Italian note parsing and long output.
The results go to `bench/results/`. Use them to select the model for each role.

## Files

- `src/config.mjs`: defaults and the configuration file.
- `src/client.mjs`: session, login, API calls, conversations with the event stream.
- `src/orchestrator.mjs`: operations, engine load control, fallback, provisioning and training.
- `src/telemetry.mjs`: events, token counters and reports.
- `src/roster.mjs`: specialists, Super-Agents and model pool.
- `src/mcp.mjs`: MCP server on standard input and output.
- `bin/synapse.mjs`: command line interface.
- `CLAUDE.md`: instructions for Claude Code when it works in this directory.
