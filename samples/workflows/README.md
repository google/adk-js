# Graph workflow samples

Runnable TypeScript workflows for each section of the ADK
[Graph Workflows docs](https://adk.dev/graphs/). One directory per section,
grouped by the page it belongs to, so a sample directory maps 1:1 to a section
anchor on adk.dev.

Each directory exports a `rootAgent` that runs with the ADK CLI. The code on
the docs pages is written to illustrate one idea at a time, so it leaves
helpers undefined (`condition()`, `task_A_node`, …); each sample fills those in
with the smallest plausible implementation and says so in its header comment,
which also links the section it covers.

## Running

Build once, then run any sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/workflows/routes/sequence/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

CI also executes them, in `tests/integration/docs_samples/`: every sample is
constructed (a `Workflow` validates its graph in its constructor), and the
offline ones are run end-to-end with the model stubbed out, so a stray model
call in one of them fails too. A new sample directory has to be added to that
test's offline or model-backed list, or it fails for being uncovered.

```bash
npx vitest run --project integration tests/integration/docs_samples
```

The CLI is interactive: type a message and press Enter to send it to the
workflow; type `exit` to quit. Node events print as `[<node_name>]: <output>`
and the last line is the workflow's output. A node that emits only `output` (no
display content) prints nothing — that is expected.

Pipe a single message, or script a multi-turn run with `--replay` (a JSON file
of queries, resolved relative to the working directory):

```bash
echo "hello world" | npm run sample -- samples/workflows/routes/sequence/agent.ts

echo '{"state":{},"queries":["start","21"]}' > replay.json
npm run sample -- samples/workflows/human_input/get_started/agent.ts --replay replay.json
```

## API keys

Samples marked **key** below call a live model. Set `GEMINI_API_KEY` (a `.env`
file in the working directory is loaded automatically) before running them. The
rest are function-only and run offline.

## Human input

The HITL samples **pause** mid-run (you will see an `adk_request_input`
request). Just type your reply on the next turn — a plain-text reply is routed
to the pending interrupt, so you can approve, reject, or supply a value
interactively.

Answering from your own client rather than the CLI, over `/run`, there are two
shapes and the difference matters:

```jsonc
// Plain text: routed to every pending interrupt, never schema-checked.
{"role": "user", "parts": [{"text": "21"}]}

// Structured: name the interrupt, and wrap a bare value as {result: <value>}.
{"role": "user", "parts": [{"functionResponse": {
  "id": "<interruptId>", "name": "adk_request_input",
  "response": {"result": "21"}}}]}
```

`{result: …}` is the only envelope that gets unwrapped. Any other object is
handed to the next node exactly as sent — which is what makes a structured
reply carrying an object (`{userResponse: …}` in `payload_and_schema`) work. If
the interrupt declared a `responseSchema`, a reply carrying an _object_ is
checked against it and a mismatch fails loudly — the interrupt stays open, so
your next reply answers it; a bare value inside `{result: …}` counts as plain
text and is not checked; if the interrupt declared none, whatever you send is
what the next node receives.

The schema itself travels on the interrupt as
`functionCall.args.response_schema` (snake_case, matching adk-python), which is
what the dev UI reads to render a form for the reply.

## Samples

### [`/graphs/`](https://adk.dev/graphs/) — `graphs/`

