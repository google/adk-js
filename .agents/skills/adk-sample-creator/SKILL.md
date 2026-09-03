---
name: adk-sample-creator
description: >-
  Creates a new sample agent in the ADK TypeScript repository — the sample
  directory, its `agent.ts`, its `README.md`, and its row in the category
  `README.md` — following the conventions the samples use. Use when the user
  wants to add a sample or example demonstrating a feature or agent pattern
  (a dynamic orchestrator, fan-out/fan-in, a standalone tool-using agent), asks
  where a new sample belongs under `samples/`, or wants an existing sample's
  header comment or README row brought up to the standard structure. Don't use
  for building a real working agent for the user's own project, or for writing
  usage documentation for a class (use `adk-unit-guide`).
---

# ADK Sample Creator

Creates samples under `samples/`. These are deliberately minimal agents that
each exercise one or two features — distinct from the `adk-samples` repository,
which hosts full end-to-end applications.

Every sample is a consumer of the published package: it imports from
`@google/adk`, never from `core/src/…`, and `samples/tsconfig.json` resets
`paths` so that the type check resolves it through `node_modules` the way a
user's project does. Run `npm run build` before `npm run ts:check:samples`,
because the samples type-check against `core/dist/types/`, so a symbol added to
`core/src/` this session does not exist for them until the build emits it.

## 1. Pick the category directory

Every sample lives at `samples/{category}/…/{sample_name}/agent.ts`. List the
categories and confirm with the user which one the sample belongs in before
creating anything.

```bash
ls samples/
```

Today there is exactly one category, `workflows`, and it nests one level
further into groups that mirror the adk.dev page each sample ports:
`samples/workflows/{group}/{sample_name}/`. A category with no such page to
mirror is flat: `samples/{category}/{sample_name}/`.

Name the sample directory in `snake_case` after the feature it demonstrates:
`fan_out_join`, `custom_run_ids`, `retrieval`.

Do not add an `_agent` suffix, and do not repeat the category as a prefix —
every sample is an agent, and the category is already in the path.

### Adding a new category

A new category is four things, and skipping any of them is the usual mistake:

1.  `samples/{category}/` holding the sample directories, each with its own
    `README.md`.
