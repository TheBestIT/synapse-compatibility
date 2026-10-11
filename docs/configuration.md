# Configuration

The layer reads two files from the data directory.
The data directory is the repository directory, or the directory in the `SYNAPSE_HOME` environment variable.

| File | Content |
|---|---|
| `.env` | Address of the service and credentials |
| `synapse.config.json` | Your preferences |

Git ignores the two files.

## Credentials: `.env`

| Variable | Content |
|---|---|
| `SYNAPSE_URL` | Address of the service, without a path |
| `SYNAPSE_USER` | Your user name |
| `SYNAPSE_PASSWORD` | Your password |

A variable of the environment replaces the same variable of the file.

## Preferences: `synapse.config.json`

Run `node bin/synapse.mjs config --init` to write the file with all the defaults.
Run `node bin/synapse.mjs config` to see the configuration that applies.

You can keep only the values that you change. The layer uses the defaults for the others.
An object in the file merges with the default object. An array in the file replaces the default array.
`synapse.config.example.json` is a short example.

Start the MCP server again after a change. The server reads the file one time, at its start.

### `effort`

The default effort: `low`, `medium`, `high`, `max`, or a level that you add. The default is `medium`.

### `efforts`

The depth values of each effort level.

| Value | Meaning |
|---|---|
| `askEnsemble` | Number of other models that also answer in `ask` and `fanout` |
| `ensemble` | Number of other models that also do each task of a pipeline |
| `rounds` | Maximum number of review rounds in a pipeline. 0 gives no review. |
| `maxTasks` | Maximum number of tasks in the plan of a pipeline |

Example of a new level:

```json
{ "efforts": { "draft": { "askEnsemble": 0, "ensemble": 0, "rounds": 1, "maxTasks": 4 } } }
```

### `engines`

One entry for each group of models that has its own quota.

| Value | Meaning | Default |
|---|---|---|
| `match` | Regular expression for the model names of the engine | |
| `enabled` | `false` stops all calls to the engine | `true` |
| `parallel` | Maximum number of calls at the same time | 1 to 6 |
| `callsPerRun` | Maximum number of calls in one operation. `null` means no limit. | `null` |
| `blockMinutes` | Time without calls after a quota error | 10 to 360 |
| `web` | `true` when the models have the web search tool | |

The default engines are:

| Engine | `match` | `parallel` | `web` |
|---|---|---:|---|
| `claude` | `^claude-code` | 2 | yes |
| `gpt` | `^chatgpt` | 6 | no |
| `gemini` | `^antigravity` | 1 | no |
| `deep` | `^dev-deep$` | 2 | yes |
| `dev` | `^dev$` | 4 | yes |
| `other` | all other models | 2 | no |

The first engine that matches a model name is the engine of that model.
Add an engine when your service has a model group with its own quota:

```json
{ "engines": { "local": { "match": "^llama", "parallel": 3, "web": false } } }
```

Examples of use:

- A subscription with a small quota: set `"callsPerRun": 4` and `"parallel": 1` for that engine.
- An engine that you do not want to use: set `"enabled": false`.
- A fast service: increase `parallel`.

The `budget` parameter of a tool, or `--budget engine=n` on the CLI, replaces `callsPerRun` for one operation.

### `models`

The model of a role. The key is an agent key from `roster`. The value is a model name from `models`.

```json
{ "models": { "planner": "claude-code/opus", "coder": "chatgpt/gpt-6.1-sol" } }
```

Run `node bin/synapse.mjs provision --sync` after a change. The command sends the models and the prompts to the service.

Three roles (`modpack`, `factory`, `moddev`) get a different prompt sentence when their model has no web tool.
The `web` value of the engine controls this.

### `fallbacks`

The agents that take a role when its first agent fails, in order.
`default` is the route for most roles. `web` is the route for the roles that use the web tool.
The values are agent keys. Put the engine with the smallest quota last.

### `ensemble`

The pool agents that also answer when an operation uses other models, in order of preference.
The layer does not use an agent whose engine is disabled or has a quota block.

### `agentSettings`

Service settings that `provision` sends for each agent.
The layer does not check the names. The service accepts or ignores them.
Names that the service has: `max_steps`, `max_searches`, `max_fetches`, `auto_reflect`, `web_enabled`.
The layer never sends the `published` setting.

### `loopModel`

The model of the learning loops. `null` keeps the model that the service selects.
Use a model without a quota, because a loop runs all the time.

### `defaults`

| Value | Meaning | Default |
|---|---|---:|
| `concurrency` | Maximum number of tasks that an operation starts at the same time | 8 |
| `previewChars` | Number of answer characters that a tool returns | 1200 |
| `timeoutMinutes` | Maximum time for one answer | 30 |
| `maxPromptChars` | A longer prompt goes through the summarizer first | 450000 |
| `councilAgents` | The agents of a council | 6 roles |
| `councilJudge` | The agent that merges the answers of a council | `planner` |

The engine limit `parallel` applies after `concurrency`. A task that has no free slot waits in the queue of its engine.