| Sample             | Docs section                                                                       | Shows                                                      | Key |
| ------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | --- |
| `get_started`      | [Get started](https://adk.dev/graphs/#get-started)                                 | Agent → function → agent → function, in sequence           | ✅  |
| `process_pipeline` | [Build processes with graphs](https://adk.dev/graphs/#build-processes-with-graphs) | Classify, then dispatch on a route **array** (multi-route) | ✅  |

### [`/graphs/routes/`](https://adk.dev/graphs/routes/) — `routes/`

| Sample            | Docs section                                                                              | Shows                                                   | Key |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- | --- |
| `function_node`   | [Nodes](https://adk.dev/graphs/routes/#nodes)                                             | The primary node type; bare return vs. explicit `Event` | —   |
| `sequence`        | [Route sequences](https://adk.dev/graphs/routes/#route-sequences)                         | `['START', a, b, c]` — each node once, in order         | —   |
| `branches`        | [Route branches](https://adk.dev/graphs/routes/#route-branches-and-conditional-execution) | A router node plus a route→node dispatch map            | ✅  |
| `fan_out_join`    | [Fan out and join](https://adk.dev/graphs/routes/#parallel-tasks-fan-out-and-join-paths)  | Parallel paths merged by a `JoinNode` barrier           | —   |
| `nested_workflow` | [Nested workflows](https://adk.dev/graphs/routes/#nested-workflows)                       | A `Workflow` used as a node inside another workflow     | —   |
| `loop_escalation` | [Loop and escalation exit](https://adk.dev/graphs/routes/#loop-and-escalation-exit)       | A back-edge cycle with a routed exit                    | —   |

### [`/graphs/data-handling/`](https://adk.dev/graphs/data-handling/) — `data_handling/`

| Sample              | Docs section                                                                                               | Shows                                                         | Key |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --- |
| `node_output`       | [Node output](https://adk.dev/graphs/data-handling/#node-output)                                           | Return a value / an `Event` / yield; last `output` event wins | —   |
| `structured_output` | [Passing structured data](https://adk.dev/graphs/data-handling/#node-output-passing-structured-data)       | A typed object across an edge, validated by schemas           | —   |
| `routing_output`    | [Routing output](https://adk.dev/graphs/data-handling/#routing-output)                                     | `route` and `output` on one event; `DEFAULT_ROUTE`            | —   |
| `user_message`      | [User-facing messages](https://adk.dev/graphs/data-handling/#user-facing-messages)                         | A display message vs. data for the next node                  | —   |
| `session_state`     | [Session state and scopes](https://adk.dev/graphs/data-handling/#session-state-and-state-scopes)           | `ctx.state`, the `app:`/`user:`/`temp:` prefixes              | —   |
| `schemas`           | [Constrain node data with schemas](https://adk.dev/graphs/data-handling/#constrain-node-data-with-schemas) | `inputSchema` / `outputSchema` on an agent node, plus a tool  | ✅  |
| `structured_access` | [Access structured data in agents](https://adk.dev/graphs/data-handling/#access-structured-data-in-agents) | `{Class.field}` and `<Class.field from source_node>`          | ✅  |

### [`/graphs/human-input/`](https://adk.dev/graphs/human-input/) — `human_input/`

| Sample               | Docs section                                                                                                      | Shows                                                | Key |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --- |
| `get_started`        | [Get started](https://adk.dev/graphs/human-input/#get-started)                                                    | The two-node pause: `RequestInput`, reply feeds next | —   |
| `rerun_on_resume`    | [Configuration options](https://adk.dev/graphs/human-input/#configuration-options)                                | `rerunOnResume: true`: one node pauses and re-runs   | —   |
| `payload_and_schema` | [Message and payload](https://adk.dev/graphs/human-input/#request-input-with-a-message-and-payload)               | `message` + `payload` + `responseSchema`             | —   |
| `initial_prompt`     | [Tool-confirmation section](https://adk.dev/graphs/human-input/#tool-confirmation-approval-prompts-in-llm-agents) | A HITL node as the FIRST step of a workflow          | —   |

### [`/graphs/dynamic/`](https://adk.dev/graphs/dynamic/) — `dynamic/`

| Sample           | Docs section                                                                                           | Shows                                                              | Key |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --- |
| `get_started`    | [Get started](https://adk.dev/graphs/dynamic/#get-started)                                             | An orchestrator node driving a child via `ctx.runNode()`           | —   |
| `nodes`          | [Nodes](https://adk.dev/graphs/dynamic/#node) / [Workflows](https://adk.dev/graphs/dynamic/#workflows) | `node()` vs. `new FunctionNode()`                                  | —   |
| `data_handling`  | [Data handling](https://adk.dev/graphs/dynamic/#data-handling)                                         | `editorial_workflow`: agent → function, no state keys              | ✅  |
| `sequence_route` | [Sequence route](https://adk.dev/graphs/dynamic/#sequence-route)                                       | `city_workflow`: sequential `runNode` calls + schemas              | ✅  |
| `loop_route`     | [Loop route](https://adk.dev/graphs/dynamic/#loop-route)                                               | A real `while` loop (generate → lint → fix), bounded               | ✅  |
| `parallel_route` | [Parallel execution routes](https://adk.dev/graphs/dynamic/#parallel-execution-routes)                 | `Promise.all` fan-out over a list of items                         | —   |
| `human_input`    | [Human input](https://adk.dev/graphs/dynamic/#human-input)                                             | HITL inside an orchestrator; the leaf keeps `rerunOnResume: false` | —   |
| `custom_run_ids` | [Custom execution IDs](https://adk.dev/graphs/dynamic/#custom-execution-ids)                           | `ctx.runNode(..., {runId})` for a reorderable collection           | —   |

## Worth knowing

Behaviour that is easy to get wrong, each called out again in the affected
sample's header comment.

- **Two ways to build a node.** `node(fn, options)` is the factory form; the
  explicit `new FunctionNode(name, fn, config)` constructor is also public.
- **A user-facing message is the event's `content`,** which the runtime renders
  and the graph does NOT pass to the next node. Data for the next node goes in
  `output`.
- **State is written through `ctx.state`,** not returned; the accumulated delta
  is attached to the node's events.
- **A handler always takes `(ctx, input)`** and reads state explicitly through
  `ctx.state`. Nothing is injected by parameter name.
- **A workflow's input is a `string` only for a text-only turn** — for anything
  else the entry node is handed the raw `Content`. Every entry node here
  declares `nodeInput: string` and calls string methods on it directly, so a
  non-text first turn fails loudly rather than stringifying to
  `"[object Object]"`; take a `Content` (or `unknown`) if you need to accept
  one. Values that genuinely are untyped — `ctx.runNode(...).output`, a
  `ctx.resumeInputs[id]` reply — are coerced explicitly at the point of use.
- **A paused node does NOT re-run on resume** unless it declares
  `rerunOnResume: true`. Under the default the reply becomes that node's output
  and flows to its successor; with `true` the body runs again and reads the
  reply from `ctx.resumeInputs[interruptId]` (see `human_input/rerun_on_resume`).
- **`ctx.runNode()` resolves to a node _result_,** not the output directly — read
  `.output`. It also does not throw when a child interrupts: check
  `.interruptIds` and bail out (see `dynamic/human_input`).
- **A second `output` event overwrites the first, silently.** A node may emit
  any number of events carrying `output`; nothing throws, the last one wins,
  and the successor never sees the rest. Emit it once
  (see `data_handling/node_output`).
- **`LlmAgent.inputSchema` is not the node's input contract.** It is only used
  when the agent is exposed as a tool. Inside a graph, put the validating schema
  on the node: `node(agent, {inputSchema})`.
- **Schemas are Zod objects,** or a genai `Schema`.
- **`{Class.field}` and `<Class.field from source_node>`** select a field off
  this node's input, or off a named predecessor's output, inside an agent
  instruction (see `data_handling/structured_access`).

## See also

The `tests/integration/workflows/*/agent.ts` files are a second, larger set of
workflow examples, each paired with a record/replay integration test. They
cover surface these docs sections do not: retries, parallel workers, auth (API
key and OAuth), node-as-tool, `task` mode, and multi-trigger nodes.
