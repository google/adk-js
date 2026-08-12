# Graph workflow samples

Runnable TypeScript ports of the **Python** code snippets in the ADK
[Graph Workflows docs](https://adk.dev/graphs/). One directory per snippet,
grouped by the docs page it comes from, so a sample directory maps 1:1 to a
section anchor on adk.dev.

Each directory exports a `rootAgent` that runs with the ADK CLI. The docs
snippets are fragments — they reference helpers they never define (`condition()`,
`task_A_node`, …) — so each port fills those in with the smallest plausible
implementation and says so in its header comment. Everything else follows the
Python source as closely as the TypeScript API allows; where the two genuinely
differ, the file comments say why.

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
constructed (a `WorkflowAgent` validates its graph in its constructor), and the
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
| `parallel_route` | [Parallel execution routes](https://adk.dev/graphs/dynamic/#parallel-execution-routes)                 | `Promise.all` fan-out (the `asyncio.gather` equivalent)            | —   |
| `human_input`    | [Human input](https://adk.dev/graphs/dynamic/#human-input)                                             | HITL inside an orchestrator; the leaf keeps `rerunOnResume: false` | —   |
| `custom_run_ids` | [Custom execution IDs](https://adk.dev/graphs/dynamic/#custom-execution-ids)                           | `ctx.runNode(..., {runId})` for a reorderable collection           | —   |

## Python → TypeScript differences

The ports are faithful in structure; these are the places where the API itself
differs, all called out again in the affected sample's header comment.

- **No `@node` decorator.** `node(fn, options)` is the factory form; the
  explicit `new FunctionNode(name, fn, config)` constructor is also public.
- **No `Event.message`.** Python's `Event(message=...)` becomes an event with
  `content` — rendered to the user, and NOT passed to the next node.
- **No `Event(state=...)`.** Write through `ctx.state`; the accumulated delta is
  attached to the node's events.
- **No signature-based injection.** Python binds `node_input`/state values to
  named parameters by introspection. TypeScript handlers always take
  `(ctx, input)` and read state explicitly via `ctx.state`.
- **A workflow's input is a `string` only for a text-only turn** — for anything
  else the entry node is handed the raw `Content`. Every entry node here
  declares `nodeInput: string` and calls string methods on it directly, so a
  non-text first turn fails loudly rather than stringifying to
  `"[object Object]"`; take a `Content` (or `unknown`) if you need to accept
  one. Values that genuinely are untyped — `ctx.runNode(...).output`, a
  `ctx.resumeInputs[id]` reply — are coerced explicitly at the point of use.
- **`ctx.runNode()` resolves to a node _result_,** not the output directly — read
  `.output`. It also does not throw when a child interrupts: check
  `.interruptIds` and bail out (see `dynamic/human_input`).
- **A second `output` event overwrites the first, silently.** The Python page
  gives two accounts of emitting `output` more than once from a node — each
  `yield` "adds to a list of data objects on the Event", and two yields carrying
  `Event.output` are "a runtime error". Neither is what happens here: there is
  no list and no error, the last event to set `output` wins, and the successor
  never sees the rest. Emit it once (see `data_handling/node_output`).
- **`LlmAgent.inputSchema` is not the node's input contract.** It is only used
  when the agent is exposed as a tool. Inside a graph, put the validating schema
  on the node: `node(agent, {inputSchema})`.
- **Schemas are Zod objects** (or a genai `Schema`) rather than pydantic models.
- **`{Class.field}` and `<Class.field from source_node>` work verbatim** — the
  Python data-selection syntax is supported (see `data_handling/structured_access`).

## A gotcha worth knowing

Found while smoke-testing these ports, and documented in the sample it affects.

- **Keep every session-state key single-writer.** A node's `ctx.state` writes
  land immediately, but they are also replayed when the runtime commits that
  node's event — and that commit lags the graph by an event or two. So a node
  that re-reads a key an _earlier_ node also wrote can observe the earlier,
  already-superseded value. Move evolving values along the edges as `output`
  instead of read-modify-writing one key from several nodes
  (`data_handling/session_state`).

## See also

The `tests/integration/workflows/*/agent.ts` files are a second, larger set of
workflow examples — TypeScript ports of Python's
[`contributing/samples/workflows`](https://github.com/google/adk-python/tree/main/contributing/samples/workflows),
each paired with a record/replay integration test. They cover surface these
docs snippets do not: retries, parallel workers, auth (API key and OAuth),
node-as-tool, `task` mode, and multi-trigger nodes.
