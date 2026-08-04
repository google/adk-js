# Workflow samples

Runnable TypeScript ports of the Python
[`contributing/samples/workflows`](https://github.com/google/adk-python/tree/main/contributing/samples/workflows)
samples, one per directory. These are **faithful** ports: where the Python
sample uses an `LlmAgent`, the TypeScript port uses a real `LlmAgent` (calling a
live model) with the same node/graph structure — not an offline stand-in.

Each directory exports a `rootAgent` that runs with the ADK CLI. Most wrap a
`Workflow` in a `WorkflowAgent`; `node_as_tool` exports a plain `LlmAgent` that
uses a node and a workflow as tools.

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
`[<node_name>]: <output>` and the final line is the workflow's output.

You can also pipe a single message, or script a multi-turn run with `--replay`
(a JSON file of queries, resolved relative to the working directory):

```bash
echo "hello world" | npm run sample -- samples/workflows/sequence/agent.ts

echo '{"state":{},"queries":["The product broke","approve"]}' > replay.json
npm run sample -- samples/workflows/request_input/agent.ts --replay replay.json
```

## API keys

Samples marked **needs API key** below call a live model. Set `GEMINI_API_KEY`
(a `.env` file in the working directory is loaded automatically) before running
them. The rest are function-based and run offline with no key.

## Human-in-the-loop / auth / confirmation

HITL, auth, and tool-confirmation samples **pause** mid-run (you'll see an
`adk_request_input`, `adk_request_credential`, or `adk_request_confirmation`
request). Simply **type your reply on the next turn** — the plain-text reply is
routed to the pending interrupt, so you can approve/reject, give feedback, supply
an API key, or confirm a tool call interactively.

## Samples

| Sample                   | What it shows                                            | Needs API key |
| ------------------------ | -------------------------------------------------------- | ------------- |
| `sequence`               | Linear chain of two `LlmAgent`s                          | ✅            |
| `route`                  | `LlmAgent` classifier (schema) routes to a branch        | ✅            |
| `fan_out_fan_in`         | Parallel branches joined by a `JoinNode`                 | —             |
| `parallel_worker`        | Map a node across a list with bounded concurrency        | ✅            |
| `dynamic_nodes`          | Imperative `dynamicEntry` driving `ctx.runNode()`        | ✅            |
| `dynamic_fan_out_fan_in` | Concurrent `ctx.runNode()` + aggregate                   | ✅            |
| `loop`                   | Generate → evaluate → route back until it passes         | ✅            |
| `loop_self`              | A node routes back to itself (conditional cycle)         | —             |
| `multi_triggers`         | A non-join node runs once per predecessor trigger        | —             |
| `nested_workflow`        | A `Workflow` used as a node (+ parallel + join)          | ✅            |
| `node_as_tool`           | An `LlmAgent` uses a node + a `Workflow` as tools (HITL) | ✅            |
| `state`                  | Share data across nodes via `ctx.state`                  | —             |
| `node_output`            | Raw value / `Event({output})` / structured LLM output    | ✅            |
| `use_as_output`          | Promote a sub-node result via `useAsOutput`              | ✅            |
| `message`                | Emit a display message distinct from output              | —             |
| `retry`                  | Retry a flaky node per `retryConfig`                     | —             |
| `request_input`          | HITL two-node: draft → review → approve/reject/revise    | ✅            |
| `request_input_rerun`    | HITL single node with `rerunOnResume`                    | ✅            |
| `request_input_advanced` | Structured HITL: auto-approve small / pause for large    | ✅            |
| `auth_api_key`           | Pause to request an API-key credential                   | —             |
| `auth_oauth`             | Pause and request GitHub OAuth credentials               | —             |
| `agent_in_workflow`      | `task`-mode agent + identity check + confirmation tool   | ✅            |

## Feature coverage

These ports exercise the full workflow + agent-integration surface:

- **imperative `dynamicEntry`** (`dynamic_nodes`): a workflow driven by an entry
  function that calls `ctx.runNode()` in a bounded loop, instead of a static
  `edges` graph (the two are mutually exclusive).
- **`task` mode** (`agent_in_workflow`): an `LlmAgent` runs a multi-round loop and
  completes via a `finish_task` tool whose arguments become the node output.
- **node / workflow as a tool** (`node_as_tool`): a `BaseNode`/`Workflow` passed
  in an agent's `tools` is auto-wrapped as a `NodeTool`; a node may even pause for
  input (`RequestInput`) mid-tool-call and resume on the next turn.
- **`require_confirmation`** (`agent_in_workflow`): a `FunctionTool` pauses for
  user approval before it runs.
- **`rerun_on_resume`** semantics: the default two-node HITL pattern
  (`request_input`) vs. the single-node re-run pattern (`request_input_rerun`).

## Notes

`loop` drives a graph-level cycle (route back to `generate_headline` until the
grade passes) with **no iteration cap**, so an off-topic input can loop many
times, each iteration making two live model calls. `dynamic_nodes` bounds its
equivalent loop with `MAX_ATTEMPTS`; `loop` is left uncapped to keep the cyclic
graph the sample is demonstrating.

`auth_oauth` issues a real GitHub OAuth authorization request; completing the
token exchange requires registering an OAuth app and setting `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`, so its resume step needs a live provider. A couple of
samples read state via `ctx.state` where Python injects it as a function
parameter (an intended API difference) — this is noted in those files.
