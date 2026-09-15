# @google/adk-devtools

The `adk` command line: scaffold an agent, run it in your terminal, inspect
every model call and tool call in a local web UI, and deploy it — for agents
built with [Agent Development Kit (ADK) for
TypeScript](https://github.com/google/adk-js).

[![NPM Version](https://img.shields.io/npm/v/@google/adk-devtools)](https://www.npmjs.com/package/@google/adk-devtools)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/google/adk-js/blob/main/LICENSE)

## Install

Install it into your agent project as a dev dependency, next to the core SDK:

```bash
npm install @google/adk
npm install -D @google/adk-devtools
```

That puts an `adk` executable in your project, so `npx adk …` runs this CLI.

> Install it locally first. On a machine with nothing installed, `npx adk`
> resolves to an unrelated `adk` package on the public registry, not to this
> one.

## Authenticate

The CLI does not manage credentials; the model client reads them from the
environment.

Google AI Studio ([get a key](https://aistudio.google.com/apikey)):

```bash
export GEMINI_API_KEY=...   # GOOGLE_GENAI_API_KEY also works
```

Vertex AI:

```bash
export GOOGLE_GENAI_USE_VERTEXAI=1
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

## Commands

Every command takes `--help`.

### `adk create [name]`

Scaffolds an agent project — an `agent.ts` with a working `LlmAgent` and an
example tool, plus `package.json`, `tsconfig.json`, and `.env`.

```bash
npx adk create my-agent --model gemini-flash-latest
```

| Option              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `--model <model>`   | Model for the root agent.                              |
| `--api_key <key>`   | Google AI Studio API key to write to `.env`.           |
| `--project <id>`    | Google Cloud project, to use Vertex AI as the backend. |
| `--region <region>` | Google Cloud region, to use Vertex AI as the backend.  |
| `--language <lang>` | `ts` or `js`. Defaults to TypeScript.                  |
| `-y, --yes`         | Skip confirmation prompts.                             |

### `adk run <agent>`

Runs an agent in an interactive terminal session. Takes the path to an agent
file (`.ts` or `.js`) that exports `rootAgent`.

```bash
npx adk run agent.ts
```

| Option                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `--save_session`      | Write the session to a JSON file on exit.                       |
| `--session_id <id>`   | Session ID to save under.                                       |
| `--resume <file>`     | Replay a saved session, then keep chatting.                     |
| `--replay <file>`     | Run a JSON file of initial state and queries non-interactively. |
| `--reload_agents`     | Watch the agent file and reload on change.                      |
| `--log_level <level>` | Log level. Defaults to `info`.                                  |

### `adk web [agents_dir]`

Starts the local dev UI on <http://localhost:8000>, where you can chat with an
agent and inspect each event it emits: the model request, tool calls and their
arguments, state changes, and traces. Serves the current directory by default.

```bash
npx adk web
```

<img src="https://raw.githubusercontent.com/google/adk-python/main/assets/adk-web-dev-ui-function-call.png"/>

| Option                         | Description                                 |
| ------------------------------ | ------------------------------------------- |
| `-p, --port <port>`            | Port. Defaults to `8000`.                   |
| `-h, --host <host>`            | Bind host. Defaults to `localhost`.         |
| `--allow_origins <origins>`    | CORS allow-list.                            |
| `--session_service_uri <uri>`  | Session backend, e.g. `memory://`.          |
| `--artifact_service_uri <uri>` | Artifact backend, e.g. `gs://<bucket>`.     |
| `--reload_agents`              | Watch agent files and reload on change.     |
| `--a2a`                        | Also serve the agent over the A2A protocol. |

### `adk api_server [agents_dir]`

The same server as `adk web` with the UI switched off — the HTTP API only,
useful for wiring up a front end of your own or for smoke-testing in CI. Takes
the same options.

### `adk deploy`

```bash
npx adk deploy cloud_run --project my-project --region us-central1 --with_ui
```

- `adk deploy cloud_run [agents_dir]` — containerize the agent and deploy it to
  Cloud Run. `--with_ui` deploys the dev UI alongside the API server.
- `adk deploy agent_engine [agents_dir]` — deploy to Vertex AI Agent Engine.

### `adk integration conformance`

Runs the ADK conformance suite against your agents. Mostly of interest to
contributors.

## Documentation

- **Getting started**: <https://adk.dev/get-started/typescript>
- **Samples**: <https://github.com/google/adk-samples>
- **Core SDK**: [`@google/adk`](https://www.npmjs.com/package/@google/adk)

## License

Apache 2.0 — see
[LICENSE](https://github.com/google/adk-js/blob/main/LICENSE).