2.  `samples/{category}/README.md` — the category's own README, which is a
    different document from the per-sample ones and follows
    [the category section of readme-template.md](references/readme-template.md#category-readme).
    Nothing generates it and no other README links it, so a category without
    one is undiscoverable.
3.  A link from the top-level `README.md` or from the guide the samples
    support, so a reader arrives at the new category README from somewhere.
    The per-sample READMEs are reached from that category README's table, not
    linked from outside.
4.  A decision about execution coverage, recorded in the category README.
    `tests/integration/docs_samples/docs_samples_test.ts` resolves
    `SAMPLES_ROOT` to `samples/workflows` specifically, so it neither runs nor
    guards a sample in any other category. A new category gets lint, Prettier,
    the license check, and `ts:check:samples` for free, and gets no
    construction or execution coverage until someone widens that test. Say
    which of the two the category has.

## 2. Write the sample directory

A sample directory holds two files:

| File        | Required | Purpose                                                            |
| ----------- | -------- | ------------------------------------------------------------------ |
| `agent.ts`  | yes      | The agent or workflow. Must `export const rootAgent`.              |
| `README.md` | yes      | What the sample shows, prompts to drive it, and what to read next. |

`samples/{category}/{name}/README.md` follows
[the per-sample section of readme-template.md](references/readme-template.md#per-sample-readme).

This diverges from what is on disk. None of the 26 samples that predate this
skill has a README: each carries a header comment in `agent.ts` and a row in
its category table and nothing else. New samples set the convention rather than
follow it, so there is no neighbouring directory to copy — the template is the
reference. Adding a sample does not oblige you to retrofit the existing 26.

The README and the header comment overlap, and both stay. The header is what a
reader sees having already opened the code, so it keeps carrying the run
command and the behaviour that is easy to get wrong. The README is what a
reader sees when they arrive at the directory from GitHub or from a guide,
before they have opened anything, and it is the only one of the two with room
for the prompts to try, the topology diagram, and the links out to the guides.

### The header

Two block comments, in this order, before the imports. Both are required: the
license header is enforced by `scripts/check_license.sh` in CI, which matches
the four lines exactly.

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parallel tasks: fan out and join paths
 * https://adk.dev/graphs/routes/#parallel-tasks-fan-out-and-join-paths
 *
 * A `JoinNode` is a fan-in barrier: it waits for EVERY predecessor to finish
 * and then hands the next node an object keyed by predecessor node name.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/fan_out_join/agent.ts
 */
```

The second block is a title line, then the adk.dev section the sample ports,
then what the sample demonstrates and the behaviour that is easy to get wrong,
then how to run it. Link an adk.dev URL only when the sample really does port a
section of it. Every link in the repository today is under
`https://adk.dev/graphs/`, because every sample so far is a graph-docs port; a
sample with no page behind it links its unit guide under `docs/guides/` by
relative path instead of inventing a URL.

The last stanza states the cost of running the sample, and readers scan for it,
so keep the existing wording rather than a paraphrase:

- `Run (offline, no API key):` — the sample calls no model.
- `REQUIRES an API key. Set GEMINI_API_KEY, then:` — a node or agent calls a
  live model.
- Anything else the sample needs, such as an optional npm package or a
  directory of documents, is named in the same stanza. A reader who has to
  discover a missing peer dependency from a runtime error has been misled by
  the header.

Follow it with the run command on its own indented line. The command is always
`npm run sample -- <path from the repository root>`, which is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>` and needs `npm run build`
first.

### Code style

Import from `@google/adk`. Relative imports inside a sample carry a `.js`
extension under `nodenext` resolution, but a sample rarely has one.

Set `model: 'gemini-flash-latest'` on every `LlmAgent`. adk-js has no
system-configured default: `LlmAgent.canonicalModel` walks up to the parent
agent and throws `No model found for {name}` when nothing sets one, so an
agent without a model fails at run time rather than inheriting a default. The
floating `-latest` alias is what every model-using sample sets, in all 12 places, and it answers
the concern a pinned `gemini-2.5-flash` would raise, because the alias moves
when the model behind it is retired.

Identifiers are `camelCase` and types are `PascalCase`, while the `name:`
string on an agent, a node, or a workflow is `snake_case` — that string is what
the model sees and what the CLI prints as `[<node_name>]:`.

Then pick one of the two shapes.

### Pattern A — Workflow, for multi-step graphs

Use when the sample needs multiple nodes, routing, or parallel execution.

```ts
import {JoinNode, node, NodeContext, Workflow} from '@google/adk';
```

```ts
const parallelTaskA = node(
  (_ctx: NodeContext, text: string) => text.toUpperCase(),
  {name: 'parallel_task_A'},
);

export const rootAgent = new Workflow({
  name: 'fan_out_workflow',
  edges: [['START', parallelTaskA, new JoinNode({name: 'my_join_node'})]],
});
```

A handler always takes `(ctx, input)` and reads state through `ctx.state`;
nothing is injected by parameter name. `node(fn, options)` is the factory form,
and the explicit `new FunctionNode(name, fn, config)` constructor is also
public — reach for it only when the sample is about that constructor.

### Pattern B — Standalone agent, for single-agent or simple tool use

Use when there is no graph and the agent drives its own loop.

```ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'standalone_assistant',
  model: 'gemini-flash-latest',
  description: 'An assistant that can help with queries.',
  instruction: 'You are a helpful assistant.',
  tools: [someTool],
});
```

`tools` accepts a `ToolUnion`, which is a `BaseTool`, a `BaseToolset`, or a
`BaseNode`, so a tool instance, a toolset, and a node all go in the same array.

## 3. Register the sample

Add a row to the category `README.md`, following
[the category section of readme-template.md](references/readme-template.md#category-readme).
That row is in addition to the sample's own `README.md`, not instead of it: the
row is how a reader browsing the category finds the sample, and the README is
what they get when they follow it.

For a sample under `samples/workflows/`, also add it to
`tests/integration/docs_samples/docs_samples_test.ts` — to `OFFLINE` with the
turns that drive it, or to `MODEL_BACKED` if it calls a live model. That test
asserts the two lists equal the directories on disk, so an unregistered sample
fails `covers every sample on disk` rather than silently gaining no coverage.

## 4. Verify

```bash
npm run build
npm run ts:check:samples
npm run lint
npm run format:check
bash scripts/check_license.sh
```

Then resolve every relative link the new `README.md` adds and confirm the target
exists. Nothing in CI reads a Markdown link, so a wrong number of `../` ships
silently.

For a `samples/workflows/` sample, also run the integration test, which
constructs every sample and runs the offline ones against a stubbed model:

```bash
npx vitest run --project integration tests/integration/docs_samples
```

## Worked examples

Read these before writing a new sample — one static graph, one standalone
agent with a tool.

- `samples/workflows/routes/fan_out_join/agent.ts` — three functions run in
  parallel from `START`, collected by a `JoinNode`, then aggregated. One edge
  row per parallel path.

  ```ts
  edges: [
    ['START', parallelTaskA, myJoinNode],
    ['START', parallelTaskB, myJoinNode],
    [myJoinNode, finalTaskD],
  ],
  ```

- `samples/workflows/data_handling/schemas/agent.ts` — a `FunctionTool` built
  from a Zod schema, given to an `LlmAgent` that a node wraps. Shows the rule
  that trips people up: the schema that validates a node's input belongs on
  the node, because `LlmAgent.inputSchema` is only consulted when the agent
  is exposed as a tool.

  ```ts
  node(flightSearcher, {inputSchema: flightSearchInputSchema}),
  ```

## Dropped from the adk-python skill

- **`__init__.py` and `tests/*.json`.** TypeScript has no package-marker
  file, and no sample directory carries a recorded eval set. The record and
  replay fixtures live with the integration tests under
  `tests/integration/workflows/`, not with the samples.
- **"Read the `adk-style` skill first".** adk-js has no `adk-style` skill;
  `eslint.config.js`, `.prettierrc.js`, and the root `tsconfig.json` are the
  style authority, and CI enforces all three.
