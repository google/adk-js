# Workflow samples

Runnable TypeScript ports of the Python
[`contributing/samples/workflows`](https://github.com/google/adk-python/tree/main/contributing/samples/workflows)
samples, one per directory. Each exports a `rootAgent` (a `WorkflowAgent`
wrapping a `Workflow`) so it runs with the ADK CLI.

## Running

Build once, then run any sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/workflows/sequence/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

The CLI is interactive: type a message and press Enter to send it to the
workflow; type `exit` to quit. Node events are printed as
`[<node_name>]: <output>` and the final line `[<workflow_name>]: ...` is the
workflow's output.

You can also pipe a single message:

```bash
echo "hello world" | npm run sample -- samples/workflows/sequence/agent.ts
```

## API keys

Most samples are **function-based and run offline** (no key needed). Samples
that call a live model are marked **(needs API key)** below — set
`GEMINI_API_KEY` (a `.env` file in the working directory is loaded
automatically) before running them.

## Human-in-the-loop / auth samples

For HITL and auth samples, the workflow **pauses** on the first turn (you'll see
an `adk_request_input` / `adk_request_credential` request). Simply **type your
reply on the next turn** — the plain-text reply is fed to the pending interrupt,
so you can approve/reject, give feedback, or supply an API key interactively.

To script a multi-turn run non-interactively, use `--replay` with a JSON file of
queries:

```bash
echo '{"state":{},"queries":["The product broke","approve"]}' > replay.json
npm run sample -- samples/workflows/request_input/agent.ts --replay replay.json
```

## Samples

| Sample                   | What it shows                                       | Offline?          |
| ------------------------ | --------------------------------------------------- | ----------------- |
| `sequence`               | Linear chain; each output feeds the next            | ✅                |
| `route`                  | Classify input, route to a branch (+ DEFAULT_ROUTE) | ✅                |
| `fan_out_fan_in`         | Parallel branches joined by a `JoinNode`            | ✅                |
| `parallel_worker`        | Map a node across a list with bounded concurrency   | ✅                |
| `dynamic_nodes`          | Imperative `dynamicEntry` driving `ctx.runNode()`   | ✅                |
| `dynamic_fan_out_fan_in` | Concurrent `ctx.runNode()` + aggregate              | ✅                |
| `loop`                   | Generate → evaluate → route back until it passes    | ✅                |
| `loop_self`              | A node routes back to itself (conditional cycle)    | ✅                |
| `multi_triggers`         | A non-join node runs once per predecessor trigger   | ✅                |
| `nested_workflow`        | A `Workflow` used as a node (+ parallel + join)     | ✅                |
| `node_as_tool`           | A node calls sub-nodes via `ctx.runNode()`          | ✅                |
| `state`                  | Share data across nodes via `ctx.state`             | ✅                |
| `node_output`            | Raw value / `Event({output})` / structured output   | ✅                |
| `use_as_output`          | Promote a sub-node result via `useAsOutput`         | ✅                |
| `message`                | Emit a display message distinct from output         | ✅                |
| `retry`                  | Retry a flaky node per `retryConfig`                | ✅                |
| `request_input`          | HITL: draft → review → approve/reject/revise        | ✅ (interactive)  |
| `request_input_rerun`    | HITL single node with `rerunOnResume`               | ✅ (interactive)  |
| `request_input_advanced` | Auto-approve small / pause for large requests       | ✅ (interactive)  |
| `auth_api_key`           | Pause to request an API-key credential              | ✅ (interactive)  |
| `auth_oauth`             | Pause and emit an OAuth authorization URL           | ✅ (request only) |
| `agent_in_workflow`      | A real `LlmAgent` as a workflow node                | ❗ needs API key  |

### Notes on faithfulness

Some Python samples use `LlmAgent`s for steps like classification or
generation. To keep the ports runnable offline, those steps are implemented with
function nodes here (the workflow _structure_ is identical); swap a function
node for an `LlmAgent` to use a real model, as shown in `agent_in_workflow`.
`auth_oauth` emits a real authorization request, but completing the OAuth token
exchange requires a live provider, so its resume step is illustrative only.
